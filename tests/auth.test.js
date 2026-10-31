import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../core/handlers.js';
import { createMailer } from '../core/mail.js';
import { normalizeEmail, maskEmail } from '../core/auth.js';
import { fakeFetch, fakeKvBinding, req, post } from './helpers.js';

/** 帶有「寄信會被記錄」的假 Brevo 的環境 */
function setup(extra = {}) {
  const sent = [];
  const mailFetch = fakeFetch((u, init) => {
    sent.push({ url: u.href, headers: init.headers, body: JSON.parse(init.body) });
    return { messageId: 'x' };
  });
  const kv = fakeKvBinding();
  const env = { WM_KV: kv, MAIL_PROVIDER: 'brevo', MAIL_FROM: 'noreply@example.com', BREVO_API_KEY: 'BREVO_SECRET_KEY', ...extra };
  const call = (r) => handleApiRequest(r, env, { fetchImpl: mailFetch });
  const codeOf = () => /\b(\d{6})\b/.exec(sent.at(-1).body.textContent)[1];
  return { env, kv, sent, call, codeOf, mailFetch };
}
const ip = (n) => ({ 'cf-connecting-ip': `203.0.113.${n}` });
const cookieOf = (res) => /wm_session=([^;]+)/.exec(res.headers.get('set-cookie'))[1];

test('email 正規化與遮罩', () => {
  assert.equal(normalizeEmail('  Kwok@Example.COM '), 'kwok@example.com');
  assert.throws(() => normalizeEmail('nope'), /有效的電子郵件/);
  assert.throws(() => normalizeEmail('a@b'), /有效的電子郵件/);
  assert.throws(() => normalizeEmail('a'.repeat(300) + '@x.com'));
  assert.equal(maskEmail('kwok@example.com'), 'kw**@example.com');
});

test('沒有設定郵件服務：request-code 回 503，前端 config 顯示 auth=false', async () => {
  const kv = fakeKvBinding();
  const env = { WM_KV: kv };
  const res = await handleApiRequest(post('/api/auth/request-code', { email: 'a@b.co' }), env, {});
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'email_not_configured');
  const cfg = await (await handleApiRequest(req('/api/config'), env, {})).json();
  assert.equal(cfg.features.auth, false);
});

test('完整流程：索取驗證碼 → 驗證 → me → logout；碼只存雜湊、一次性', async () => {
  const s = setup();
  const r1 = await s.call(post('/api/auth/request-code', { email: 'Kwok@Example.com' }, ip(1)));
  assert.equal(r1.status, 200);
  assert.equal(r1.headers.get('cache-control'), 'no-store');
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(s.sent[0].body.to[0].email, 'kwok@example.com');
  const code = s.codeOf();
  assert.match(code, /^\d{6}$/);
  // KV 內不含驗證碼明碼、不含 email 明碼
  const dump = JSON.stringify([...s.kv.m.entries()]);
  assert.ok(!dump.includes(`"${code}"`) && !dump.includes('kwok@example.com'));

  const bad = await s.call(post('/api/auth/verify', { email: 'kwok@example.com', code: code === '000000' ? '111111' : '000000' }, ip(1)));
  assert.equal(bad.status, 401);

  const ok = await s.call(post('/api/auth/verify', { email: 'kwok@example.com', code }, ip(1)));
  assert.equal(ok.status, 200);
  const setCookie = ok.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);
  const token = cookieOf(ok);
  assert.ok(token.length >= 40);
  // session 在 KV 中只存 token 的雜湊
  assert.ok(!JSON.stringify([...s.kv.m.keys()]).includes(token));

  // 同一個碼不能用第二次
  assert.equal((await s.call(post('/api/auth/verify', { email: 'kwok@example.com', code }, ip(1)))).status, 401);

  const me = await (await s.call(req('/api/auth/me', { headers: { cookie: `wm_session=${token}` } }))).json();
  assert.equal(me.user.email, 'kwok@example.com');
  assert.equal((await (await s.call(req('/api/auth/me'))).json()).user, null);

  const out = await s.call(post('/api/auth/logout', {}, { cookie: `wm_session=${token}` }));
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await (await s.call(req('/api/auth/me', { headers: { cookie: `wm_session=${token}` } }))).json()).user, null);
});

