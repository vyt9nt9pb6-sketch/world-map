// 油費／電費估算（純函式，方便測試）。
// 誠實說明：油價與電價因地區、時間而異，這裡的預設值只是參考，使用者可在「路線選項」裡改成自己車子的實際數值。
// 計算是線性的：費用 = 距離 ÷ 100 × 百公里能耗 × 單價。實際油耗會隨路況（高速／市區）、氣溫（空調）而不同，結果僅供參考。

export const FUEL_KEY = 'wm.fuel.v42';

/** 預設：油車 8.0 L/100km、92 參考價 ¥7.50/L；電車 14 kWh/100km、公共快充參考價 ¥1.20/kWh。 */
export const FUEL_DEFAULTS = Object.freeze({ type: 'gas', consumption: 8, price: 7.5 });
export const EV_DEFAULTS = Object.freeze({ type: 'ev', consumption: 14, price: 1.2 });

const clamp = (n, lo, hi, def) => (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : def);

/** 讀 localStorage 的偏好；損壞或缺失時回預設值（不丟例外）。 */
export function loadFuelPrefs(get = (k) => localStorage.getItem(k)) {
  let o = {};
  try {
    o = JSON.parse(get(FUEL_KEY) || '{}') || {};
  } catch {
    o = {};
  }
  const type = o.type === 'ev' ? 'ev' : 'gas';
  const def = type === 'ev' ? EV_DEFAULTS : FUEL_DEFAULTS;
  return { type, consumption: clamp(Number(o.consumption), 0.5, 99, def.consumption), price: clamp(Number(o.price), 0.01, 99, def.price) };
}

export function saveFuelPrefs(p, set = (k, v) => localStorage.setItem(k, v)) {
  try {
    set(FUEL_KEY, JSON.stringify({ type: p.type, consumption: p.consumption, price: p.price }));
  } catch {
    /* 無痕模式 */
  }
}

/** 估算能耗費用。distance 單位公尺。回傳 null＝無法計算（缺距離或參數；注意 Number(null)===0 的坑）。 */
export function energyCost(distanceMeters, { type = 'gas', consumption, price } = {}) {
  if (distanceMeters == null) return null;
  const km = Number(distanceMeters) / 1000;
  const c = Number(consumption);
  const p = Number(price);
  if (!Number.isFinite(km) || km < 0 || !Number.isFinite(c) || c <= 0 || !Number.isFinite(p) || p <= 0) return null;
  return (km / 100) * c * p;
}

/** 駕車卡片「能源費＋過路費」合計。tolls 為 null（高德沒給）時只顯示能源費。注意 null 要先排除（Number(null)===0）。 */
export function totalTripCost(fuelCost, tolls) {
  const fin = (x) => (x == null ? null : Number(x));
  const f = fin(fuelCost);
  const t2 = fin(tolls);
  const hasF = f != null && Number.isFinite(f);
  const hasT = t2 != null && Number.isFinite(t2) && t2 >= 0;
  if (!hasF && !hasT) return null;
  return (hasF ? f : 0) + (hasT ? t2 : 0);
}

/** 設定摘要（路線選項 summary 顯示用），例如「油車 8.0L/100km・¥7.5/L」。 */
export function fuelSummary({ type, consumption, price } = {}) {
  if (type === 'ev') return `電車 ${consumption} kWh/100km・¥${price}/kWh`;
  return `油車 ${consumption} L/100km・¥${price}/L`;
}
