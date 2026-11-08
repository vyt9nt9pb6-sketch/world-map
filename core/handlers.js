// 平台無關的 API 處理器：標準 Fetch API（Request → Response）。
// 同一份程式碼可給 Node 本機伺服器、Vercel Functions、Cloudflare Workers 使用。
//
// 安全原則：
//  - 高德 Key 只從 env.AMAP_KEY 讀取，只在伺服器端加入請求，絕不出現在回應或日誌中。
//  - 只轉送到固定的 https://restapi.amap.com 路徑，參數全部經過白名單驗證。

import {
  ValidationError,
  validateSearch,
  validateGeocode,
  validateRoute,
  validateNearby,
  validateRegeo,
  validateEnvironment,
  validateWeather,
  validatePlace,
  ROUTE_STRATEGIES,
  TRANSIT_STRATEGIES,
  NEARBY_TYPES,
} from './validate.js';
import { clientIp } from './ratelimit.js';
import {
  mapSearchResponse,
  mapGeocodeResponse,
  mapRouteResponse,
  mapPathRouteResponse,
  mapTransitResponse,
  mapRegeoResponse,
  mapDrivingV3Response,
  mapPlaceDetail,
  parseLocation,
} from './mapping.js';
import { planCalls, mergeRoutes, decorate, haversine } from './driving.js';
import { HttpError, json, errorResponse } from './http.js';
import { createRailMatcher } from './rail.js';
import railData from './rail-data.js';
import { requestCode, verifyCode, logout, me, assertSameOrigin } from './auth.js';
import { getFavorites, syncFavorites } from './favorites.js';
import { getConfig, amapServiceProxy, createGoogleTileSession } from './config.js';

const AMAP_BASE = 'https://restapi.amap.com';
const UPSTREAM_TIMEOUT_MS = 10000;

const UPSTREAM_PATHS = new Set([
  '/v5/place/around',
  '/v5/place/text',
  '/v5/place/detail',
  '/v3/direction/driving',
  '/v3/geocode/geo',
  '/v3/geocode/regeo',
  '/v5/direction/driving',
  '/v5/direction/walking',
  '/v5/direction/bicycling',
  '/v5/direction/electrobike',
  '/v5/direction/transit/integrated',
]);

export class UpstreamError extends Error {
  constructor(status, code, message, infocode) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.infocode = infocode;
  }
}

/** 高德 infocode → 對使用者友善的錯誤（不洩漏任何內部細節） */
export function mapAmapError(infocode) {
  const c = String(infocode);
  const e = mapAmapErrorInner(c);
  e.infocode = c;
  return e;
}

function mapAmapErrorInner(c) {
  if (['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10010', '10011', '10012', '10013'].includes(c)) {
    return new UpstreamError(502, 'server_config', '伺服器的地圖服務設定有誤，請聯絡管理者');
  }
  if (['10003', '10044', '10045'].includes(c)) return new UpstreamError(429, 'quota', '今天的查詢次數已達上限，請明天再試');
  if (['10004', '10014', '10015', '10016', '10019', '10020', '10021', '10029'].includes(c)) {
    return new UpstreamError(429, 'rate_limited', '查詢太頻繁，請稍後再試');
  }
  if (c.startsWith('200')) return new UpstreamError(400, 'bad_params', '查詢參數有誤');
  if (c.startsWith('208')) return new UpstreamError(422, 'no_route', '無法規劃這條路線，請換個起點或終點');
  return new UpstreamError(502, 'upstream', '地圖服務暫時無法使用，請稍後再試');
}