test('https 才加 Secure', async () => {
  const s = setup();
  await s.call(post('/api/auth/request-code', { email: 'sec@example.com' }, ip(2)));
  const r = new Request('https://localhost/api/auth/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://localhost' },
    body: JSON.stringify({ email: 'sec@example.com', code: s.codeOf() }),
  });
  assert.match((await s.call(r)).headers.get('set-cookie'), /; Secure/);
});

test('驗證碼錯 5 次後作廢；到期後無效', async () => {
  const s = setup();
  await s.call(post('/api/auth/request-code', { email: 'lock@example.com' }, ip(3)));
  const code = s.codeOf();
  const wrong = code === '123456' ? '654321' : '123456';
  for (let i = 0; i < 4; i++) assert.equal((await s.call(post('/api/auth/verify', { email: 'lock@example.com', code: wrong }, ip(3)))).status, 401);
  assert.equal((await s.call(post('/api/auth/verify', { email: 'lock@example.com', code: wrong }, ip(3)))).status, 401); // 第 5 次：作廢
  // 即使現在輸入正確的碼也不行
  assert.equal((await s.call(post('/api/auth/verify', { email: 'lock@example.com', code }, ip(3)))).status, 401);

  // 過期
  await s.call(post('/api/auth/request-code', { email: 'exp@example.com' }, ip(4)));
  const c2 = s.codeOf();
  const key = [...s.kv.m.keys()].find((k) => k.startsWith('otp:') && JSON.parse(s.kv.m.get(k).v).attempts === 0);
  const rec = JSON.parse(s.kv.m.get(key).v);
  rec.exp = Date.now() - 1000;
  s.kv.m.set(key, { v: JSON.stringify(rec), exp: 0 });
  assert.equal((await s.call(post('/api/auth/verify', { email: 'exp@example.com', code: c2 }, ip(4)))).status, 401);
});

test('限流：每個 email 60 秒冷卻；每 IP 每小時 10 封；全站每日上限', async () => {
  const s = setup({ MAIL_DAILY_LIMIT: '12' });
  const first = await s.call(post('/api/auth/request-code', { email: 'cool@example.com' }, ip(5)));
  assert.equal(first.status, 200);
  const again = await s.call(post('/api/auth/request-code', { email: 'cool@example.com' }, ip(5)));
  assert.equal(again.status, 429);
  assert.ok(Number(again.headers.get('retry-after')) > 0);
  assert.equal(s.sent.length, 1);

  // 同一個 IP：第 2~10 封換不同信箱 OK，第 11 封被擋
  for (let i = 0; i < 9; i++) assert.equal((await s.call(post('/api/auth/request-code', { email: `u${i}@example.com` }, ip(6)))).status, 200);
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'u99@example.com' }, ip(6)))).status, 200); // 這個 IP 是第 10 封
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'u100@example.com' }, ip(6)))).status, 429);

  // 全站每日上限 12：目前已寄 1+10=11，再 1 封到 12，之後被擋
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'g1@example.com' }, ip(7)))).status, 200);
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'g2@example.com' }, ip(8)))).status, 429);
});

test('同一個 email 每小時最多 5 封（即使冷卻已過）', async () => {
  const s = setup();
  for (let i = 0; i < 5; i++) {
    const r = await s.call(post('/api/auth/request-code', { email: 'many@example.com' }, ip(10 + i)));
    assert.equal(r.status, 200, `第 ${i + 1} 封`);
    // 清掉冷卻（把 sentAt 往前調）
    for (const [k, v] of s.kv.m) {
      if (k.startsWith('otp:')) {
        const o = JSON.parse(v.v);
        o.sentAt -= 120000;
        s.kv.m.set(k, { v: JSON.stringify(o), exp: 0 });
      }
    }
  }
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'many@example.com' }, ip(30)))).status, 429);
});

