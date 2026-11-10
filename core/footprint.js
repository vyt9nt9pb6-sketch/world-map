// 我的足跡：只屬於目前登入者的位置紀錄，存在 KV（fp:{uid}）。
// uid 來自 session（HMAC），客戶端不能指定使用者。沒有任何「列出所有人」或帶 user id 的公開路由。
// 瀏覽器定位是 WGS-84，這裡原樣保存；畫到高德地圖時由前端轉成 GCJ-02（中國境外不轉）。
// 伺服器無法證明座標真的來自 GPS，只能保證讀寫都綁在同一個人的 session 上。

import { HttpError, jsonNoStore, readJson } from './http.js';
import { getKv, getJson, putJson } from './store.js';
import { currentUser } from './auth.js';

export const MAX_POINTS = 3000;
export const MAX_BATCH = 40;
export const MAX_WRITES_PER_HOUR = 180;
const DEDUPE_MS = 15000;
const DEDUPE_M = 20;

function meters(a, b) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

async function requireUser(ctx) {
  const u = await currentUser(ctx.request, ctx.env);
  if (!u) throw new HttpError(401, 'login_required', '請先登入才能使用足跡');
  return u;
}

/** 整理單點。無效就 400。時間在未來超過 5 分鐘的，改記伺服器現在。 */
export function cleanPoint(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'invalid_point', '位置格式錯誤');
  const lng = Number(raw.lng);
  const lat = Number(raw.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -85 || lat > 85) {
    throw new HttpError(400, 'invalid_point', '座標超出範圍');
  }
  let t = Number(raw.t);
  if (!Number.isFinite(t)) t = nowMs;
  if (t > nowMs + 5 * 60 * 1000) t = nowMs;
  const oldest = nowMs - 10 * 365.25 * 24 * 3600 * 1000;
  if (t < oldest) throw new HttpError(400, 'invalid_point', '時間超出可保存範圍');
  return { lng: +lng.toFixed(5), lat: +lat.toFixed(5), t: Math.round(t) };
}

/** 依時間排序、去掉幾乎同一點的抖動、只留最近 MAX_POINTS 筆。 */
export function mergePoints(existing, incoming) {
  const all = [];
  for (const p of existing || []) {
    if (p && Number.isFinite(p.lng) && Number.isFinite(p.lat) && Number.isFinite(p.t)) all.push(p);
  }
  for (const p of incoming || []) all.push(p);
  all.sort((a, b) => a.t - b.t || a.lng - b.lng);
  const out = [];
  for (const p of all) {
    const prev = out[out.length - 1];
    if (prev && p.t - prev.t < DEDUPE_MS && meters(prev, p) < DEDUPE_M) continue;
    if (prev && prev.t === p.t && prev.lng === p.lng && prev.lat === p.lat) continue;
    out.push({ lng: p.lng, lat: p.lat, t: p.t });
  }
  return out.length > MAX_POINTS ? out.slice(out.length - MAX_POINTS) : out;
}

function payload(points) {
  return { points, count: points.length };
}

export async function getFootprint(ctx) {
  const u = await requireUser(ctx);
  const data = await getJson(getKv(ctx.env), `fp:${u.uid}`);
  const points = Array.isArray(data?.points) ? data.points : [];
  return jsonNoStore(payload(points));
}

export async function postFootprint(ctx) {
  const u = await requireUser(ctx);
  const body = await readJson(ctx.request, 16 * 1024);
  const rawList = Array.isArray(body.points) ? body.points : body.lng != null ? [body] : null;
  if (!rawList || !rawList.length) throw new HttpError(400, 'invalid_point', '缺少位置');
  if (rawList.length > MAX_BATCH) throw new HttpError(413, 'too_many', `一次最多 ${MAX_BATCH} 個位置`);
  const nowMs = Date.now();
  const incoming = rawList.map((p) => cleanPoint(p, nowMs));

  const kv = getKv(ctx.env);
  const hour = Math.floor(nowMs / 3600000);
  const rlKey = `fp:rl:${u.uid}:${hour}`;
  const n = (Number(await kv.get(rlKey)) || 0) + 1;
  await kv.put(rlKey, String(n), { ttl: 7200 });
  if (n > MAX_WRITES_PER_HOUR) throw new HttpError(429, 'rate_limited', '足跡上傳太頻繁，請稍後再試', { retryAfter: 60 });

  const cur = (await getJson(kv, `fp:${u.uid}`))?.points ?? [];
  const points = mergePoints(cur, incoming);
  await putJson(kv, `fp:${u.uid}`, { points, updatedAt: nowMs });
  return jsonNoStore(payload(points));
}

export async function deleteFootprint(ctx) {
  const u = await requireUser(ctx);
  await getKv(ctx.env).delete(`fp:${u.uid}`);
  return jsonNoStore({ ok: true, ...payload([]) });
}
