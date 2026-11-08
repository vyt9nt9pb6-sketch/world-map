// v4.2 前端測試：油費／電費估算（fuel.js）、天氣顯示（weather.js）、駕車卡片的能耗行。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { energyCost, totalTripCost, fuelSummary, loadFuelPrefs, saveFuelPrefs, FUEL_DEFAULTS, EV_DEFAULTS, FUEL_KEY } from '../public/js/lib/fuel.js';
import { wmoLabel, dayLabel, localDateStr, hourlyAt, weatherCardHtml, arrivalWeatherHtml } from '../public/js/lib/weather.js';
import { drivingCardHtml } from '../public/js/lib/route-view.js';

const R = (o) => ({ duration: 3600, distance: 100000, tolls: 60, steps: [], polyline: [[1, 1], [2, 2]], ...o });

test('energyCost：油費＝距離 ÷100 × 油耗 × 油價（公尺輸入）；電費同式', () => {
  // 100 km、8 L/100km、¥7.5/L → 8 × 7.5 = ¥60
  assert.equal(energyCost(100000, { consumption: 8, price: 7.5 }), 60);
  // 230 km、6.2 L/100km、¥7.88/L → 2.3 × 6.2 × 7.88 = ¥112.3688（容差 1e-9）
  assert.ok(Math.abs(energyCost(230000, { consumption: 6.2, price: 7.88 }) - 2.3 * 6.2 * 7.88) < 1e-9);
  // 電車：100 km、14 kWh、¥1.2/kWh → ¥16.8
  assert.equal(energyCost(100000, { type: 'ev', consumption: 14, price: 1.2 }), 16.8);
  assert.equal(energyCost(null, { consumption: 8, price: 7.5 }), null);
  assert.equal(energyCost(100000, { consumption: 0, price: 7.5 }), null);
  assert.equal(energyCost(100000, { consumption: 8, price: -1 }), null);
  assert.equal(energyCost(100000, {}), null);
});

test('totalTripCost：油費＋過路費；過路費 null（高德沒給）時只算油費；都沒有 → null', () => {
  assert.equal(totalTripCost(60, 40), 100);
  assert.equal(totalTripCost(60, null), 60);
  assert.equal(totalTripCost(null, 40), 40);
  assert.equal(totalTripCost(null, null), null);
  assert.equal(totalTripCost(60, 0), 60);
});

test('fuelSummary：油車/電車的字樣與單位', () => {
  assert.equal(fuelSummary(FUEL_DEFAULTS), '油車 8 L/100km・¥7.5/L');
  assert.equal(fuelSummary(EV_DEFAULTS), '電車 14 kWh/100km・¥1.2/kWh');
});

test('loadFuelPrefs：損壞/缺欄位 → 預設值；越界 夾到預設；type 白名單', () => {
  const mk = (v) => { const m = new Map(); if (v != null) m.set(FUEL_KEY, v); return (k) => m.get(k); };
  assert.deepEqual(loadFuelPrefs(mk(null)), { type: 'gas', consumption: 8, price: 7.5 });
  assert.deepEqual(loadFuelPrefs(mk('not json')), { type: 'gas', consumption: 8, price: 7.5 });
  assert.deepEqual(loadFuelPrefs(mk('{"type":"ev"}')), { type: 'ev', consumption: 14, price: 1.2 });
  assert.deepEqual(loadFuelPrefs(mk('{"type":"hack","consumption":999,"price":-5}')), { type: 'gas', consumption: 8, price: 7.5 });
  assert.deepEqual(loadFuelPrefs(mk('{"consumption":6.2,"price":7.88}')), { type: 'gas', consumption: 6.2, price: 7.88 });
});

test('saveFuelPrefs → loadFuelPrefs：來回一致（自帶 get/set，不碰真的 localStorage）', () => {
  const m = new Map();
  saveFuelPrefs({ type: 'ev', consumption: 15.5, price: 0.9 }, (k, v) => m.set(k, v));
  assert.deepEqual(loadFuelPrefs((k) => m.get(k)), { type: 'ev', consumption: 15.5, price: 0.9 });
});

test('drivingCardHtml：油費行、合計行與電車字樣；XSS 跳脫', () => {
  const h = drivingCardHtml(R({ roads: ['<script>'] }), { fuel: { cost: 60, type: 'gas', total: 120 } });
  assert.match(h, /<span class="fuel">油費 ¥60<\/span>/);
  assert.match(h, /合計約 ¥120（油費＋過路費，估算）/);
  assert.ok(!h.includes('<script>'));
  const ev = drivingCardHtml(R(), { fuel: { cost: 16.8, type: 'ev', total: 76.8 } });
  assert.match(ev, /電費 ¥17/);
  assert.match(ev, /合計約 ¥77（電費＋過路費，估算）/);
  // 沒有 fuel 時不出現能耗行（與舊版卡片一致）
  const none = drivingCardHtml(R());
  assert.ok(!none.includes('油費') && !none.includes('電費') && !none.includes('合計'));
  // tolls=null 的高德回應：total 只算油費
  const noToll = drivingCardHtml(R({ tolls: null }), { fuel: { cost: 60, type: 'gas', total: 60 } });
  assert.match(noToll, /合計約 ¥60（油費＋過路費，估算）/);
});