test('寄信失敗：502，且不留下驗證碼；回應與日誌不含 API key', async () => {
  const kv = fakeKvBinding();
  const env = { WM_KV: kv, MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@example.com', BREVO_API_KEY: 'BREVO_SECRET_KEY' };
  const failing = async () => new Response('{"message":"nope BREVO_SECRET_KEY"}', { status: 401 });
  const res = await handleApiRequest(post('/api/auth/request-code', { email: 'fail@example.com' }, ip(40)), env, { fetchImpl: failing });
  assert.equal(res.status, 502);
  assert.ok(!(await res.text()).includes('BREVO_SECRET_KEY'));
  assert.ok(![...kv.m.keys()].some((k) => k.startsWith('otp:')));
});

test('寫入類請求要通過同源檢查（缺 Origin 或跨站都 403）', async () => {
  const s = setup();
  const noOrigin = req('/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"a@b.co"}' });
  assert.equal((await s.call(noOrigin)).status, 403);
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'a@b.co' }, { origin: 'https://evil.example' }))).status, 403);
  assert.equal(s.sent.length, 0);
});

test('請求本文檢查：非 JSON、太大、格式錯', async () => {
  const s = setup();
  const h = { origin: 'http://localhost' };
  assert.equal((await s.call(req('/api/auth/request-code', { method: 'POST', headers: { ...h, 'content-type': 'text/plain' }, body: 'x' }))).status, 415);
  assert.equal((await s.call(req('/api/auth/request-code', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: '{bad' }))).status, 400);
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'x'.repeat(10000) + '@a.com' }))).status, 413);
  assert.equal((await s.call(post('/api/auth/request-code', { email: 'x'.repeat(300) + '@a.com' }))).status, 400);
  assert.equal((await s.call(post('/api/auth/verify', { email: 'a@b.co', code: 'abc' }))).status, 400);
  assert.equal((await s.call(req('/api/auth/request-code'))).status, 405);
});

test('AUTH_SECRET 未設定時自動產生並存 KV；已設定時不寫', async () => {
  const s = setup();
  await s.call(post('/api/auth/request-code', { email: 'sec1@example.com' }, ip(50)));
  assert.ok(s.kv.m.has('sys:secret'));
  const s2 = setup({ AUTH_SECRET: 'fixed-secret' });
  await s2.call(post('/api/auth/request-code', { email: 'sec2@example.com' }, ip(51)));
  assert.ok(!s2.kv.m.has('sys:secret'));
});

// ───────────── 郵件服務 ─────────────
test('createMailer：未設定回 null；各 provider 的請求格式正確且金鑰只放在標頭', async () => {
  assert.equal(createMailer({}), null);
  assert.equal(createMailer({ MAIL_PROVIDER: 'brevo', BREVO_API_KEY: 'k' }), null); // 缺 MAIL_FROM
  assert.equal(createMailer({ MAIL_PROVIDER: 'brevo', MAIL_FROM: 'a@b.co' }), null); // 缺 key
  assert.equal(createMailer({ MAIL_PROVIDER: 'unknown', MAIL_FROM: 'a@b.co' }), null);

  const f = fakeFetch(() => ({}));
  const msg = { to: 'to@example.com', subject: 'S', text: 'T', html: '<b>H</b>' };
  await createMailer({ MAIL_PROVIDER: 'brevo', MAIL_FROM: 'from@example.com', BREVO_API_KEY: 'BK' }, f).send(msg);
  assert.equal(f.calls[0].url.href, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(f.calls[0].init.headers['api-key'], 'BK');
  assert.deepEqual(JSON.parse(f.calls[0].init.body).to, [{ email: 'to@example.com' }]);
  assert.ok(!f.calls[0].init.body.includes('BK'));

  await createMailer({ MAIL_PROVIDER: 'resend', MAIL_FROM: 'from@example.com', RESEND_API_KEY: 'RK' }, f).send(msg);
  assert.equal(f.calls[1].url.href, 'https://api.resend.com/emails');
  assert.equal(f.calls[1].init.headers.authorization, 'Bearer RK');
  assert.deepEqual(JSON.parse(f.calls[1].init.body).to, ['to@example.com']);

  const sentCf = [];
  const m = createMailer({ MAIL_PROVIDER: 'cloudflare', MAIL_FROM: 'from@example.com', EMAIL: { send: async (x) => sentCf.push(x) } });
  await m.send(msg);
  assert.equal(sentCf[0].to, 'to@example.com');
  assert.equal(sentCf[0].from.email, 'from@example.com');
});
