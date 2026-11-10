// 我的足跡（用戶端純函式）。定位是 WGS-84；熱力圖要畫在高德上，所以投影成 GCJ-02。
// 網頁只能在這個分頁開著、而且多半要在前景時拿到定位。背景與關掉頁面都不會繼續記。
import { haversine } from './coords.js';

export const FOOT_RANGES = [
  { id: 'day', label: '今天' },
  { id: '7d', label: '7 天', ms: 7 * 86400000 },
  { id: '30d', label: '30 天', ms: 30 * 86400000 },
  { id: 'all', label: '全部' },
];

export const FOOT_PRIVACY =
  '足跡只存在你登入的帳號裡，不會出現在公開介面，其他使用者也看不到。可以隨時全部清除。';

export const FOOT_BACKGROUND =
  '只有這個頁面開著、而且在前景時才會記錄。瀏覽器不能在背景或關掉網頁後繼續定位，這不是 App。';

/** 依時間篩選。今天＝本機時區的今天 0:00 起。 */
export function filterPoints(points, rangeId, now = Date.now()) {
  const list = Array.isArray(points) ? points : [];
  if (rangeId === 'all') return list.slice();
  if (rangeId === 'day') {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const t0 = start.getTime();
    return list.filter((p) => p && p.t >= t0 && p.t <= now + 60000);
  }
  const spec = FOOT_RANGES.find((r) => r.id === rangeId);
  const ms = spec?.ms;
  if (!ms) return list.slice();
  const t0 = now - ms;
  return list.filter((p) => p && p.t >= t0 && p.t <= now + 60000);
}

/**
 * 是否該把這個定位送出去。
 * 第一次一定記；之後至少隔 8 秒，而且要移動 40 公尺或已過 30 秒（停留也要累積熱度）。
 */
export function shouldRecord(last, next, now = Date.now()) {
  if (!next || !Number.isFinite(next.lng) || !Number.isFinite(next.lat)) return false;
  if (!last) return true;
  const dt = now - (last.t || 0);
  if (dt < 8000) return false;
  const dist = haversine(last.lng, last.lat, next.lng, next.lat);
  if (dist >= 40) return true;
  return dt >= 30000;
}

/**
 * 轉成高德熱力圖資料。project(lng,lat) → [lng,lat]（中國境內 WGS→GCJ）。
 * 約 100 公尺聚合，count 是你在那一格被記到的次數（停留越久越熱）。
 */
export function toHeatData(points, project) {
  const bins = new Map();
  for (const p of points || []) {
    if (!Number.isFinite(p.lng) || !Number.isFinite(p.lat)) continue;
    const [lng, lat] = project(p.lng, p.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    const key = `${lng.toFixed(3)},${lat.toFixed(3)}`;
    const hit = bins.get(key);
    if (hit) hit.count += 1;
    else bins.set(key, { lng: +lng.toFixed(6), lat: +lat.toFixed(6), count: 1 });
  }
  const data = [...bins.values()];
  const peak = data.reduce((m, d) => Math.max(m, d.count), 1);
  return { data, max: Math.max(2, Math.min(peak, 16)) };
}

export function footprintGradient() {
  return {
    0.25: '#355CFF',
    0.45: '#00C8F0',
    0.65: '#7DDE2A',
    0.82: '#FFC400',
    1: '#E10600',
  };
}
