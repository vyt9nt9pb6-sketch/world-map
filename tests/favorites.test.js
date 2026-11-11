import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../core/handlers.js';
import { cleanItem, mergeItems, MAX_ITEMS } from '../core/favorites.js';
import { fakeFetch, fakeKvBinding, req, post } from './helpers.js';

async function login(email = 'fav@example.com') {
  const kv = fakeKvBinding();
  let code;
  const mailFetch = fakeFetch((u, init) => {
    code = /\b(\d{6})\b/.exec(JSON.parse(init.body).textContent)[1];
    return {};
  });
  const env = { WM_KV: kv, MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@example.com', BREVO_API_KEY: 'k' };
  const call = (r) => handleApiRequest(r, env, { fetchImpl: mailFetch });
  await call(post('/api/auth/request-code', { email }));
  const res = await call(post('/api/auth/verify', { email, code }));
  const cookie = `wm_session=${/wm_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1]}`;
  return { env, kv, call, cookie };
}

const item = (id, over = {}) => ({ id, name: `地點${id}`, address: '某路 1 號', lng: 119.2163, lat: 34.5983, updatedAt: 1000, ...over });

test('未登入：GET/sync 皆 401', async () => {
  const kv = fakeKvBinding();
  const env = { WM_KV: kv };
  assert.equal((await handleApiRequest(req('/api/favorites'), env, {})).status, 401);
  assert.equal((await handleApiRequest(post('/api/favorites/sync', { items: [] }), env, {})).status, 401);
});

test('同步：新增、取回、no-store、資料依使用者隔離', async () => {
  const a = await login('a@example.com');
  const res = await a.call(post('/api/favorites/sync', { items: [item('p1'), item('p2', { name: '家' })] }, { cookie: a.cookie }));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).items.length, 2);
  const got = await (await a.call(req('/api/favorites', { headers: { cookie: a.cookie } }))).json();
  assert.deepEqual(got.items.map((x) => x.id).sort(), ['p1', 'p2']);

  // 另一位使用者（同一個 KV）看不到
  const calls = [];
  const code = { v: '' };
  const mailFetch = fakeFetch((u, init) => ((code.v = /\b(\d{6})\b/.exec(JSON.parse(init.body).textContent)[1]), {}));
  const call2 = (r) => handleApiRequest(r, a.env, { fetchImpl: mailFetch });
  await call2(post('/api/auth/request-code', { email: 'b@example.com' }, { 'cf-connecting-ip': '1.2.3.4' }));
  const v = await call2(post('/api/auth/verify', { email: 'b@example.com', code: code.v }));
  const cookieB = `wm_session=${/wm_session=([^;]+)/.exec(v.headers.get('set-cookie'))[1]}`;
  const b = await (await call2(req('/api/favorites', { headers: { cookie: cookieB } }))).json();
  assert.deepEqual(b.items, []);
  void calls;
});

test('合併：較新的贏；刪除以墓碑同步；舊的更新不會覆蓋新的', async () => {
  const a = await login();
  const h = { cookie: a.cookie };
  await a.call(post('/api/favorites/sync', { items: [item('p1', { name: '舊名', updatedAt: 1000 })] }, h));
  // 另一台裝置帶來較新的改名與一筆新增
  let r = await (await a.call(post('/api/favorites/sync', { items: [item('p1', { name: '新名', updatedAt: 2000 }), item('p2', { updatedAt: 1500 })] }, h))).json();
  assert.equal(r.items.find((x) => x.id === 'p1').name, '新名');
  // 第三台帶著更舊的資料：不覆蓋
  r = await (await a.call(post('/api/favorites/sync', { items: [item('p1', { name: '更舊', updatedAt: 500 })] }, h))).json();
  assert.equal(r.items.find((x) => x.id === 'p1').name, '新名');
  // 刪除
  r = await (await a.call(post('/api/favorites/sync', { items: [{ id: 'p1', deleted: true, updatedAt: Date.now() }] }, h))).json();
  assert.equal(r.items.find((x) => x.id === 'p1').deleted, true);
  assert.equal(r.items.filter((x) => !x.deleted).length, 1);
  // 被刪除之後，較舊的「還活著」副本不會復活
  r = await (await a.call(post('/api/favorites/sync', { items: [item('p1', { updatedAt: 3000 })] }, h))).json();
  assert.equal(r.items.find((x) => x.id === 'p1').deleted, true);
});

test('驗證：座標、編號、數量、欄位長度、未知欄位被丟棄', async () => {
  assert.throws(() => cleanItem({ id: 'a b', lng: 1, lat: 1 }), /編號/);
  assert.throws(() => cleanItem({ id: 'x', lng: 200, lat: 34 }), /座標/);
  assert.throws(() => cleanItem({ id: 'x', lng: 'abc', lat: 34 }), /座標/);
  assert.throws(() => cleanItem(null));
  const c = cleanItem({ id: 'x', name: 'n'.repeat(500), lng: 119.123456789, lat: 34.5, evil: '<script>', updatedAt: 5 });
  assert.equal(c.name.length, 100);
  assert.equal(c.lng, 119.123457);
  assert.equal('evil' in c, false);
  // 超過上限
  const many = Array.from({ length: MAX_ITEMS + 1 }, (_, i) => ({ id: `i${i}`, name: 'x', lng: 119, lat: 34, updatedAt: 1 }));
  assert.throws(() => mergeItems([], many), /最多/);
  const a = await login('v@example.com');
  assert.equal((await a.call(post('/api/favorites/sync', { items: [{ id: 'bad id', lng: 1, lat: 1 }] }, { cookie: a.cookie }))).status, 400);
  assert.equal((await a.call(post('/api/favorites/sync', { nope: 1 }, { cookie: a.cookie }))).status, 400);
});

test('未來時間戳被夾到「現在 + 5 分鐘」；30 天前的墓碑被清除', () => {
  const now = 1_000_000_000_000;
  assert.equal(cleanItem({ id: 'x', lng: 119, lat: 34, updatedAt: now * 2 }, now).updatedAt, now + 300000);
  const merged = mergeItems([{ id: 'old', deleted: true, updatedAt: now - 31 * 86400000 }], [], now);
  assert.equal(merged.length, 0);
});
