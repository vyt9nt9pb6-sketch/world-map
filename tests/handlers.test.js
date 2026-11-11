import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, mapAmapError } from '../core/handlers.js';
import { createRateLimiter, clientIp } from '../core/ratelimit.js';

const FAKE_KEY = 'TESTKEY_0123456789abcdef_SECRET';
const env = { AMAP_KEY: FAKE_KEY };

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url) => {
    calls.push(new URL(url));
    const body = responder(new URL(url));
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  fn.calls = calls;
  return fn;
}

const req = (path, init) => new Request('http://localhost' + path, init);

test('非 /api 路徑回傳 null（交給靜態檔）', async () => {
  assert.equal(await handleApiRequest(req('/index.html'), env), null);
});

test('只允許白名單端點與 GET', async () => {
  const f = fakeFetch(() => ({}));
  assert.equal((await handleApiRequest(req('/api/other?x=1'), env, { fetchImpl: f })).status, 404);
  assert.equal((await handleApiRequest(req('/api/search/../../v3/geocode'), env, { fetchImpl: f })), null); // URL 正規化後已不在 /api 之下
  assert.equal((await handleApiRequest(req('/api/search/extra?q=a'), env, { fetchImpl: f })).status, 404);
  assert.equal((await handleApiRequest(req('/api'), env, { fetchImpl: f }))?.status ?? 404, 404);
  assert.equal((await handleApiRequest(req('/api/search?q=a', { method: 'POST' }), env, { fetchImpl: f })).status, 405);
  assert.equal(f.calls.length, 0);
});

