// 公交／火車路線的 HTML 產生器（純字串函式，輸出已跳脫，方便測試）。
import { formatDistance, formatDuration } from './format.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICON = { walk: '🚶', bus: '🚌', subway: '🚇', train: '🚆' };

/** 一條公交方案的卡片摘要：例如「🚆 D5433 → 🚇 地鐵1號線」 */
export function transitSummary(route) {
  const parts = route.segments
    .filter((s) => s.type !== 'walk')
    .map((s) => `${ICON[s.type] || ''} ${esc(s.type === 'train' ? s.trip : shortLine(s.name))}`);
  return parts.length ? parts.join(' → ') : '步行';
}

export function shortLine(name) {
  return String(name || '').replace(/\(.*$/, '').replace(/（.*$/, '');
}

function trainSegment(s) {
  const lm = s.lineMatch;
  const lineNames = lm ? [...new Set(lm.sections.map((x) => x.line).filter(Boolean))] : [];
  const stopsHtml = s.stops
    .map((p) => {
      const cls = p.role === 'via' ? 'via' : 'end';
      const dwell = p.role === 'via' && p.wait ? `<em>停 ${esc(p.wait)} 分</em>` : '';
      return `<li class="${cls}"><span class="t">${esc(p.time || '')}</span><span class="n">${esc(p.name)}</span>${dwell}</li>`;
    })
    .join('');
  const lineHtml = lm
    ? lineNames.length
      ? `<div class="line-name">鐵路線：${lineNames.map(esc).join(' → ')} <span class="est">推測線路</span></div>`
      : '<div class="line-name"><span class="est">推測線路：資料庫中找不到對應</span></div>'
    : '';
  const passed = lm ? [...new Set(lm.sections.flatMap((x) => x.lineStations || []))] : [];
  const passedHtml = passed.length ? `<details class="passed"><summary>沿線未停靠站 ${passed.length} 個</summary><p>${passed.map(esc).join('、')}</p></details>` : '';
  const prices = s.prices && Object.keys(s.prices).length ? `<div class="prices">${Object.entries(s.prices).map(([k, v]) => `${esc(k)} ¥${esc(v)}`).join('　')}</div>` : '';
  const alters = s.alters?.length ? `<div class="alters">同區間其他車次：${s.alters.map(esc).join('、')}</div>` : '';
  return `<div class="seg train"><div class="seg-head">${ICON.train} <b>${esc(s.trip)}</b> <span class="muted">${esc(s.trainType || '')}</span><span class="dist">${formatDuration(s.duration)}</span></div>
    ${lineHtml}<ol class="stoplist">${stopsHtml}</ol>${passedHtml}${prices}${alters}</div>`;
}

export function transitDetail(route) {
  return route.segments
    .map((s) => {
      if (s.type === 'walk') return `<div class="seg walk">${ICON.walk} 步行 ${formatDistance(s.distance)}・${formatDuration(s.duration)}</div>`;
      if (s.type === 'train') return trainSegment(s);
      const via = s.viaStops?.length ? `<details class="passed"><summary>途經 ${s.viaStops.length} 站</summary><p>${s.viaStops.map((v) => esc(v.name)).join('、')}</p></details>` : '';
      const times = s.startTime && s.endTime ? `<span class="muted">首末班 ${esc(s.startTime)}–${esc(s.endTime)}</span>` : '';
      return `<div class="seg ${esc(s.type)}"><div class="seg-head">${ICON[s.type] || ''} <b>${esc(s.name)}</b>${times}</div>
        <div class="muted">${esc(s.from?.name || '')} → ${esc(s.to?.name || '')}・${formatDistance(s.distance)}・${formatDuration(s.duration)}</div>${via}</div>`;
    })
    .join('');
}
