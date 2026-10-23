// 平台無關的 API 處理器：標準 Fetch API（Request → Response）。
// 同一份程式碼可給 Node 本機伺服器、Vercel Functions、Cloudflare Workers 使用。
//
// 安全原則：
//  - 高德 Key 只從 env.AMAP_KEY 讀取，只在伺服器端加入請求，絕不出現在回應或日誌中。
//  - 只轉送到固定的 https://restapi.amap.com 路徑，參數全部經過白名單驗證。

import { ValidationError, validateSearch, validateGeocode, validateRoute, ROUTE_STRATEGIES } from './validate.js';
import { clientIp } from './ratelimit.js';
import { mapSearchResponse, mapGeocodeResponse, mapRouteResponse } from './mapping.js';

const AMAP_BASE = 'https://restapi.amap.com';
const UPSTREAM_TIMEOUT_MS = 10000;

const UPSTREAM_PATHS = new Set(['/v5/place/around', '/v5/place/text', '/v3/geocode/geo', '/v5/direction/driving']);

export class UpstreamError extends Error {
  constructor(status, code, message, infocode) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.code = code;
    this.infocode = infocode;
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'private, max-age=60' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function errorResponse(status, code, message, field) {
  return json({ error: { code, message, ...(field ? { field } : {}) } }, status);
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
  const common = { keywords: v.keywords, page_size: 20, page_num: v.page, show_fields: 'business' };
  // 有地圖中心時：先查中心 50 公里內（依權重排序），找不到再退回城市／全國關鍵字搜尋
  if (v.location) {
    const around = await callAmap(
      '/v5/place/around',
      { ...common, location: v.location, radius: 50000, sortrule: 'weight' },
      env,
      fetchImpl,
    );
    const mapped = mapSearchResponse(around, 'around');
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

export async function handleRoute(params, env, fetchImpl) {
  const v = validateRoute(params);
  const body = await callAmap(
    '/v5/direction/driving',
    {
      origin: v.origin,
      destination: v.destination,
      waypoints: v.waypoints.length ? v.waypoints.join(';') : undefined,
      strategy: ROUTE_STRATEGIES[v.strategy],
      origin_id: v.originId,
      destination_id: v.destinationId,
      show_fields: 'cost,polyline',
    },
    env,
    fetchImpl,
  );
  return mapRouteResponse(body, v.strategy);
}

const ROUTES = {
  '/api/search': handleSearch,
  '/api/geocode': handleGeocode,
  '/api/route': handleRoute,
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
 * 主入口：處理 /api/* 請求。非 /api 路徑回傳 null（交給靜態檔案處理）。
 * @param {Request} request
 * @param {{AMAP_KEY?: string, ALLOWED_ORIGINS?: string}} env
 * @param {{fetchImpl?: typeof fetch, rateLimiter?: {take(key:string):{ok:boolean,retryAfter:number}}, remoteAddress?: string}} [opts]
 */
export async function handleApiRequest(request, env, opts = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  const handler = ROUTES[url.pathname.replace(/\/+$/, '')];
  if (!handler) return errorResponse(404, 'not_found', '找不到此 API');
  if (request.method !== 'GET') return errorResponse(405, 'method_not_allowed', '只支援 GET');
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
    const data = await handler(url.searchParams, env, opts.fetchImpl ?? fetch);
    return json(data);
  } catch (err) {
    if (err instanceof ValidationError) return errorResponse(400, 'invalid_param', err.message, err.field);
    if (err instanceof UpstreamError) return errorResponse(err.status, err.code, err.message);
    // 未預期的錯誤：只記錄錯誤類型，不記錄 URL（URL 內含 key）
    console.error('[api] unexpected error:', err?.name || 'Error');
    return errorResponse(500, 'internal', '伺服器發生錯誤');
  }
}
