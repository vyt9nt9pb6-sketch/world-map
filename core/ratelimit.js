// 簡單的「每個 IP」限流（記憶體內 token bucket）。
// 在 Node 單一行程（本機伺服器＋Cloudflare Tunnel）完全有效；
// 在 Vercel / Cloudflare Workers 上只在單一實例內有效，正式上線建議改用平台的限流功能。

export function createRateLimiter({ capacity = 30, refillPerSec = 0.5, maxKeys = 10000, now = () => Date.now() } = {}) {
  const buckets = new Map();
  function take(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) {
        // 移除最舊的一個，避免記憶體無限成長
        buckets.delete(buckets.keys().next().value);
      }
      b = { tokens: capacity, last: t };
      buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + ((t - b.last) / 1000) * refillPerSec);
      b.last = t;
      // 重新放到 Map 尾端（LRU）
      buckets.delete(key);
      buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerSec) };
  }
  return { take, size: () => buckets.size };
}

/** 取得用戶端 IP：Cloudflare（含 Tunnel）會設 cf-connecting-ip；否則用 x-forwarded-for 第一段；最後用傳入的連線位址。 */
export function clientIp(request, fallback = 'unknown') {
  const cf = request.headers.get('cf-connecting-ip');
  if (cf) return cf.trim();
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return fallback;
}

/**
 * 預設限流：每個 IP（突發 30、每秒補 0.5）＋ 全站總量（突發 200、每秒補 0.02 ≈ 每天 1700 次），保護高德每日配額。
 * 數值可用環境變數 RATE_BURST / RATE_PER_SEC / GLOBAL_BURST / GLOBAL_PER_SEC 調整。
 */
export function createDefaultLimiter(env = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
  const perIp = createRateLimiter({ capacity: n(env.RATE_BURST, 30), refillPerSec: n(env.RATE_PER_SEC, 0.5) });
  const global = createRateLimiter({ capacity: n(env.GLOBAL_BURST, 200), refillPerSec: n(env.GLOBAL_PER_SEC, 0.02), maxKeys: 1 });
  return {
    take(ip) {
      const a = perIp.take(ip);
      if (!a.ok) return a;
      return global.take('global');
    },
  };
}
