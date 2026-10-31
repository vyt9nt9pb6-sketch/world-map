// 電子郵件驗證碼登入（沒有密碼）。
//  - 驗證碼 6 位數，HMAC-SHA256 雜湊後存放（KV 內不存明碼），10 分鐘過期，最多驗證 5 次。
//  - 限流：每個 email 60 秒冷卻、每小時 5 封；每個 IP 每小時 10 封；全站每日上限（預設 200，避免超出郵件服務額度）。
//  - 登入後發 256-bit 隨機 session token（HttpOnly Cookie）；KV 只存 token 的 SHA-256。
//  - 使用者 id = HMAC(email)，收藏資料的 key 不含 email 明碼。
//  - 簽章密鑰 AUTH_SECRET：未設定時，第一次使用時自動產生並存在 KV（sys:secret），不需要手動設定。

import { HttpError, jsonNoStore, parseCookies, readJson } from './http.js';
import { sha256Hex, hmacHex, randomToken, randomCode, timingSafeEqual } from './crypto.js';
import { getKv, getJson, putJson } from './store.js';
import { createMailer } from './mail.js';
import { clientIp } from './ratelimit.js';

export const COOKIE = 'wm_session';
const CODE_TTL = 600; // 秒
const COOLDOWN = 60;
const MAX_ATTEMPTS = 5;
const SESSION_TTL = 30 * 24 * 3600;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function normalizeEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'invalid_email', '請輸入有效的電子郵件地址');
  return e;
}

export function maskEmail(email) {
  const [u, d] = email.split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(1, Math.min(4, u.length - 2)))}@${d}`;
}

async function secretOf(env, kv) {
  if (env?.AUTH_SECRET) return env.AUTH_SECRET;
  let s = await kv.get('sys:secret');
  if (!s) {
    s = randomToken(32);
    await kv.put('sys:secret', s);
    s = (await kv.get('sys:secret')) || s; // 盡量讀回，減少並發首次使用的分歧
  }
  return s;
}

const now = () => Date.now();

/** 以 KV 做時間窗計數（非原子，盡力而為）。回傳新計數。 */
async function bump(kv, key, ttl) {
  const n = Number(await kv.get(key)) || 0;
  await kv.put(key, n + 1, { ttl });
  return n + 1;
}
async function peek(kv, key) {
  return Number(await kv.get(key)) || 0;
}

export function isSecure(request) {
  return new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https';
}

export function sessionCookie(request, token, maxAge) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isSecure(request) ? '; Secure' : ''}`;
}

/** 寫入類請求的來源檢查（CSRF 縱深防禦，搭配 SameSite=Lax） */
export function assertSameOrigin(request, env) {
  const own = new URL(request.url).origin;
  const allowed = new Set([own, ...(env?.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)]);
  let origin = request.headers.get('origin');
  if (!origin) {
    const ref = request.headers.get('referer');
    try {
      origin = ref ? new URL(ref).origin : null;
    } catch {
      origin = null;
    }
  }
  if (!origin || !allowed.has(origin)) throw new HttpError(403, 'forbidden_origin', '不允許的來源');
}

