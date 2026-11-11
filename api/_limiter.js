// Vercel：同一個執行個體內共用的限流器（檔名以 _ 開頭，Vercel 不會把它當成路由）。
// 多個執行個體之間不共享，只是「盡力而為」；要嚴格限流請加 Vercel KV / Upstash。
import { createDefaultLimiter } from '../core/ratelimit.js';
export const limiter = createDefaultLimiter(process.env);
