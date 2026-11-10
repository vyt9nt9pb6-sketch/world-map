// Cloudflare Worker 入口：/api/* 走共用處理器，其餘交給靜態資產（public/）。
import { handleApiRequest } from '../core/handlers.js';
import { createDefaultLimiter, clientIp } from '../core/ratelimit.js';
import { VERSIONED_ASSETS, rewriteAssetUrls, versionFromEtag } from '../core/asset-rev.js';

// 兩層限流：
// 1. API_RATE_LIMIT（Cloudflare Rate Limiting 綁定，跨 isolate、同一機房內有效）——有綁才用。
// 2. 記憶體 token bucket（每 IP + 全站），只在單一 isolate 內，屬「盡力而為」。
let limiter;

function tooMany() {
  return new Response(JSON.stringify({ error: { code: 'rate_limited', message: '查詢太頻繁，請稍後再試' } }), {
    status: 429,
    headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': '60', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/_AMapService/')) && env.API_RATE_LIMIT?.limit) {
      try {
        const { success } = await env.API_RATE_LIMIT.limit({ key: clientIp(request) });
        if (!success) return tooMany();
      } catch {
        /* 綁定失敗時退回記憶體限流 */
      }
    }
    limiter ??= createDefaultLimiter(env);
    const res = await handleApiRequest(request, env, { rateLimiter: limiter });
    if (res) {
      res.headers.set('x-rl', env.API_RATE_LIMIT?.limit ? 'edge+memory' : 'memory');
      return res;
    }
    // HTML 的 etag 是改寫前的檔案。若直接 304，瀏覽器會留著舊的 app.js 網址，熱力開關繼續沒反應。
    const assetReq = isHtmlPath(url) ? requestWithoutValidators(request, 'GET') : request;
    const asset = await env.ASSETS.fetch(assetReq);
    if (!isHtmlDocument(url, asset)) return asset;
    return revisionHtml(request, env, asset);
  },
};

function isHtmlPath(url) {
  return url.pathname === '/' || url.pathname.endsWith('/') || url.pathname.endsWith('.html');
}

function requestWithoutValidators(request, method = request.method) {
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  return new Request(request.url, { method, headers });
}

function isHtmlDocument(url, res) {
  if (res.status !== 200) return false;
  const ct = res.headers.get('content-type') || '';
  return ct.includes('text/html') || isHtmlPath(url);
}

/** 讀靜態檔的 etag，改寫 HTML 裡的進入點網址，讓舊的模組快取用不上。 */
async function revisionHtml(request, env, asset) {
  const versions = {};
  await Promise.all(VERSIONED_ASSETS.map(async (path) => {
    try {
      const head = await env.ASSETS.fetch(new Request(new URL(path, request.url), { method: 'HEAD' }));
      versions[path] = versionFromEtag(head.headers.get('etag'));
    } catch {
      versions[path] = '';
    }
  }));
  const html = rewriteAssetUrls(await asset.text(), versions);
  const etag = `"${await sha256Short(html)}"`;
  const headers = new Headers(asset.headers);
  headers.delete('content-length');
  headers.set('content-type', asset.headers.get('content-type') || 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-cache');
  headers.set('etag', etag);
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers });
}

async function sha256Short(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
