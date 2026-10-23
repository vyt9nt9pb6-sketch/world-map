// 本機／自架用 Node 伺服器：靜態檔案（public/）＋ /api/*（共用 core/handlers.js）。
// 用法：AMAP_KEY=... node server/server.mjs   （預設只綁 127.0.0.1:8787）
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApiRequest } from '../core/handlers.js';
import { createDefaultLimiter } from '../core/ratelimit.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const env = { AMAP_KEY: process.env.AMAP_KEY, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS };
if (!env.AMAP_KEY) console.warn('[world-map] 警告：未設定 AMAP_KEY，/api 會回傳錯誤');

// 每個 IP 與全站總量限流（見 core/ratelimit.js）
const rateLimiter = createDefaultLimiter(process.env);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
  'content-security-policy':
    "default-src 'self'; img-src 'self' data: https://*.is.autonavi.com; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
};

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  if (rel.split('/').some((seg) => seg.startsWith('.'))) return send(res, 404, 'Not found');
  const file = path.resolve(ROOT, '.' + rel);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 404, 'Not found');
  try {
    const st = await stat(file);
    if (!st.isFile()) return send(res, 404, 'Not found');
    const body = await readFile(file);
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      ...SECURITY_HEADERS,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    send(res, 404, 'Not found');
  }
}

function send(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      const request = new Request(url, { method: req.method, headers });
      const response = await handleApiRequest(request, env, { rateLimiter, remoteAddress: req.socket.remoteAddress });
      const out = Object.fromEntries(response.headers);
      res.writeHead(response.status, { ...out, ...SECURITY_HEADERS });
      res.end(Buffer.from(await response.arrayBuffer()));
      // 只記錄路徑與狀態碼，不記錄查詢字串
      console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${response.status}`);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    await serveStatic(req, res, url.pathname);
  } catch {
    send(res, 500, 'Internal error');
  }
});

server.listen(PORT, HOST, () => console.log(`[world-map] http://${HOST}:${PORT}`));
