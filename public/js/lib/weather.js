// 天氣顯示（純函式，輸出已跳脫，方便測試）。
// 資料來源：後端 /api/weather（Open-Meteo，CC BY 4.0）。WMO weather code 是 Open-Meteo 的官方編碼。
// 時間約定：daily.date／hourly.time 是「地點當地時間」的字串（Open-Meteo timezone=auto）；
// 主要使用情境（人在當地查當地）與裝置時區一致。若裝置時區與地點不同，「現在／明天」的判斷可能偏差幾小時，屬可接受誤差。
import { esc } from './transit-view.js';

/** WMO weather code → [emoji, 繁中標籤]。未知代碼顯示「—」。 */
const WMO = {
  0: ['☀️', '晴'],
  1: ['🌤️', '大致晴朗'],
  2: ['⛅', '局部多雲'],
  3: ['☁️', '陰天'],
  45: ['🌫️', '霧'],
  48: ['🌫️', '霧（凝霜）'],
  51: ['🌦️', '小毛毛雨'],
  53: ['🌦️', '毛毛雨'],
  55: ['🌧️', '濃毛毛雨'],
  56: ['🌧️', '凍毛毛雨'],
  57: ['🌧️', '濃凍毛毛雨'],
  61: ['🌦️', '小雨'],
  63: ['🌧️', '中雨'],
  65: ['🌧️', '大雨'],
  66: ['🌧️', '凍雨'],
  67: ['🌧️', '強凍雨'],
  71: ['🌨️', '小雪'],
  73: ['🌨️', '中雪'],
  75: ['❄️', '大雪'],
  77: ['🌨️', '雪粒'],
  80: ['🌦️', '小陣雨'],
  81: ['🌧️', '陣雨'],
  82: ['🌧️', '強陣雨'],
  85: ['🌨️', '陣雪'],
  86: ['❄️', '強陣雪'],
  95: ['⛈️', '雷雨'],
  96: ['⛈️', '雷雨伴冰雹'],
  99: ['⛈️', '強雷雨伴冰雹'],
};

export function wmoLabel(code) {
  // 注意 Number(null) === 0（會誤判成「晴」）：null／空字串一律視為未知
  const n = code == null || code === '' ? NaN : Number(code);
  const e = Number.isFinite(n) ? WMO[n] : undefined;
  return e ? { emoji: e[0], label: e[1] } : { emoji: '🌡️', label: '天氣資料' };
}

const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 裝置的「今天」日期字串（YYYY-MM-DD）。 */
export function localDateStr(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** daily.date（YYYY-MM-DD）→ 今天／明天／後天／週幾 */
export function dayLabel(dateStr, today = localDateStr()) {
  const diff = Math.round((Date.parse(dateStr) - Date.parse(today)) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '後天';
  const d = new Date(dateStr + 'T12:00');
  return Number.isFinite(d.getTime()) ? WEEK[d.getDay()] : dateStr.slice(5);
}

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const t = (x) => (num(x) == null ? '—' : `${Math.round(x)}°`);
const pct = (x) => (num(x) == null ? '' : `${Math.round(x)}%`);

/** 地點頁的天氣卡：現在天氣＋未來幾天（daily 前端只顯示 3 天）。輸出空字串＝沒有可顯示的資料。 */
export function weatherCardHtml(w, { days = 3 } = {}) {
  if (!w || (!w.current && !(w.daily || []).length)) return '';
  const c = w.current;
  const cur = wmoLabel(c?.code);
  const nowParts = [];
  if (c?.apparent != null) nowParts.push(`體感 ${Math.round(c.apparent)}°`);
  if (c?.humidity != null) nowParts.push(`濕度 ${Math.round(c.humidity)}%`);
  if (c?.wind != null) nowParts.push(`風 ${Math.round(c.wind)} km/h`);
  if (c?.precipitation != null && c.precipitation > 0) nowParts.push(`降水 ${c.precipitation} mm`);
  const rows = (w.daily || []).slice(0, days).map((d) => {
    const l = wmoLabel(d.code);
    return `<div class="wx-day"><span>${esc(dayLabel(d.date))}</span><i aria-hidden="true">${l.emoji}</i>
      <b>${esc(t(d.tMin))}/${esc(t(d.tMax))}</b><small>${esc(pct(d.precipProb))}</small><em title="${esc(l.label)}">${esc(l.label)}</em></div>`;
  });
  return `<div class="wx-card card">
    ${c ? `<div class="wx-now"><i class="wx-emoji" aria-hidden="true">${cur.emoji}</i>
      <b class="wx-temp">${esc(t(c.temperature))}<small>${esc(cur.label)}</small></b>
      <span class="wx-meta">${esc(nowParts.join('・'))}</span></div>` : ''}
    ${rows.length ? `<div class="wx-days">${rows.join('')}</div>` : ''}
    <p class="muted small wx-attr">天氣為 Open-Meteo 模式估計（誤差可能數 °C）${w.updatedAt ? `・觀測時間 ${esc(String(w.updatedAt).slice(11, 16))}` : ''}</p>
  </div>`;
}

/** hourly 清單中找最接近指定時刻（epoch 毫秒）的一筆。時間字串是地點當地時間，Date.parse 以裝置時區解析。 */
export function hourlyAt(hourly, atMs) {
  if (!Array.isArray(hourly) || !hourly.length) return null;
  let best = null;
  let bestDiff = Infinity;
  for (const h of hourly) {
    const ms = Date.parse(h.time);
    if (!Number.isFinite(ms)) continue;
    const diff = Math.abs(ms - atMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = h;
    }
  }
  return best;
}

/** 路線頁「抵達時天氣」摘要（一行）。沒有可用資料回空字串。 */
export function arrivalWeatherHtml(hourly, etaMs) {
  const h = hourlyAt(hourly, etaMs);
  if (!h || h.temperature == null) return '';
  const l = wmoLabel(h.code);
  const parts = [`抵達時約 ${Math.round(h.temperature)}°C ${l.emoji} ${l.label}`];
  if (h.precipProb != null && h.precipProb >= 30) parts.push(`降水機率 ${Math.round(h.precipProb)}%`);
  return `<div class="wx-arrive">${esc(parts.join('・'))}</div>`;
}
