// 公開設定與 Amap JS API 2.0 的 _AMapService 代理（讓安全密鑰 jscode 留在伺服器端）。
// 全部是「有設定才啟用」：沒有 key 就回報 disabled，前端優雅地隱藏對應功能。

import { HttpError, jsonNoStore } from './http.js';
import { createMailer } from './mail.js';

/**
 * 前端可見設定。注意：天地圖 tk 與高德 JS API key 本來就是「瀏覽器型」金鑰，
 * 必然會出現在前端；安全靠服務商後台的網域白名單，不是靠隱藏。
 * 絕不回傳：AMAP_KEY（Web 服務 key）、AMAP_JS_SECURITY_CODE、郵件 API key。
 */
export async function getConfig(ctx) {
  const env = ctx.env || {};
  const tk = (env.TIANDITU_TK || '').trim();
  const jsKey = (env.AMAP_JS_KEY || '').trim();
  const hasSecurity = !!(env.AMAP_JS_SECURITY_CODE || '').trim();
  return jsonNoStore({
    features: {
      auth: !!createMailer(env, ctx.fetchImpl),
      tianditu: !!tk,
      amap3d: !!jsKey && hasSecurity,
    },
    tianditu: tk ? { tk } : null,
    amap3d: jsKey && hasSecurity ? { key: jsKey, serviceHost: '/_AMapService' } : null,
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
    res = await (fetchImpl ?? fetch)(up.toString(), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
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
