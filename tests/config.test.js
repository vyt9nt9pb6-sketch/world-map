import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../core/handlers.js';
import { securityHeaders } from '../core/security.js';
import { fakeFetch, req, FAKE_KEY } from './helpers.js';

const base = { AMAP_KEY: FAKE_KEY, MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@b.co', BREVO_API_KEY: 'BREVO_SECRET', AMAP_JS_SECURITY_CODE: 'SECURITYCODE123' };

test('config：什麼都沒設定 → 全部功能關閉，不洩漏任何秘密', async () => {
  const res = await handleApiRequest(req('/api/config'), { AMAP_KEY: FAKE_KEY }, {});
  const body = await res.json();
  assert.deepEqual(body.features, { auth: false, tianditu: false, amap3d: false });
  assert.equal(body.tianditu, null);
  assert.equal(body.amap3d, null);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('config：有設定才啟用；只回傳瀏覽器型金鑰，不回傳 Web 服務 key／安全密鑰／郵件 key', async () => {
  const env = { ...base, TIANDITU_TK: 'TDT_BROWSER_TK', AMAP_JS_KEY: 'JSKEY123' };
  const res = await handleApiRequest(req('/api/config'), env, {});
  const text = await res.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.features, { auth: true, tianditu: true, amap3d: true });
  assert.equal(body.tianditu.tk, 'TDT_BROWSER_TK');
  assert.deepEqual(body.amap3d, { key: 'JSKEY123', serviceHost: '/_AMapService' });
  for (const secret of [FAKE_KEY, 'BREVO_SECRET', 'SECURITYCODE123']) assert.ok(!text.includes(secret), secret);
});

test('config：只有 JS key、沒有安全密鑰 → 3D 仍關閉（高德 2021 後沒有安全密鑰會被拒）', async () => {
  const body = await (await handleApiRequest(req('/api/config'), { AMAP_KEY: FAKE_KEY, AMAP_JS_KEY: 'JSKEY123' }, {})).json();
  assert.equal(body.features.amap3d, false);
});

test('_AMapService：未啟用 → 404，且不發出任何上游請求', async () => {
  const f = fakeFetch(() => ({}));
  const res = await handleApiRequest(req('/_AMapService/v3/place/text?key=x'), { AMAP_KEY: FAKE_KEY }, { fetchImpl: f });
  assert.equal(res.status, 404);
  assert.equal(f.calls.length, 0);
});

test('_AMapService：附加伺服器端 jscode、移除使用者帶的 jscode、不使用 Web 服務 key', async () => {
  const env = { ...base, AMAP_JS_KEY: 'JSKEY123' };
  const f = fakeFetch(() => ({ status: '1', pois: [] }));
  const res = await handleApiRequest(req('/_AMapService/v3/place/text?key=JSKEY123&keywords=a&jscode=evil'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const u = f.calls[0].url;
  assert.equal(u.origin, 'https://restapi.amap.com');
  assert.equal(u.pathname, '/v3/place/text');
  assert.deepEqual(u.searchParams.getAll('jscode'), ['SECURITYCODE123']);
  assert.equal(u.searchParams.get('key'), 'JSKEY123');
  assert.ok(!u.href.includes(FAKE_KEY));
  assert.ok(!(await res.text()).includes('SECURITYCODE123'));
});

test('_AMapService：自訂地圖樣式走 webapi.amap.com；金鑰不符、路徑不在白名單、非 GET 皆拒絕', async () => {
  const env = { ...base, AMAP_JS_KEY: 'JSKEY123' };
  const f = fakeFetch(() => ({}));
  await handleApiRequest(req('/_AMapService/v4/map/styles?key=JSKEY123&styleid=a'), env, { fetchImpl: f });
  assert.equal(f.calls[0].url.origin, 'https://webapi.amap.com');
  assert.equal((await handleApiRequest(req('/_AMapService/v3/place/text?key=OTHER'), env, { fetchImpl: f })).status, 403);
  assert.equal((await handleApiRequest(req('/_AMapService/admin/x?key=JSKEY123'), env, { fetchImpl: f })).status, 404);
  assert.equal((await handleApiRequest(req('/_AMapService/v3/place/text?key=JSKEY123', { method: 'POST' }), env, { fetchImpl: f })).status, 405);
  assert.equal(f.calls.length, 1);
});

test('_AMapService：JSONP（callback）回應標成 JavaScript；callback 格式不符 → 400', async () => {
  const env = { ...base, AMAP_JS_KEY: 'JSKEY123' };
  const f = fakeFetch(() => ({ ok: 1 }));
  const ok = await handleApiRequest(req('/_AMapService/v3/log/init?key=JSKEY123&callback=jsonp_1_2_'), env, { fetchImpl: f });
  assert.match(ok.headers.get('content-type'), /^text\/javascript/);
  const bad = await handleApiRequest(req('/_AMapService/v3/log/init?key=JSKEY123&callback=a(b)'), env, { fetchImpl: f });
  assert.equal(bad.status, 400);
  assert.equal(f.calls.length, 1);
});

test('安全標頭：主頁嚴格 CSP；只有 3d.html 放寬並允許高德 JS API', () => {
  const main = securityHeaders('/')['content-security-policy'];
  assert.match(main, /script-src 'self';/);
  assert.ok(!main.includes('unsafe-eval'));
  assert.match(main, /img-src[^;]*tianditu\.gov\.cn/);
  const d3 = securityHeaders('/3d.html')['content-security-policy'];
  assert.match(d3, /webapi\.amap\.com/);
});
