// 地點頁（Apple 地圖風格）與「搜尋此區域」用的純函式：輸出的 HTML 都已跳脫，方便測試。
import { esc } from './transit-view.js';
import { formatDistance } from './format.js';

/** 高德的電話欄位可能是「a;b」，也可能重複 */
export function splitTels(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[;；,，]/);
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
}

/** tel: 連結只留下數字與 + - * # ，其他字元（空白、括號）拿掉；沒有數字就不產生連結 */
export function telHref(tel) {
  const d = String(tel ?? '').replace(/[^\d+*#]/g, '');
  return /\d/.test(d) ? `tel:${d}` : '';
}

/** 只接受 https 圖片（資料來源是高德，CSP 只放行高德網域） */
export function safeImg(u) {
  const s = String(u ?? '').trim().replace(/^http:\/\//i, 'https://').replace(/^\/\//, 'https://');
  try {
    const url = new URL(s);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export const categoryOf = (type) => String(type ?? '').split(';').filter(Boolean).slice(-1)[0] || '';

/** 標題下的一行：類別 · 距離 */
export function subLine(d, distance) {
  const parts = [categoryOf(d?.type)];
  if (distance != null && Number.isFinite(distance)) parts.push(formatDistance(distance));
  return parts.filter(Boolean).join(' · ');
}

/** 評分／人均／今日營業時間的小膠囊 */
export function badgesHtml(d) {
  const out = [];
  if (d?.rating != null) out.push(`<span class="badge rate"><b>★</b> ${esc(Number(d.rating).toFixed(1))}</span>`);
  if (d?.cost != null && d.cost > 0) out.push(`<span class="badge">人均 ¥${esc(Math.round(d.cost))}</span>`);
  if (d?.openToday) out.push(`<span class="badge open">今日 ${esc(d.openToday)}</span>`);
  return out.join('');
}

export function photosHtml(photos) {
  const list = (photos ?? []).map((p) => ({ url: safeImg(p.url ?? p), title: p.title || '' })).filter((p) => p.url).slice(0, 8);
  return list
    .map((p) => `<a class="ph" href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(p.title || '照片')}" loading="lazy" decoding="async" referrerpolicy="no-referrer" /></a>`)
    .join('');
}

/** 資訊列：[標籤, HTML]。沒有資料的欄位不顯示（不是每種商家都有評分／營業時間／照片）。 */
export function infoRows(d, { address, distance, lat, lng } = {}) {
  const rows = [];
  const tels = splitTels(d?.tels?.length ? d.tels : d?.tel);
  if (tels.length) {
    rows.push(['電話', tels.map((t) => (telHref(t) ? `<a href="${esc(telHref(t))}">${esc(t)}</a>` : esc(t))).join('<br>')]);
  }
  if (d?.openToday || d?.openWeek) {
    const week = d.openWeek && d.openWeek !== d.openToday ? `<details class="week"><summary>每週時間</summary>${esc(d.openWeek).replace(/;|；/g, '<br>')}</details>` : '';
    rows.push(['營業時間', `${d.openToday ? `今日 ${esc(d.openToday)}` : ''}${week}`]);
  }
  if (d?.cost != null && d.cost > 0) rows.push(['人均', `¥${esc(Math.round(d.cost))}`]);
  if (d?.businessArea) rows.push(['商圈', esc(d.businessArea)]);
  if (d?.parking) rows.push(['停車', esc(d.parking)]);
  if (address) rows.push(['地址', esc(address)]);
  if (distance != null && Number.isFinite(distance)) rows.push(['距離你', esc(formatDistance(distance))]);
  if (lat != null && lng != null) rows.push(['座標', `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`]);
  return rows;
}

/**
 * 目前畫面可視範圍的半徑（公尺），給「搜尋此區域」用。Web Mercator：公尺／像素 = 156543.034 × cos(緯度) ÷ 2^zoom。
 * 取可視區較短邊的一半；限制在高德周邊搜尋允許的 300–50000 公尺。
 */
export function viewportRadius({ zoom, lat, width, height }) {
  const mpp = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
  const r = 0.5 * Math.min(width, height) * mpp;
  return Math.max(300, Math.min(50000, Math.round(r)));
}

/** 地圖移動後要不要重新搜尋：中心位移超過半徑的 25%，或縮放改變 0.5 級以上（保護高德額度，小動作不重查） */
export function movedEnough(prev, cur, distanceFn) {
  if (!prev) return true;
  if (Math.abs(prev.zoom - cur.zoom) >= 0.5) return true;
  return distanceFn(prev.center, cur.center) > 0.25 * prev.radius;
}
