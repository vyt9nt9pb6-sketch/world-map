import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../core/handlers.js';
import { cleanPoint, mergePoints, MAX_POINTS, MAX_BATCH, MAX_WRITES_PER_HOUR } from '../core/footprint.js';
import { filterPoints, shouldRecord, toHeatData, FOOT_PRIVACY, FOOT_BACKGROUND } from '../public/js/lib/footprint.js';
import { wgs84ToGcj02 } from '../public/js/lib/coords.js';
import { fakeFetch, fakeKvBinding, req, post } from './helpers.js';

function setup() {
  const sent = [];
  const mailFetch = fakeFetch((u, init) => {
    sent.push(JSON.parse(init.body));
    return { messageId: 'x' };
  });
  const kv = fakeKvBinding();
  const env = { WM_KV: kv, MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@example.com', BREVO_API_KEY: 'k' };
  const call = (r) => handleApiRequest(r, env, { fetchImpl: mailFetch });
  return { kv, sent, call };
}

const del = (path, headers = {}) =>
  req(path, { method: 'DELETE', headers: { origin: 'http://localhost', ...headers } });

async function login(s, email, ip) {
  const r1 = await s.call(post('/api/auth/request-code', { email }, { 'cf-connecting-ip': ip }));
  assert.equal(r1.status, 200);
  const code = /\b(\d{6})\b/.exec(s.sent.at(-1).textContent)[1];
  const r2 = await s.call(post('/api/auth/verify', { email, code }, { 'cf-connecting-ip': ip }));
  assert.equal(r2.status, 200);
  return /wm_session=([^;]+)/.exec(r2.headers.get('set-cookie'))[1];
}

const auth = (token) => ({ cookie: `wm_session=${token}`, origin: 'http://localhost' });

test('足跡：未登入一律 401，沒有公開清單，快取標成 no-store', async () => {
  const s = setup();
  for (const r of [
    req('/api/footprint'),
    post('/api/footprint', { points: [{ lng: 121.5, lat: 31.2 }] }),
    del('/api/footprint'),
  ]) {
    const res = await s.call(r);
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'login_required');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.equal((await s.call(req('/api/footprints'))).status, 404);
  assert.equal((await s.call(req('/api/footprint/other'))).status, 404);
  const cfg = await (await s.call(req('/api/config'))).json();
  assert.equal(JSON.stringify(cfg).includes('121.5'), false);
});

test('足跡：只看得到自己的點；不能用 query 指定別人；刪除只清自己', async () => {
  const s = setup();
  const a = await login(s, 'a@example.com', '203.0.113.1');
  const b = await login(s, 'b@example.com', '203.0.113.2');
  const pa = await s.call(post('/api/footprint', { points: [{ lng: 121.4737, lat: 31.2304, t: Date.now() }] }, auth(a)));
  assert.equal(pa.status, 200);
  assert.equal(pa.headers.get('cache-control'), 'no-store');
  const pb = await s.call(post('/api/footprint', { lng: 116.4074, lat: 39.9042, t: Date.now() }, auth(b)));
  assert.equal(pb.status, 200);

  const ga = await (await s.call(req('/api/footprint?uid=b', { headers: { cookie: `wm_session=${a}` } }))).json();
  assert.equal(ga.count, 1);
  assert.equal(ga.points[0].lng, 121.4737);
  assert.equal(JSON.stringify(ga).includes('116.4074'), false);
  assert.equal(ga.uid, undefined);
  assert.equal(ga.email, undefined);

  const gb = await (await s.call(req('/api/footprint', { headers: { cookie: `wm_session=${b}` } }))).json();
  assert.equal(gb.points[0].lng, 116.4074);
  assert.equal(JSON.stringify(gb).includes('121.4737'), false);

  // KV 的 key 是 fp:雜湊，不含 email，也不含另一個人的座標在同一筆
  const dump = [...s.kv.m.entries()].filter(([k]) => k.startsWith('fp:') && !k.startsWith('fp:rl:'));
  assert.equal(dump.length, 2);
  assert.ok(dump.every(([k]) => !k.includes('@')));
  const blobA = dump.find(([, v]) => v.v.includes('121.4737'))[1].v;
  assert.equal(blobA.includes('116.4074'), false);
  assert.equal(blobA.includes('a@example.com'), false);

  const cleared = await (await s.call(del('/api/footprint', { cookie: `wm_session=${a}` }))).json();
  assert.equal(cleared.count, 0);
  const ga2 = await (await s.call(req('/api/footprint', { headers: { cookie: `wm_session=${a}` } }))).json();
  assert.equal(ga2.count, 0);
  const gb2 = await (await s.call(req('/api/footprint', { headers: { cookie: `wm_session=${b}` } }))).json();
  assert.equal(gb2.count, 1);
});

test('足跡：座標與時間驗證、同源、去重、上限', async () => {
  const s = setup();
  const token = await login(s, 'c@example.com', '203.0.113.3');
  const badOrigin = await s.call(
    req('/api/footprint', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `wm_session=${token}` },
      body: JSON.stringify({ points: [{ lng: 121, lat: 31 }] }),
    }),
  );
  assert.equal(badOrigin.status, 403);

  const bad = await s.call(post('/api/footprint', { points: [{ lng: 999, lat: 31 }] }, auth(token)));
  assert.equal(bad.status, 400);
  const empty = await s.call(post('/api/footprint', { points: [] }, auth(token)));
  assert.equal(empty.status, 400);

  const now = Date.now();
  const future = await (await s.call(post('/api/footprint', { points: [{ lng: 121.1, lat: 31.1, t: now + 3600_000 }] }, auth(token)))).json();
  assert.ok(future.points[0].t <= now + 5000);

  const near = await (await s.call(post('/api/footprint', { points: [{ lng: 121.10005, lat: 31.10005, t: now + 2000 }] }, auth(token)))).json();
  assert.equal(near.count, 1, '15 秒內、20 公尺內的抖動不另存');

  const moved = await (await s.call(post('/api/footprint', { points: [{ lng: 121.2, lat: 31.2, t: now + 60_000 }] }, auth(token)))).json();
  assert.equal(moved.count, 2);

  assert.throws(() => cleanPoint({ lng: 10, lat: 10, t: now - 20 * 365 * 86400000 }, now), /時間/);
  const many = Array.from({ length: MAX_POINTS + 50 }, (_, i) => ({ lng: -10 + i * 0.01, lat: 0, t: 1_700_000_000_000 + i * 60_000 }));
  assert.equal(mergePoints([], many.map((p) => cleanPoint(p, Date.now()))).length, MAX_POINTS);
  const tooMany = await s.call(post('/api/footprint', { points: Array.from({ length: MAX_BATCH + 1 }, () => ({ lng: 1, lat: 1 })) }, auth(token)));
  assert.equal(tooMany.status, 413);
});

