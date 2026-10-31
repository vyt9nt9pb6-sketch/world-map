// 「單檔 Worker」入口：把 public/ 內嵌進 Worker（給沒有 wrangler／Static Assets 上傳權杖時使用）。
// 由 scripts/build-worker.mjs 打包；ASSETS 介面與 Workers Static Assets 相同，worker/index.js 不必改。
import worker from './index.js';
import { ASSETS_MAP } from 'virtual:assets';
import { securityHeaders } from '../core/security.js';

const decoded = new Map();
function body(path) {
  if (!decoded.has(path)) {
    const bin = atob(ASSETS_MAP[path].b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    decoded.set(path, bytes);
  }
  return decoded.get(path);
}

const assets = {
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const a = ASSETS_MAP[path];
    if (!a || (request.method !== 'GET' && request.method !== 'HEAD')) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    const etag = `"${a.hash}"`;
    const headers = {
      'content-type': a.type,
      etag,
      'cache-control': a.type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
      ...securityHeaders(path),
    };
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
    return new Response(request.method === 'HEAD' ? null : body(path), { status: 200, headers });
  },
};

export default {
  fetch(request, env, ctx) {
    // 不用 {...env}：部分綁定可能不是可列舉屬性，用原型鏈保留全部綁定
    const e = Object.create(env);
    Object.defineProperty(e, 'ASSETS', { value: assets });
    return worker.fetch(request, e, ctx);
  },
};
