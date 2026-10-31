// 收藏：每位使用者一份，存在 KV（fav:{uid}）。同步採「逐筆合併」：
// 每個項目有 updatedAt（毫秒）；同一 id 取較新的；刪除以 deleted:true 墓碑表示（保留 30 天，讓其他裝置也能刪掉）。

import { HttpError, jsonNoStore, readJson } from './http.js';
import { getKv, getJson, putJson } from './store.js';
import { currentUser } from './auth.js';

export const MAX_ITEMS = 500;
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

/** 驗證並整理單筆；無效就丟 400 */
export function cleanItem(raw, nowMs = Date.now()) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'invalid_item', '收藏資料格式錯誤');
  const id = str(raw.id, 64);
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new HttpError(400, 'invalid_item', '收藏編號格式錯誤');
  const lng = Number(raw.lng);
  const lat = Number(raw.lat);
  const deleted = raw.deleted === true;
  if (!deleted && !(Number.isFinite(lng) && Number.isFinite(lat) && lng >= 70 && lng <= 140 && lat >= 0 && lat <= 60)) {
    throw new HttpError(400, 'invalid_item', '收藏座標超出範圍');
  }
  let updatedAt = Number(raw.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) updatedAt = nowMs;
  updatedAt = Math.min(updatedAt, nowMs + 5 * 60 * 1000); // 不接受未來太遠的時間（避免時鐘錯誤的裝置永遠贏）
  if (deleted) return { id, deleted: true, updatedAt };
  return {
    id,
    name: str(raw.name, 100) || '未命名地點',
    address: str(raw.address, 200),
    note: str(raw.note, 300),
    lng: +lng.toFixed(6),
    lat: +lat.toFixed(6),
    adcode: /^\d{6}$/.test(String(raw.adcode ?? '')) ? String(raw.adcode) : '',
    createdAt: Number.isFinite(Number(raw.createdAt)) ? Number(raw.createdAt) : updatedAt,
    updatedAt,
  };
}

export function mergeItems(serverItems, clientItems, nowMs = Date.now()) {
  const map = new Map();
  for (const it of serverItems) map.set(it.id, it);
  for (const it of clientItems) {
    const cur = map.get(it.id);
    if (!cur || it.updatedAt > cur.updatedAt) map.set(it.id, it);
  }
  const all = [...map.values()].filter((it) => !(it.deleted && nowMs - it.updatedAt > TOMBSTONE_MS));
  const live = all.filter((it) => !it.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  if (live.length > MAX_ITEMS) throw new HttpError(413, 'too_many', `收藏最多 ${MAX_ITEMS} 筆`);
  return [...live, ...all.filter((it) => it.deleted)];
}

async function requireUser(ctx) {
  const u = await currentUser(ctx.request, ctx.env);
  if (!u) throw new HttpError(401, 'login_required', '請先登入');
  return u;
}

export async function getFavorites(ctx) {
  const u = await requireUser(ctx);
  const data = await getJson(getKv(ctx.env), `fav:${u.uid}`);
  return jsonNoStore({ items: data?.items ?? [], serverTime: Date.now() });
}

export async function syncFavorites(ctx) {
  const u = await requireUser(ctx);
  const body = await readJson(ctx.request, 256 * 1024);
  if (!Array.isArray(body.items)) throw new HttpError(400, 'invalid_item', '缺少 items');
  if (body.items.length > MAX_ITEMS * 2) throw new HttpError(413, 'too_many', '資料太多');
  const nowMs = Date.now();
  const incoming = body.items.map((x) => cleanItem(x, nowMs));
  const kv = getKv(ctx.env);
  const cur = (await getJson(kv, `fav:${u.uid}`))?.items ?? [];
  const merged = mergeItems(cur, incoming, nowMs);
  await putJson(kv, `fav:${u.uid}`, { items: merged, updatedAt: nowMs });
  return jsonNoStore({ items: merged, serverTime: nowMs });
}
