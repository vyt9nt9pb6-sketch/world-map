// Cloudflare Worker 入口：/api/* 走共用處理器，其餘交給靜態資產（public/）。
import { handleApiRequest } from '../core/handlers.js';
import { createDefaultLimiter } from '../core/ratelimit.js';

// 注意：Worker 的記憶體只在單一 isolate 內，這個限流只是「盡力而為」。
// 正式上線建議再加 Cloudflare 的 Rate Limiting 規則（WAF）。
let limiter;

export default {
  async fetch(request, env) {
    limiter ??= createDefaultLimiter(env);
    const res = await handleApiRequest(request, env, { rateLimiter: limiter });
    if (res) return res;
    return env.ASSETS.fetch(request);
  },
};
