// Cloudflare Worker 入口：/api/* 走共用處理器，其餘交給靜態資產（public/）。
import { handleApiRequest } from '../core/handlers.js';
import { createDefaultLimiter, clientIp } from '../core/ratelimit.js';

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
    if (url.pathname.startsWith('/api/') && env.API_RATE_LIMIT?.limit) {
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
    return env.ASSETS.fetch(request);
  },
};
