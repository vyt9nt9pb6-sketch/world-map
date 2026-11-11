// 駕車多路線卡片的純函式（輸出已跳脫）。
import { esc } from './transit-view.js';
import { formatDistance, formatDuration, formatYuan } from './format.js';
export const TAG_LABEL = {
  recommend: '推薦',
  fastest: '最快',
  shortest: '最短距離',
  leastToll: '少收費',
  leastLights: '紅綠燈最少',
};
export const TAG_ORDER = ['recommend', 'fastest', 'shortest', 'leastToll', 'leastLights'];

export function tagsHtml(tags = []) {
  return TAG_ORDER.filter((t) => tags.includes(t))
    .map((t) => `<span class="tag t-${t}">${TAG_LABEL[t]}</span>`)
    .join('');
}

/** 預計抵達時刻（以使用者裝置時區顯示）。departSec 是 epoch 秒，沒有就用現在。 */
export function etaText(durationSec, departSec) {
  if (!Number.isFinite(durationSec)) return '';
  const base = departSec ? departSec * 1000 : Date.now();
  const d = new Date(base + durationSec * 1000);
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return `${sameDay ? '' : `${d.getMonth() + 1}/${d.getDate()} `}${p(d.getHours())}:${p(d.getMinutes())} 抵達`;
}

/**
 * 駕車卡片。fuel：{ cost: number|null, type: 'gas'|'ev', total: number|null }（由 app.js 依使用者偏好算好傳入）。
 * cost＝能源費（油費或電費，依 type 決定字樣）；total＝能源費＋過路費合計。沒有就顯示「—」並附說明。
 */
export function drivingCardHtml(r, { departSec = null, fuel = null } = {}) {
  const meta = [];
  if (r.roads?.length) meta.push('經 ' + r.roads.slice(0, 4).join('、'));
  if (r.tollDistance) meta.push(`收費路段 ${formatDistance(r.tollDistance)}`);
  if (r.trafficLights) meta.push(`紅綠燈 ${r.trafficLights} 個`);
  const straight = r.straightDistance
    ? `直線 ${formatDistance(r.straightDistance)}${r.detour ? ` · 繞行 ${r.detour.toFixed(2)} 倍` : ''}`
    : '';
  const costLine = fuel
    ? `${fuel.type === 'ev' ? '電費' : '油費'} ${formatYuan(fuel.cost)}`
    : '';
  const totalLine = fuel?.total != null ? `合計約 ¥${Math.round(fuel.total)}（${fuel.type === 'ev' ? '電費' : '油費'}＋過路費，估算）` : '';
  return `<div class="top"><span class="dur">${esc(formatDuration(r.duration))}</span><span class="dist">${esc(formatDistance(r.distance))}</span>
    <span class="toll">過路費 ${esc(formatYuan(r.tolls))}${costLine ? ` · <span class="fuel">${esc(costLine)}</span>` : ''}</div>
    ${r.tags?.length ? `<div class="tags">${tagsHtml(r.tags)}</div>` : ''}
    <div class="meta">${esc(etaText(r.duration, departSec))}${straight ? ` · ${esc(straight)}` : ''}</div>
    <div class="meta">${esc(meta.join(' · '))}</div>
    ${totalLine ? `<div class="meta total">${esc(totalLine)}</div>` : ''}
    ${r.restriction ? '<div class="warn">⚠ 此路線有無法避開的限行路段</div>' : ''}`;
}

/** 地圖上掛在路線中點的小標籤（時間＋距離），點一下選擇該路線 */
export function routeLabelHtml(r, selected) {
  const t = r.tags?.includes('shortest') ? '最短' : r.tags?.includes('fastest') ? '最快' : '';
  return `<div class="route-label${selected ? ' sel' : ''}"><b>${esc(formatDuration(r.duration))}</b><span>${esc(formatDistance(r.distance))}${t ? ` · ${t}` : ''}</span></div>`;
}

/** 折線中點（以累積距離的一半，近似即可） */
export function midPoint(path, frac = 0.5) {
  if (!path?.length) return null;
  let total = 0;
  const seg = [];
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let half = total * frac;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) {
      const t = seg[i] ? Math.min(1, half / seg[i]) : 0;
      return { lng: path[i][0] + (path[i + 1][0] - path[i][0]) * t, lat: path[i][1] + (path[i + 1][1] - path[i][1]) * t };
    }
    half -= seg[i];
  }
  return { lng: path[0][0], lat: path[0][1] };
}

/** 快速選擇：回傳存在的標籤對應的路線索引 */
export function quickPicks(routes) {
  const picks = [];
  for (const t of ['fastest', 'shortest', 'leastToll']) {
    const i = routes.findIndex((r) => r.tags?.includes(t));
    if (i >= 0) picks.push({ tag: t, label: TAG_LABEL[t], index: i });
  }
  return routes.length > 1 ? picks : [];
}
