// 鍵值儲存抽象：Cloudflare Workers 用 KV（env.WM_KV）；Node 本機與測試用記憶體。
// 注意：Workers KV 最終一致、沒有原子遞增，所以這裡的限流計數是「盡力而為」，
// 搭配 Cloudflare 的 API_RATE_LIMIT binding 一起使用。

class MemoryKv {
  constructor() {
    this.m = new Map();
  }
  async get(key) {
    const e = this.m.get(key);
    if (!e) return null;
    if (e.exp && e.exp <= Date.now()) {
      this.m.delete(key);
      return null;
    }
    return e.v;
  }
  async put(key, value, { ttl } = {}) {
    this.m.set(key, { v: String(value), exp: ttl ? Date.now() + ttl * 1000 : 0 });
  }
  async delete(key) {
    this.m.delete(key);
  }
}

const shared = new MemoryKv();

class WorkersKv {
  constructor(kv) {
    this.kv = kv;
  }
  get(key) {
    return this.kv.get(key);
  }
  put(key, value, { ttl } = {}) {
    // Workers KV 的 expirationTtl 最小 60 秒
    return this.kv.put(key, String(value), ttl ? { expirationTtl: Math.max(60, Math.ceil(ttl)) } : undefined);
  }
  delete(key) {
    return this.kv.delete(key);
  }
}

export function createMemoryKv() {
  return new MemoryKv();
}

/** @returns {{kind:'workers-kv'|'memory', get, put, delete}} */
export function getKv(env) {
  if (env?.WM_KV && typeof env.WM_KV.get === 'function') {
    const k = new WorkersKv(env.WM_KV);
    k.kind = 'workers-kv';
    return k;
  }
  shared.kind = 'memory';
  return shared;
}

export async function getJson(kv, key) {
  const raw = await kv.get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function putJson(kv, key, value, opts) {
  return kv.put(key, JSON.stringify(value), opts);
}
