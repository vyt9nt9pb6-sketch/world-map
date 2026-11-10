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

import { securityHeaders } from '../core/security.js';

// 只傳入需要的環境變數（金鑰只在後端使用）。本機沒有 Workers KV：登入／收藏用記憶體儲存，重啟即清空。
const ENV_NAMES = [
  'AMAP_KEY', 'ALLOWED_ORIGINS', 'AUTH_SECRET', 'MAIL_PROVIDER', 'MAIL_FROM', 'MAIL_FROM_NAME', 'MAIL_DAILY_LIMIT',
  'BREVO_API_KEY', 'RESEND_API_KEY', 'TIANDITU_TK', 'AMAP_JS_KEY', 'AMAP_JS_SECURITY_CODE',
];
const env = Object.fromEntries(ENV_NAMES.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
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
  '.gz': 'application/gzip',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = securityHeaders('/');

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
      ...securityHeaders(pathname),
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
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_AMapService/')) {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      let body;
      if (req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 300 * 1024) return send(res, 413, 'Too large');
          chunks.push(c);
        }
        body = Buffer.concat(chunks);
      }
      const request = new Request(url, { method: req.method, headers, body });
      const response = await handleApiRequest(request, env, { rateLimiter, remoteAddress: req.socket.remoteAddress });
      const out = Object.fromEntries(response.headers);
      res.writeHead(response.status, { ...out, ...securityHeaders('/api') });
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