test('search：key 只在伺服器端加入，只打 restapi.amap.com，回應不含 key', async () => {
  const f = fakeFetch((u) => ({ infocode: '10000', count: '1', pois: [{ id: 'B1', name: '中石化加油站', location: '119.3,34.7' }] }));
  const res = await handleApiRequest(req('/api/search?q=加油站&location=119.3,34.7&key=evil&callback=x'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(FAKE_KEY));
  assert.equal(JSON.parse(text).results[0].name, '中石化加油站');
  assert.equal(f.calls.length, 1);
  const u = f.calls[0];
  assert.equal(u.origin, 'https://restapi.amap.com');
  assert.equal(u.pathname, '/v5/place/around');
  assert.equal(u.searchParams.get('key'), FAKE_KEY); // 用伺服器的 key，而不是使用者傳的
  assert.equal(u.searchParams.getAll('key').length, 1);
  assert.equal(u.searchParams.get('callback'), null);
  assert.equal(u.searchParams.get('keywords'), '加油站');
});

test('search：附近找不到時退回關鍵字搜尋', async () => {
  const f = fakeFetch((u) => (u.pathname === '/v5/place/around' ? { infocode: '10000', count: '0', pois: [] } : { infocode: '10000', count: '1', pois: [{ id: 'B2', name: 'Far', location: '100,30' }] }));
  const res = await handleApiRequest(req('/api/search?q=x&location=119,34'), env, { fetchImpl: f });
  const body = await res.json();
  assert.equal(body.source, 'text');
  assert.deepEqual(f.calls.map((c) => c.pathname), ['/v5/place/around', '/v5/place/text']);
});

test('search：附近結果名稱都不含關鍵字時改用全國搜尋', async () => {
  const f = fakeFetch((u) =>
    u.pathname === '/v5/place/around'
      ? { infocode: '10000', pois: [{ id: 'B1', name: '连云港南收费站', location: '119,34' }] }
      : { infocode: '10000', pois: [{ id: 'B2', name: '南京站', location: '118.79,32.08' }] },
  );
  const body = await (await handleApiRequest(req('/api/search?q=南京站&location=119,34'), env, { fetchImpl: f })).json();
  assert.equal(body.source, 'text');
  assert.equal(body.results[0].name, '南京站');
  const f2 = fakeFetch(() => ({ infocode: '10000', pois: [{ id: 'B1', name: '中国石化加油站', location: '119,34' }] }));
  const b2 = await (await handleApiRequest(req('/api/search?q=加油站&location=119,34'), env, { fetchImpl: f2 })).json();
  assert.equal(b2.source, 'around');
  assert.equal(f2.calls.length, 1);
});

test('geocode：30001（不是地址）視為沒有結果', async () => {
  const f = fakeFetch(() => ({ status: '0', info: 'ENGINE_RESPONSE_DATA_ERROR', infocode: '30001' }));
  const res = await handleApiRequest(req('/api/geocode?address=加油站'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { results: [] });
});

test('route：參數對應到 v5 driving（避開收費 → v5 strategy 1／36 ＋ v3 14）', async () => {
  const path = { distance: '1000', cost: { duration: '100' }, steps: [{ polyline: '119,34;119.1,34.1' }] };
  const f = fakeFetch((u) =>
    u.pathname === '/v3/direction/driving'
      ? { status: '1', infocode: '10000', route: { paths: [] } }
      : { infocode: '10000', route: { paths: [path] } },
  );
  const res = await handleApiRequest(req('/api/route?origin=119.2,34.5&destination=118.7,32&waypoints=119,33&avoid_toll=1'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const v5 = f.calls.filter((u) => u.pathname === '/v5/direction/driving');
  assert.deepEqual(v5.map((u) => u.searchParams.get('strategy')).sort(), ['1', '36']);
  assert.equal(v5[0].searchParams.get('waypoints'), '119,33');
  assert.equal(v5[0].searchParams.get('show_fields'), 'cost,polyline');
  const v3 = f.calls.find((u) => u.pathname === '/v3/direction/driving');
  assert.equal(v3.searchParams.get('strategy'), '14');
  assert.equal(v3.searchParams.get('extensions'), 'all');
});

test('驗證錯誤 → 400，不呼叫上游', async () => {
  const f = fakeFetch(() => ({}));
  const res = await handleApiRequest(req('/api/route?origin=bad&destination=1,2'), env, { fetchImpl: f });
  assert.equal(res.status, 400);
  const b = await res.json();
  assert.equal(b.error.code, 'invalid_param');
  assert.equal(b.error.field, 'origin');
  assert.equal(f.calls.length, 0);
});

test('上游錯誤代碼轉換，且不洩漏 key', async () => {
  const f = fakeFetch(() => ({ status: '0', info: 'INVALID_USER_KEY ' + FAKE_KEY, infocode: '10001' }));
  const res = await handleApiRequest(req('/api/geocode?address=x'), env, { fetchImpl: f });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes(FAKE_KEY));
  assert.equal(mapAmapError('10003').status, 429);
  assert.equal(mapAmapError('20000').status, 400);
  assert.equal(mapAmapError('20800').code, 'no_route');
  assert.equal(mapAmapError('99999').status, 502);
});

test('上游逾時／網路錯誤 → 504', async () => {
  const f = async () => {
    throw new Error('connect ECONNREFUSED https://restapi.amap.com/?key=' + FAKE_KEY);
  };
  const res = await handleApiRequest(req('/api/geocode?address=x'), env, { fetchImpl: f });
  assert.equal(res.status, 504);
  assert.ok(!(await res.text()).includes(FAKE_KEY));
});

test('沒有設定 AMAP_KEY → 500 server_config', async () => {
  const res = await handleApiRequest(req('/api/geocode?address=x'), {}, { fetchImpl: fakeFetch(() => ({})) });
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error.code, 'server_config');
});

test('ALLOWED_ORIGINS：只允許指定來源', async () => {
  const f = fakeFetch(() => ({ geocodes: [] }));
  const e2 = { ...env, ALLOWED_ORIGINS: 'https://ok.example' };
  assert.equal((await handleApiRequest(req('/api/geocode?address=x', { headers: { origin: 'https://evil.example' } }), e2, { fetchImpl: f })).status, 403);
  assert.equal((await handleApiRequest(req('/api/geocode?address=x', { headers: { referer: 'https://ok.example/' } }), e2, { fetchImpl: f })).status, 200);
  assert.equal((await handleApiRequest(req('/api/geocode?address=x'), e2, { fetchImpl: f })).status, 403);
});

test('限流：超過額度回 429 並帶 retry-after', async () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => t });
  const f = fakeFetch(() => ({ geocodes: [] }));
  const mk = (ip) => req('/api/geocode?address=x', { headers: { 'cf-connecting-ip': ip } });
  assert.equal((await handleApiRequest(mk('1.1.1.1'), env, { fetchImpl: f, rateLimiter: rl })).status, 200);
  assert.equal((await handleApiRequest(mk('1.1.1.1'), env, { fetchImpl: f, rateLimiter: rl })).status, 200);
  const r3 = await handleApiRequest(mk('1.1.1.1'), env, { fetchImpl: f, rateLimiter: rl });
  assert.equal(r3.status, 429);
  assert.equal(r3.headers.get('retry-after'), '1');
  assert.equal((await handleApiRequest(mk('2.2.2.2'), env, { fetchImpl: f, rateLimiter: rl })).status, 200); // 別的 IP 不受影響
  t += 1000;
  assert.equal((await handleApiRequest(mk('1.1.1.1'), env, { fetchImpl: f, rateLimiter: rl })).status, 200); // 補充後恢復
  assert.equal(f.calls.length, 4);
});

test('限流：記憶體上限', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1, maxKeys: 3 });
  for (let i = 0; i < 10; i++) rl.take('ip' + i);
  assert.equal(rl.size(), 3);
});

test('clientIp 取值順序', () => {
  assert.equal(clientIp(new Request('http://x', { headers: { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' } })), '9.9.9.9');
  assert.equal(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } })), '1.1.1.1');
  assert.equal(clientIp(new Request('http://x'), '127.0.0.1'), '127.0.0.1');
});