export async function requestCode(ctx) {
  const { request, env, fetchImpl } = ctx;
  const mailer = ctx.mailer ?? createMailer(env, fetchImpl);
  if (!mailer) throw new HttpError(503, 'email_not_configured', '電子郵件登入尚未啟用（伺服器未設定郵件寄送服務）');
  const body = await readJson(request, 4096);
  const email = normalizeEmail(body.email);
  const kv = getKv(env);
  const secret = await secretOf(env, kv);
  const uid = await hmacHex(secret, `uid:${email}`);
  const ip = clientIp(request, ctx.remoteAddress);
  const hour = Math.floor(now() / 3600000);
  const day = Math.floor(now() / 86400000);
  const dailyMax = Number(env?.MAIL_DAILY_LIMIT) || 200;

  const tooMany = (msg, retryAfter) => new HttpError(429, 'rate_limited', msg, { retryAfter });

  const prev = await getJson(kv, `otp:${uid}`);
  if (prev && now() - prev.sentAt < COOLDOWN * 1000) {
    throw tooMany(`請稍候再重新取得驗證碼`, Math.ceil((COOLDOWN * 1000 - (now() - prev.sentAt)) / 1000));
  }
  if ((await peek(kv, `rl:e:${uid}:${hour}`)) >= 5) throw tooMany('這個信箱一小時內索取太多次，請稍後再試', 3600);
  if ((await peek(kv, `rl:i:${await sha256Hex(ip)}:${hour}`)) >= 10) throw tooMany('你的網路一小時內索取太多次，請稍後再試', 3600);
  if ((await peek(kv, `rl:g:${day}`)) >= dailyMax) throw tooMany('今天的驗證信額度已用完，請明天再試', 3600);

  const code = randomCode(6);
  await putJson(kv, `otp:${uid}`, { h: await hmacHex(secret, `otp:${uid}:${code}`), exp: now() + CODE_TTL * 1000, attempts: 0, sentAt: now() }, { ttl: CODE_TTL });
  await bump(kv, `rl:e:${uid}:${hour}`, 3600);
  await bump(kv, `rl:i:${await sha256Hex(ip)}:${hour}`, 3600);
  await bump(kv, `rl:g:${day}`, 86400);

  try {
    await mailer.send({
      to: email,
      subject: `你的登入驗證碼：${code}`,
      text: `你的地圖登入驗證碼是 ${code}\n10 分鐘內有效。若不是你本人操作，請忽略這封信。`,
      html: `<p>你的地圖登入驗證碼是</p><p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p><p>10 分鐘內有效。若不是你本人操作，請忽略這封信。</p>`,
    });
  } catch (e) {
    await kv.delete(`otp:${uid}`);
    console.error('[auth] mail send failed:', e?.name, e?.status ?? '');
    throw new HttpError(502, 'mail_failed', '驗證信寄送失敗，請稍後再試');
  }
  return jsonNoStore({ ok: true, expiresIn: CODE_TTL, cooldown: COOLDOWN });
}

export async function verifyCode(ctx) {
  const { request, env } = ctx;
  const body = await readJson(request, 4096);
  const email = normalizeEmail(body.email);
  const code = String(body.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'invalid_code', '驗證碼是 6 位數字');
  const kv = getKv(env);
  const secret = await secretOf(env, kv);
  const uid = await hmacHex(secret, `uid:${email}`);
  const rec = await getJson(kv, `otp:${uid}`);
  const bad = () => new HttpError(401, 'wrong_code', '驗證碼不正確或已過期');
  if (!rec || rec.exp <= now()) {
    if (rec) await kv.delete(`otp:${uid}`);
    throw bad();
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    await kv.delete(`otp:${uid}`);
    throw new HttpError(429, 'too_many_attempts', '錯誤次數太多，請重新取得驗證碼');
  }
  const ok = timingSafeEqual(rec.h, await hmacHex(secret, `otp:${uid}:${code}`));
  if (!ok) {
    rec.attempts += 1;
    if (rec.attempts >= MAX_ATTEMPTS) await kv.delete(`otp:${uid}`);
    else await putJson(kv, `otp:${uid}`, rec, { ttl: Math.max(60, Math.ceil((rec.exp - now()) / 1000)) });
    throw bad();
  }
  await kv.delete(`otp:${uid}`); // 一次性
  const token = randomToken(32);
  await putJson(kv, `sess:${await sha256Hex(token)}`, { uid, email, created: now() }, { ttl: SESSION_TTL });
  return jsonNoStore({ ok: true, user: { email } }, 200, { 'set-cookie': sessionCookie(request, token, SESSION_TTL) });
}

/** 取得目前登入者；未登入回傳 null */
export async function currentUser(request, env) {
  const token = parseCookies(request)[COOKIE];
  if (!token || token.length < 20 || token.length > 100) return null;
  const kv = getKv(env);
  const s = await getJson(kv, `sess:${await sha256Hex(token)}`);
  return s ? { uid: s.uid, email: s.email } : null;
}

export async function logout(ctx) {
  const { request, env } = ctx;
  const token = parseCookies(request)[COOKIE];
  if (token) await getKv(env).delete(`sess:${await sha256Hex(token)}`);
  return jsonNoStore({ ok: true }, 200, { 'set-cookie': sessionCookie(request, '', 0) });
}

export async function me(ctx) {
  const u = await currentUser(ctx.request, ctx.env);
  return jsonNoStore({ user: u ? { email: u.email } : null });
}
