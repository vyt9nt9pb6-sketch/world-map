// 公開設定與 Amap JS API 2.0 的 _AMapService 代理（讓安全密鑰 jscode 留在伺服器端）。
// 全部是「有設定才啟用」：沒有 key 就回報 disabled，前端優雅地隱藏對應功能。

import { HttpError, jsonNoStore } from './http.js';
import { createMailer } from './mail.js';

/**
 * 前端可見設定。注意：天地圖 tk、高德 JS API key、Mapbox token、Google Map Tiles key
 * 都是「瀏覽器型」金鑰，必然會出現在前端；安全靠服務商後台的網域白名單／HTTP referrer。
 * 絕不回傳：AMAP_KEY（Web 服務 key）、AMAP_JS_SECURITY_CODE、郵件 API key。
 */
export async function getConfig(ctx) {
  const env = ctx.env || {};
  const tk = (env.TIANDITU_TK || '').trim();
  const jsKey = (env.AMAP_JS_KEY || '').trim();
  const hasSecurity = !!(env.AMAP_JS_SECURITY_CODE || '').trim();
  const mapbox = (env.MAPBOX_TOKEN || '').trim();
  const google = (env.GOOGLE_MAPS_TILE_KEY || '').trim();
  return jsonNoStore({
    features: {
      auth: !!createMailer(env, ctx.fetchImpl),
      tianditu: !!tk,
      amap3d: !!jsKey && hasSecurity,
      mapbox: !!mapbox,
      googleTiles: !!google,
      terrain: !!tk, // 天地圖 ter_w／cta_w，共用 TIANDITU_TK
    },
    tianditu: tk ? { tk } : null,
    amap3d: jsKey && hasSecurity ? { key: jsKey, serviceHost: '/_AMapService' } : null,
    mapbox: mapbox ? { token: mapbox } : null,
    googleTiles: google ? { key: google } : null,
  });
}

const ALLOWED_PREFIX = /^\/(v3|v4|v5)\//;

/**
 * GET /_AMapService/<path>?…  →  https://restapi.amap.com/<path>?…&jscode=<安全密鑰>
 * 只轉送帶有我們的 JS key 的請求；不使用也不暴露 Web 服務 key。
 */
export async function amapServiceProxy(ctx) {
  const { request, env, fetchImpl } = ctx;
  const code = (env?.AMAP_JS_SECURITY_CODE || '').trim();
  const jsKey = (env?.AMAP_JS_KEY || '').trim();
  if (!code || !jsKey) throw new HttpError(404, 'not_enabled', '3D 地圖尚未啟用');
  if (request.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '只支援 GET');
  const url = new URL(request.url);
  const sub = url.pathname.replace(/^\/_AMapService/, '');
  if (!ALLOWED_PREFIX.test(sub) || sub.includes('..')) throw new HttpError(404, 'not_found', '找不到此服務');
  const cb = url.searchParams.get('callback');
  if (cb !== null && !/^[A-Za-z0-9_.$]{1,80}$/.test(cb)) throw new HttpError(400, 'bad_callback', 'callback 格式不正確');
  if (url.searchParams.get('key') !== jsKey) throw new HttpError(403, 'forbidden', '金鑰不符');
  const isStyle = sub.startsWith('/v4/map/styles');
  const up = new URL((isStyle ? 'https://webapi.amap.com' : 'https://restapi.amap.com') + sub);
  for (const [k, v] of url.searchParams) if (k !== 'jscode') up.searchParams.set(k, v);
  up.searchParams.set('jscode', code);
  let res;
  try {
    res = await (fetchImpl ?? fetch)(up.toString(), { headers: { accept: '*/*', referer: url.origin + '/' }, signal: AbortSignal.timeout(10000) });
  } catch {
    throw new HttpError(504, 'upstream_timeout', '地圖服務連線逾時');
  }
  return new Response(res.body, {
    status: res.status,
    headers: {
      // 高德 JS API 會用 <script> 以 JSONP（callback=…）呼叫 log/init 等端點；上游標成 application/json，
      // 但我們有 nosniff，所以 JSONP 回應要明確標成 JavaScript，否則瀏覽器拒絕執行。
      'content-type': cb !== null ? 'text/javascript; charset=utf-8' : res.headers.get('content-type') || 'application/json; charset=utf-8',
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * POST /api/google-tiles/session
 * 用伺服器端 GOOGLE_MAPS_TILE_KEY 向 Google Map Tiles API 建立 satellite session。
 * 圖磚仍由瀏覽器直連 tile.googleapis.com（client-side URL）；createSession 走同源避免 CORS。
 */
export async function createGoogleTileSession(ctx) {
  const { env, fetchImpl } = ctx;
  const key = (env?.GOOGLE_MAPS_TILE_KEY || '').trim();
  if (!key) throw new HttpError(404, 'not_enabled', 'Google 衛星圖層尚未啟用');
  // 圖磚類型：satellite（預設）或 terrain（地形＋道路地名）。Google 規定 terrain 必須同時要求 layerRoadmap。
  let type = 'satellite';
  try {
    const b = await ctx.request.clone().json();
    if (b && b.type === 'terrain') type = 'terrain';
  } catch {
    /* 沒有 body → 衛星 */
  }
  const sessionBody =
    type === 'terrain'
      ? { mapType: 'terrain', language: 'zh-CN', region: 'CN', layerTypes: ['layerRoadmap'] }
      : { mapType: 'satellite', language: 'zh-CN', region: 'CN' };
  const up = `https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`;
  let res;
  try {
    res = await (fetchImpl ?? fetch)(up, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(sessionBody),
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    throw new HttpError(504, 'upstream_timeout', 'Google 圖磚服務連線逾時');
  }
  const text = await res.text();
  if (!res.ok) throw new HttpError(502, 'upstream_error', '無法建立 Google 圖磚 session');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, 'upstream_error', 'Google session 回應無法解析');
  }
  if (!data.session) throw new HttpError(502, 'upstream_error', 'Google session 缺少 token');
  // 不把 API key 再塞進回應（前端已從 /api/config 取得）；只回 session／expiry
  return jsonNoStore({ type, session: data.session, expiry: data.expiry, tileWidth: data.tileWidth, tileHeight: data.tileHeight });
}