test('wmoLabel：已知 WMO 代碼 → emoji＋繁中；未知 → 不丟例外', () => {
  assert.equal(wmoLabel(0).label, '晴');
  assert.equal(wmoLabel(2).emoji, '⛅');
  assert.equal(wmoLabel(61).label, '小雨');
  assert.equal(wmoLabel(65).label, '大雨');
  assert.equal(wmoLabel(95).label, '雷雨');
  assert.equal(wmoLabel(null).label, '天氣資料');
  assert.equal(wmoLabel(9999).label, '天氣資料');
});

test('dayLabel：今天/明天/後天/週幾（以固定 today 測試）', () => {
  assert.equal(dayLabel('2026-11-07', '2026-11-07'), '今天');
  assert.equal(dayLabel('2026-11-08', '2026-11-07'), '明天');
  assert.equal(dayLabel('2026-11-09', '2026-11-07'), '後天');
  // 2026-11-12 是週四
  assert.equal(dayLabel('2026-11-12', '2026-11-07'), '週四');
  assert.equal(localDateStr(new Date('2026-11-07T08:00:00')), '2026-11-07');
});

test('hourlyAt：找最接近指定時刻的一筆；時間字串無時區（地點當地時間）', () => {
  const h = [
    { time: '2026-11-07T10:00', temperature: 10 },
    { time: '2026-11-07T11:00', temperature: 11 },
    { time: '2026-11-07T12:00', temperature: 12 },
  ];
  assert.equal(hourlyAt(h, Date.parse('2026-11-07T11:20')).temperature, 11);
  assert.equal(hourlyAt(h, Date.parse('2026-11-07T11:45')).temperature, 12);
  assert.equal(hourlyAt(h, Date.parse('2026-11-07T09:10')).temperature, 10);
  assert.equal(hourlyAt([], Date.now()), null);
  assert.equal(hourlyAt([{ time: 'bad', temperature: 1 }], Date.now()), null);
});

const WX = {
  attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)',
  timezone: 'Asia/Shanghai',
  updatedAt: '2026-11-07T11:00',
  current: { time: '2026-11-07T11:00', temperature: 12.3, apparent: 10.1, humidity: 62, precipitation: 0, code: 2, wind: 12.4 },
  daily: [
    { date: '2026-11-07', code: 2, tMax: 15, tMin: 4, precipProb: 10, precipSum: 0 },
    { date: '2026-11-08', code: 61, tMax: 12, tMin: 2, precipProb: 80, precipSum: 6.2 },
    { date: '2026-11-09', code: 0, tMax: 16, tMin: 3, precipProb: null, precipSum: 0 },
  ],
  hourly: [
    { time: '2026-11-07T12:00', temperature: 13, code: 61, precipProb: 40 },
    { time: '2026-11-07T13:00', temperature: 14, code: 3, precipProb: 65 },
  ],
};

test('weatherCardHtml：現在天氣＋3 天預報＋來源標示；days 限制；空資料回空字串', () => {
  const h = weatherCardHtml(WX);
  assert.match(h, /wx-card/);
  assert.match(h, /12°/);
  assert.match(h, /局部多雲/);
  assert.match(h, /體感 10°・濕度 62%・風 12 km\/h/);
  assert.match(h, /小雨/);
  assert.match(h, /4°\/15°/);
  assert.ok((h.match(/class="wx-day"/g) || []).length === 3, 'wx-days 容器字串不應計入');
  assert.match(h, /Open-Meteo 模式估計/);
  assert.match(h, /觀測時間 11:00/);
  assert.equal((weatherCardHtml(WX, { days: 1 }).match(/class="wx-day"/g) || []).length, 1);
  assert.equal(weatherCardHtml(null), '');
  assert.equal(weatherCardHtml({ current: null, daily: [] }), '');
  // current 有 daily 空 → 仍顯示現在天氣
  assert.ok(weatherCardHtml({ current: WX.current, daily: [] }).includes('wx-now'));
});

test('weatherCardHtml：數值全部跳脫（地點名不會進來，但標籤內容安全組裝）', () => {
  const bad = { current: { temperature: 1, code: 61 }, daily: [{ date: '2026-11-07', code: 95, tMax: 1, tMin: 0 }] };
  const h = weatherCardHtml(bad);
  assert.ok(!h.includes('<script>'));
  assert.match(h, /雷雨/);
});

test('arrivalWeatherHtml：溫度＋描述；降水機率 ≥30% 才顯示；沒有 hourly → 空字串', () => {
  const eta = Date.parse('2026-11-07T12:30');
  const h = arrivalWeatherHtml(WX.hourly, eta);
  assert.match(h, /抵達時約 13°C 🌦️ 小雨・降水機率 40%/);
  assert.equal(arrivalWeatherHtml(WX.hourly, Date.parse('2026-11-07T13:10')).includes('65%'), true);
  const low = [{ time: '2026-11-07T12:00', temperature: 13, code: 0, precipProb: 5 }];
  assert.ok(!arrivalWeatherHtml(low, eta).includes('降水機率'));
  assert.equal(arrivalWeatherHtml([], eta), '');
  assert.equal(arrivalWeatherHtml([{ time: '2026-11-07T12:00', temperature: null }], eta), '');
});