/** 呼叫高德 REST API。key 只在這裡加入。 */
export async function callAmap(path, query, env, fetchImpl = fetch) {
  if (!UPSTREAM_PATHS.has(path)) throw new Error('upstream path not allowed');
  const key = env?.AMAP_KEY;
  if (!key) throw new UpstreamError(500, 'server_config', '伺服器尚未設定地圖服務金鑰');
  const url = new URL(AMAP_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('key', key);
  let res;
  try {
    res = await fetchImpl(url.toString(), {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    throw new UpstreamError(504, 'upstream_timeout', '地圖服務連線逾時，請稍後再試');
  }
  if (!res.ok) throw new UpstreamError(502, 'upstream', '地圖服務暫時無法使用，請稍後再試');
  let body;
  try {
    body = await res.json();
  } catch {
    throw new UpstreamError(502, 'upstream', '地圖服務回應格式錯誤');
  }
  // v5 只有 infocode；v3 有 status
  if (body.status === '0' || (body.infocode && body.infocode !== '10000')) throw mapAmapError(body.infocode);
  return body;
}

export async function handleSearch(params, env, fetchImpl) {
  const v = validateSearch(params);
  const common = { keywords: v.keywords, page_size: 20, page_num: v.page, show_fields: 'business,photos' };
  // 有地圖中心時：先查中心 50 公里內（依權重排序），找不到再退回城市／全國關鍵字搜尋
  if (v.location) {
    const around = await callAmap(
      '/v5/place/around',
      { ...common, location: v.location, radius: v.radius, sortrule: 'weight' },
      env,
      fetchImpl,
    );
    const mapped = mapSearchResponse(around, 'around');
    if (v.area) return { ...mapped, area: true, radius: v.radius }; // 範圍搜尋：只看這個區域，不退回全國搜尋
    // 附近結果的名稱都不包含完整關鍵字（例如在連雲港搜「南京站」只會找到「…南收費站」），
    // 代表使用者要找的是特定的遠方地點 → 改用全國關鍵字搜尋（依相關度排序）。
    const q = v.keywords.replace(/\s+/g, '');
    const relevant = mapped.results.some((r) => r.name.replace(/\s+/g, '').includes(q));
    if (relevant || v.page > 1) return mapped;
    const textRes = await callAmap('/v5/place/text', { ...common, region: v.city, city_limit: 'false' }, env, fetchImpl);
    const text = mapSearchResponse(textRes, 'text');
    return text.results.length ? text : mapped;
  }
  const textRes = await callAmap('/v5/place/text', { ...common, region: v.city, city_limit: 'false' }, env, fetchImpl);
  return mapSearchResponse(textRes, 'text');
}

export async function handleGeocode(params, env, fetchImpl) {
  const v = validateGeocode(params);
  try {
    const body = await callAmap('/v3/geocode/geo', { address: v.address, city: v.city }, env, fetchImpl);
    return mapGeocodeResponse(body);
  } catch (e) {
    // 30001 = 輸入的不是可解析的地址（例如「加油站」）→ 視為沒有結果，不算錯誤
    if (e instanceof UpstreamError && e.infocode === '30001') return { results: [] };
    throw e;
  }
}

let railMatcher;
function getRailMatcher() {
  return (railMatcher ??= createRailMatcher(railData));
}

/** 起點／終點沒帶城市代碼時，用逆地理編碼查（公交規劃必須有城市） */
async function cityOf(location, env, fetchImpl) {
  const body = await callAmap('/v3/geocode/regeo', { location }, env, fetchImpl);
  const ac = body?.regeocode?.addressComponent;
  const pick = (v) => (Array.isArray(v) ? '' : String(v ?? ''));
  const code = pick(ac?.citycode) || pick(ac?.adcode);
  if (!code) throw new UpstreamError(422, 'no_route', '起點或終點不在可規劃的區域內');
  return code;
}

/** 在每個火車段加上「推測線路」，並組出整條路線的折線 */
export function attachRailLines(route, matcher = getRailMatcher()) {
  const all = [];
  for (const seg of route.segments) {
    if (seg.type === 'train') {
      const stops = seg.stops.filter((s) => s.lng != null);
      const m = matcher.matchRoute(stops, seg.trip);
      seg.lineMatch = m; // { estimated: true, unmatched, sections:[{line,ref,from,to,stopCount,lineStations,path}] }
      seg.polyline = m.sections.flatMap((x) => x.path);
    } else if (seg.type === 'bus' || seg.type === 'subway') {
      if (!seg.polyline.length) seg.polyline = [seg.from, ...seg.viaStops, seg.to].filter((p) => p.lng != null).map((p) => [p.lng, p.lat]);
    }
    all.push(...seg.polyline);
  }
  route.polyline = all;
  return route;
}

/** unix 秒 → 高德公交要的出發日期／時間（中國標準時間 UTC+8） */
export function shanghaiDateTime(sec) {
  const d = new Date((sec + 8 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` };
}

/**
 * 駕車：多條候選路線（v5＋v3 合併）。
 * 出發時間：高德「預測出發時間路況」(/v4/etd/driving) 官方文件標明只開放企業開發者，個人金鑰不能用，
 * 所以駕車一律以「目前即時路況」估時；若使用者設定了出發時間，回傳 depart.supported=false 讓前端老實標示，
 * 並由前端用「出發時間＋行駛時間」顯示預計抵達時刻。
 */
export async function handleDriving(v, env, fetchImpl) {
  const calls = planCalls({ avoidHighway: v.avoidHighway, avoidToll: v.avoidToll, strategy: v.strategy });
  const wp = v.waypoints.length ? v.waypoints.join(';') : undefined;
  const run = ([ver, st]) =>
    ver === 'v5'
      ? callAmap(
          '/v5/direction/driving',
          { origin: v.origin, destination: v.destination, waypoints: wp, strategy: st, origin_id: v.originId, destination_id: v.destinationId, show_fields: 'cost,polyline' },
          env,
          fetchImpl,
        ).then((b) => mapRouteResponse(b, v.strategy))
      : callAmap(
          '/v3/direction/driving',
          { origin: v.origin, destination: v.destination, waypoints: wp, strategy: st, originid: v.originId, destinationid: v.destinationId, extensions: 'all' },
          env,
          fetchImpl,
        ).then((b) => mapDrivingV3Response(b));
  const settled = await Promise.allSettled(calls.map(run));
  const ok = settled.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) throw settled[0].reason;
  // 保持呼叫順序（第一組＝推薦）
  const groups = settled.map((x) => (x.status === 'fulfilled' ? x.value : { routes: [] }));
  const merged = mergeRoutes(groups, { avoidToll: v.avoidToll });
  if (!merged.length) throw new UpstreamError(422, 'no_route', '無法規劃這條路線，請換個起點或終點');
  const o = parseLocation(v.origin);
  const d = parseLocation(v.destination);
  const straight = o && d ? haversine(o, d) : 0;
  const out = {
    mode: 'driving',
    strategy: v.strategy,
    taxiCost: ok.find((g) => g.taxiCost != null)?.taxiCost ?? null,
    straightDistance: straight,
    options: { avoidHighway: v.avoidHighway, avoidToll: v.avoidToll },
    routes: decorate(merged, straight),
  };
  if (merged.tollNote) out.tollNote = merged.tollNote;
  if (v.depart) out.depart = { at: v.depart, mode: 'live', supported: false };
  return out;
}

export async function handlePlace(params, env, fetchImpl) {
  const v = validatePlace(params);
  const body = await callAmap('/v5/place/detail', { id: v.id, show_fields: 'business,photos' }, env, fetchImpl);
  const place = mapPlaceDetail(body);
  if (!place) throw new UpstreamError(404, 'not_found', '找不到這個地點的詳細資料');
  return { place };
}

export async function handleRoute(params, env, fetchImpl) {
  const v = validateRoute(params);
  if (v.mode === 'driving') return handleDriving(v, env, fetchImpl);
  if (v.mode === 'transit') {
    const [city1, city2] = await Promise.all([
      v.city1 ?? cityOf(v.origin, env, fetchImpl),
      v.city2 ?? cityOf(v.destination, env, fetchImpl),
    ]);
    const query = (strategy) => ({
      origin: v.origin,
      destination: v.destination,
      city1,
      city2,
      strategy,
      AlternativeRoute: 4,
      extensions: 'all',
      show_fields: 'cost,polyline',
      ...(v.depart ? shanghaiDateTime(v.depart) : {}),
    });
    if (v.strategy === 'rail_first') return railFirstTransit(query, env, fetchImpl);
    const body = await callAmap('/v5/direction/transit/integrated', query(TRANSIT_STRATEGIES[v.strategy]), env, fetchImpl);
    const out = mapTransitResponse(body);
    out.routes.forEach((r) => attachRailLines(r));
    if (v.depart) out.depart = { at: v.depart, mode: 'transit', supported: true };
    return out;
  }
  // walking / bicycling / electrobike
  const body = await callAmap(
    `/v5/direction/${v.mode}`,
    { origin: v.origin, destination: v.destination, alternative_route: v.mode === 'walking' ? undefined : 1, show_fields: 'cost,polyline' },
    env,
    fetchImpl,
  );
  return mapPathRouteResponse(body, v.mode);
}

// ───────────── 鐵路優先 ─────────────
// 高德 v5 公交策略 0–8 沒有「鐵路／火車優先」（7 只是「地鐵優先」）。
// 作法：用「推薦／時間短／最少換乘」三種策略各查一次，合併去重，
// 含火車段的方案排前面（火車佔行程距離比例高者優先，再比總時間）。找不到含火車的方案時照實回報。
const RAIL_FIRST_STRATEGIES = ['0', '8', '2'];

export const trainDistance = (r) => r.segments.filter((s) => s.type === 'train').reduce((n, s) => n + (s.distance || 0), 0);

function routeSignature(r) {
  return r.segments.map((s) => (s.type === 'walk' ? 'w' : `${s.type}:${s.trip || s.name}:${s.from?.name || ''}>${s.to?.name || ''}`)).join('|');
}

export function rankRailFirst(routes) {
  const seen = new Set();
  const unique = [];
  for (const r of routes) {
    const sig = routeSignature(r);
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(r);
  }
  const share = (r) => (r.distance ? trainDistance(r) / r.distance : 0);
  unique.sort((a, b) => {
    const ta = trainDistance(a) > 0;
    const tb = trainDistance(b) > 0;
    if (ta !== tb) return ta ? -1 : 1;
    if (ta && Math.abs(share(a) - share(b)) > 0.05) return share(b) - share(a);
    return (a.duration ?? 1e9) - (b.duration ?? 1e9);
  });
  return unique.map((r, i) => ({ ...r, index: i }));
}

async function railFirstTransit(query, env, fetchImpl) {
  const settled = await Promise.allSettled(
    RAIL_FIRST_STRATEGIES.map((st) => callAmap('/v5/direction/transit/integrated', query(st), env, fetchImpl)),
  );
  const ok = settled.filter((x) => x.status === 'fulfilled');
  if (!ok.length) throw settled[0].reason;
  const all = ok.flatMap((x) => mapTransitResponse(x.value).routes);
  const ranked = rankRailFirst(all).slice(0, 8);
  ranked.forEach((r) => attachRailLines(r));
  return { mode: 'transit', railFirst: true, hasTrain: ranked.some((r) => trainDistance(r) > 0), routes: ranked };
}

// ───────────── 點選地圖：逆地理編碼＋附近 POI ─────────────
export async function handleRegeo(params, env, fetchImpl) {
  const v = validateRegeo(params);
  const body = await callAmap('/v3/geocode/regeo', { location: v.location, radius: Math.max(v.radius, 50), extensions: 'all', roadlevel: 0 }, env, fetchImpl);
  const [lng, lat] = v.location.split(',').map(Number);
  return mapRegeoResponse(body, { lng, lat }, v.radius);
}

// ───────────── 海拔／氣壓（估計值）─────────────
// 來源：Open-Meteo 免費 API（非商用、CC BY 4.0；氣壓為氣象模型的地面氣壓，海拔為 Copernicus GLO-90 90 m DEM）。
// 由 Worker／伺服器代為呼叫：瀏覽器不直接連 api.open-meteo.com（中國大陸可能連不到，也讓 CSP 維持 connect-src 'self'）。
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

export async function handleEnvironment(ctx) {
  const v = validateEnvironment(ctx.params);
  const url = new URL(OPEN_METEO);
  url.searchParams.set('latitude', String(v.lat));
  url.searchParams.set('longitude', String(v.lng));
  url.searchParams.set('current', 'surface_pressure,pressure_msl,temperature_2m');
  url.searchParams.set('timezone', 'GMT');
  let res;
  try {
    res = await (ctx.fetchImpl ?? fetch)(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new UpstreamError(504, 'upstream_timeout', '氣象資料連線逾時，請稍後再試');
  }
  if (!res.ok) throw new UpstreamError(res.status === 429 ? 429 : 502, 'upstream', '氣象資料暫時無法使用，請稍後再試');
  let b;
  try {
    b = await res.json();
  } catch {
    throw new UpstreamError(502, 'upstream', '氣象資料回應格式錯誤');
  }
  const cur = b?.current || {};
  const n = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const out = {
    estimate: true,
    elevation: n(b?.elevation) == null ? null : { value: b.elevation, unit: 'm', source: 'api', label: '地形高程（Copernicus GLO-90，約 90 m 解析度）' },
    pressure:
      n(cur.surface_pressure) == null
        ? null
        : {
            surface: cur.surface_pressure,
            seaLevel: n(cur.pressure_msl),
            unit: 'hPa',
            time: typeof cur.time === 'string' ? `${cur.time}:00Z` : null,
            source: 'api',
            label: '氣象模型估計的地面氣壓（Open-Meteo）',
          },
    temperature: n(cur.temperature_2m),
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  };
  return json(out, 200, { 'cache-control': 'public, max-age=300' });
}

// ───────────── 天氣（Open-Meteo，CC BY 4.0）─────────────
// 與海拔／氣壓同一個提供者。由 Worker／伺服器代為呼叫，瀏覽器不直接連 api.open-meteo.com
// （中國大陸可能連不到，也讓 CSP 維持 connect-src 'self'）。
// current＋每日 7 天＋每小時 48 小時（給「抵達時天氣」用，只取數值精簡回傳）。
const OPEN_METEO_FORECAST = 'https://api.open-meteo.com/v1/forecast';

/** Open-Meteo 回應 → 精簡 JSON（去掉 API 用的完整欄位與單位物件，數值一律檢查有限數） */
export function mapWeatherResponse(b) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const str = (x) => (typeof x === 'string' && x ? x : null);
  const cur = b?.current;
  const daily = Array.isArray(b?.daily?.time) ? b.daily.time : [];
  const hourly = Array.isArray(b?.hourly?.time) ? b.hourly.time : [];
  const pick = (obj, key, i) => num(obj?.[key]?.[i]);
  return {
    attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
    timezone: str(b?.timezone),
    updatedAt: str(b?.current?.time),
    current: cur
      ? {
          time: str(cur.time),
          temperature: num(cur.temperature_2m),
          apparent: num(cur.apparent_temperature),
          humidity: num(cur.relative_humidity_2m),
          precipitation: num(cur.precipitation),
          code: num(cur.weather_code),
          wind: num(cur.wind_speed_10m),
        }
      : null,
    daily: daily.slice(0, 7).map((date, i) => ({
      date,
      code: pick(b.daily, 'weather_code', i),
      tMax: pick(b.daily, 'temperature_2m_max', i),
      tMin: pick(b.daily, 'temperature_2m_min', i),
      precipProb: pick(b.daily, 'precipitation_probability_max', i),
      precipSum: pick(b.daily, 'precipitation_sum', i),
    })),
    hourly: hourly.slice(0, 48).map((time, i) => ({
      time,
      temperature: pick(b.hourly, 'temperature_2m', i),
      code: pick(b.hourly, 'weather_code', i),
      precipProb: pick(b.hourly, 'precipitation_probability', i),
    })),
  };
}

export async function handleWeather(ctx) {
  const v = validateWeather(ctx.params);
  const url = new URL(OPEN_METEO_FORECAST);
  url.searchParams.set('latitude', String(v.lat));
  url.searchParams.set('longitude', String(v.lng));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum');
  url.searchParams.set('hourly', 'temperature_2m,weather_code,precipitation_probability');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('forecast_days', '7');
  url.searchParams.set('forecast_hours', '48');
  let res;
  try {
    res = await (ctx.fetchImpl ?? fetch)(url.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    throw new UpstreamError(504, 'upstream_timeout', '氣象資料連線逾時，請稍後再試');
  }
  if (!res.ok) throw new UpstreamError(res.status === 429 ? 429 : 502, 'upstream', '氣象資料暫時無法使用，請稍後再試');
  let b;
  try {
    b = await res.json();
  } catch {
    throw new UpstreamError(502, 'upstream', '氣象資料回應格式錯誤');
  }
  const out = mapWeatherResponse(b);
  if (!out.current && !out.daily.length) throw new UpstreamError(502, 'upstream', '氣象資料回應格式錯誤');
  // 位置已四捨五入到 0.01°（約 1 公里），天氣 10 分鐘內不變，可公開快取
  return json(out, 200, { 'cache-control': 'public, max-age=600' });
}

// ───────────── 大眾運輸圖層：鐵路線資料（OSM, ODbL）─────────────
export async function handleRailLines() {
  return json({ attribution: railData.attribution, lines: railData.lines.map((l) => ({ id: l.id, ref: l.ref, name: l.name, from: l.from, to: l.to, stations: l.stations })) }, 200, {
    'cache-control': 'public, max-age=86400',
  });
}

export async function handleNearby(params, env, fetchImpl) {
  const v = validateNearby(params);
  const body = await callAmap(
    '/v5/place/around',
    { location: v.location, types: NEARBY_TYPES[v.kind], radius: v.radius, page_size: v.limit, sortrule: 'distance', show_fields: 'business' },
    env,
    fetchImpl,
  );
  const out = mapSearchResponse(body, 'around');
  return { kind: v.kind, radius: v.radius, ...out, results: out.results.map((r) => ({ ...r, nearbyKind: v.kind })) };
}

// ───────────────────────────── 路由表 ─────────────────────────────
// data：回傳資料物件，由此處包成 JSON（可快取）；raw：自行回傳 Response；mutating：需通過同源檢查。
const data = (fn) => ({ fn: (ctx) => fn(ctx.params, ctx.env, ctx.fetchImpl), kind: 'data' });
const raw = (fn, mutating = false) => ({ fn, kind: 'raw', mutating });

const ROUTES = {
  '/api/search': { GET: data(handleSearch) },
  '/api/geocode': { GET: data(handleGeocode) },
  '/api/route': { GET: data(handleRoute) },
  '/api/nearby': { GET: data(handleNearby) },
  '/api/place': { GET: data(handlePlace) },
  '/api/regeo': { GET: data(handleRegeo) },
  '/api/environment': { GET: raw(handleEnvironment) },
  '/api/weather': { GET: raw(handleWeather) },
  '/api/rail-lines': { GET: raw(handleRailLines) },
  '/api/config': { GET: raw(getConfig) },
  '/api/google-tiles/session': { POST: raw(createGoogleTileSession, true) },
  '/api/auth/request-code': { POST: raw(requestCode, true) },
  '/api/auth/verify': { POST: raw(verifyCode, true) },
  '/api/auth/logout': { POST: raw(logout, true) },
  '/api/auth/me': { GET: raw(me) },
  '/api/favorites': { GET: raw(getFavorites) },
  '/api/favorites/sync': { POST: raw(syncFavorites, true) },
};

function originAllowed(request, env) {
  const list = (env?.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return true; // 未設定時不檢查（本機開發）
  const origin = request.headers.get('origin');
  if (!origin) {
    // 同源 GET 通常不帶 Origin；用 Referer 檢查
    const ref = request.headers.get('referer');
    if (!ref) return false;
    try {
      return list.includes(new URL(ref).origin);
    } catch {
      return false;
    }
  }
  return list.includes(origin);
}

/**
 * 主入口：處理 /api/* 與 /_AMapService/* 請求。其他路徑回傳 null（交給靜態檔案處理）。
 * @param {Request} request
 * @param {object} env  AMAP_KEY, ALLOWED_ORIGINS, WM_KV, MAIL_*, TIANDITU_TK, AMAP_JS_KEY, AMAP_JS_SECURITY_CODE …
 * @param {{fetchImpl?: typeof fetch, rateLimiter?: {take(key:string):{ok:boolean,retryAfter:number}}, remoteAddress?: string}} [opts]
 */
export async function handleApiRequest(request, env, opts = {}) {
  const url = new URL(request.url);
  const isProxy = url.pathname.startsWith('/_AMapService/');
  if (!isProxy && !url.pathname.startsWith('/api/')) return null;
  const path = url.pathname.replace(/\/+$/, '');
  let route;
  if (isProxy) {
    route = raw(amapServiceProxy);
  } else {
    const methods = ROUTES[path];
    if (!methods) return errorResponse(404, 'not_found', '找不到此 API');
    route = methods[request.method];
    if (!route) {
      const res = errorResponse(405, 'method_not_allowed', `只支援 ${Object.keys(methods).join('、')}`);
      res.headers.set('allow', Object.keys(methods).join(', '));
      return res;
    }
  }
  if (!originAllowed(request, env)) return errorResponse(403, 'forbidden_origin', '不允許的來源');
  if (opts.rateLimiter) {
    const r = opts.rateLimiter.take(clientIp(request, opts.remoteAddress));
    if (!r.ok) {
      const res = errorResponse(429, 'rate_limited', '查詢太頻繁，請稍後再試');
      res.headers.set('retry-after', String(r.retryAfter));
      return res;
    }
  }
  try {
    if (route.mutating) assertSameOrigin(request, env);
    const ctx = { request, url, params: url.searchParams, env, fetchImpl: opts.fetchImpl ?? fetch, remoteAddress: opts.remoteAddress };
    const out = await route.fn(ctx);
    return route.kind === 'data' ? json(out) : out;
  } catch (err) {
    if (err instanceof ValidationError) return errorResponse(400, 'invalid_param', err.message, err.field);
    if (err instanceof HttpError) {
      const res = errorResponse(err.status, err.code, err.message);
      if (err.extra?.retryAfter) res.headers.set('retry-after', String(err.extra.retryAfter));
      return res;
    }
    if (err instanceof UpstreamError) return errorResponse(err.status, err.code, err.message, undefined, /^\d{5}$/.test(err.infocode ?? '') ? err.infocode : undefined);
    // 未預期的錯誤：只記錄錯誤類型，不記錄 URL（URL 內含 key）
    console.error('[api] unexpected error:', err?.name || 'Error');
    return errorResponse(500, 'internal', '伺服器發生錯誤');
  }
}
