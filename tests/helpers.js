// 測試共用工具
export const FAKE_KEY = 'TESTKEY_0123456789abcdef_SECRET';

export function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    const u = new URL(url);
    calls.push({ url: u, init });
    const body = await responder(u, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

/** 模擬 Workers KV 綁定（每個測試各自一份，彼此隔離） */
export function fakeKvBinding() {
  const m = new Map();
  return {
    m,
    async get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (e.exp && e.exp <= Date.now()) return null;
      return e.v;
    },
    async put(k, v, opts) {
      m.set(k, { v: String(v), exp: opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : 0 });
    },
    async delete(k) {
      m.delete(k);
    },
  };
}

export const req = (path, init) => new Request('http://localhost' + path, init);

export const post = (path, body, headers = {}) =>
  req(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost', ...headers },
    body: JSON.stringify(body),
  });