test('足跡：每小時寫入次數有上限', async () => {
  const s = setup();
  const token = await login(s, 'd@example.com', '203.0.113.4');
  let status = 200;
  for (let i = 0; i < MAX_WRITES_PER_HOUR + 1; i++) {
    const res = await s.call(post('/api/footprint', { points: [{ lng: 10 + i * 0.05, lat: 20, t: Date.now() + i * 60_000 }] }, auth(token)));
    status = res.status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
});

test('足跡前端：時間篩選、記錄間隔、熱力用 GCJ 且不洩漏別人的點', () => {
  const now = new Date(2026, 5, 15, 15, 0, 0).getTime();
  const points = [
    { lng: 121.47, lat: 31.23, t: now - 3600_000 },
    { lng: 116.4, lat: 39.9, t: now - 3 * 86400000 },
    { lng: 113.3, lat: 23.1, t: now - 40 * 86400000 },
  ];
  assert.equal(filterPoints(points, 'day', now).length, 1);
  assert.equal(filterPoints(points, '7d', now).length, 2);
  assert.equal(filterPoints(points, 'all', now).length, 3);
  assert.equal(filterPoints(points, '30d', now).length, 2);

  assert.equal(shouldRecord(null, { lng: 1, lat: 2 }, now), true);
  assert.equal(shouldRecord({ lng: 121.47, lat: 31.23, t: now }, { lng: 121.4701, lat: 31.2301 }, now + 5000), false);
  assert.equal(shouldRecord({ lng: 121.47, lat: 31.23, t: now }, { lng: 121.50, lat: 31.23 }, now + 10000), true);
  assert.equal(shouldRecord({ lng: 121.47, lat: 31.23, t: now }, { lng: 121.4701, lat: 31.23 }, now + 31000), true);

  const heat = toHeatData(filterPoints(points, 'day', now), wgs84ToGcj02);
  assert.equal(heat.data.length, 1);
  const [gLng, gLat] = wgs84ToGcj02(121.47, 31.23);
  assert.ok(Math.abs(heat.data[0].lng - gLng) < 1e-4);
  assert.ok(Math.abs(heat.data[0].lat - gLat) < 1e-4);
  assert.equal(JSON.stringify(heat).includes('116.4'), false);
  assert.match(FOOT_PRIVACY, /其他使用者/);
  assert.match(FOOT_BACKGROUND, /背景/);
});
