import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistory, MAX_HISTORY } from '../public/js/lib/history.js';
import { scaleBar, metersPerPixel } from '../public/js/lib/scale.js';
import { createEnvService, gpsProvider, createApiProvider } from '../public/js/lib/env-provider.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), m };
};

test('history：新的在前、同字串（不分大小寫）去重、上限、刪除、清除', () => {
  let t = 0;
  const h = createHistory(memStorage(), () => ++t);
  h.add('南京站');
  h.add('  連雲港   站 ');
  h.add('南京站');
  assert.deepEqual(h.list().map((x) => x.q), ['南京站', '連雲港 站']);
  h.add('');
  h.add(null);
  assert.equal(h.list().length, 2);
  for (let i = 0; i < 30; i++) h.add(`地點${i}`);
  assert.equal(h.list().length, MAX_HISTORY);
  assert.equal(h.list()[0].q, '地點29');
  h.remove('地點29');
  assert.ok(!h.list().some((x) => x.q === '地點29'));
  assert.deepEqual(h.suggest('地點1').every((x) => x.q.includes('地點1')), true);
  h.clear();
  assert.deepEqual(h.list(), []);
});

test('history：壞資料或儲存失敗不會丟錯', () => {
  const s = memStorage();
  s.setItem('wm.searchHistory.v1', '{壞掉');
  assert.deepEqual(createHistory(s).list(), []);
  const full = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  assert.doesNotThrow(() => createHistory(full).add('x'));
});

test('scale：長度是 1/2/5×10^n，像素不超過上限，縮放越大公尺越小', () => {
  for (const z of [3, 8, 12, 15, 18]) {
    const s = scaleBar(z, 34.6, 96);
    assert.ok(s.px <= 96 && s.px > 0, `z${z} px=${s.px}`);
    assert.match(String(s.meters).replace('.', ''), /^[125]0*$/);
  }
  assert.ok(scaleBar(18, 34.6).meters < scaleBar(12, 34.6).meters);
  assert.equal(scaleBar(10, 34.6).label.endsWith('公里'), true);
  assert.match(scaleBar(17, 34.6).label, /公尺$/);
  assert.ok(Math.abs(metersPerPixel(0, 0) - 156543.03) < 0.1);
  assert.equal(scaleBar(NaN, 0).label, '');
});

test('env-provider：優先順序 sensor > gps > api，只有 sensor 不是估計', async () => {
  const svc = createEnvService({ now: () => 0 });
  svc.registerProvider(gpsProvider);
  svc.registerProvider(createApiProvider(async () => ({ elevation: { value: 4, label: 'DEM' }, pressure: { surface: 1018.6, seaLevel: 1019.1, label: 'API 氣壓', time: 't' } })));
  const ctx = { position: { lat: 34.6, lng: 119.2, altitude: 12.5, altitudeAccuracy: 3 } };
  const alt = await svc.getAltitude(ctx);
  assert.equal(alt.source, 'gps');
  assert.equal(alt.estimate, true);
  assert.equal(alt.value, 12.5);
  assert.equal(alt.accuracy, 3);
  assert.equal(alt.unit, 'm');
  const pr = await svc.getPressure(ctx);
  assert.equal(pr.source, 'api');
  assert.equal(pr.estimate, true);
  assert.equal(pr.value, 1018.6);
  assert.equal(pr.seaLevel, 1019.1);
  assert.equal(pr.unit, 'hPa');
  // 原生 App 註冊氣壓計後，自動優先於其他來源，介面不變
  const off = svc.registerProvider({ source: 'sensor', getPressure: async () => ({ value: 1007.2 }), getAltitude: async () => ({ value: 31.4, accuracy: 1 }) });
  const p2 = await svc.getPressure(ctx);
  assert.deepEqual([p2.source, p2.estimate, p2.value], ['sensor', false, 1007.2]);
  assert.equal((await svc.getAltitude(ctx)).source, 'sensor');
  off();
  assert.equal((await svc.getPressure(ctx)).source, 'api');
});

test('env-provider：GPS 沒有海拔 → 退回 API；提供者丟錯 → 下一個；全部沒有 → null', async () => {
  const svc = createEnvService();
  svc.registerProvider(gpsProvider);
  svc.registerProvider(createApiProvider(async () => ({ elevation: { value: 4 }, pressure: null })));
  const ctx = { position: { lat: 1, lng: 2, altitude: null } };
  assert.equal((await svc.getAltitude(ctx)).source, 'api');
  assert.equal(await svc.getPressure(ctx), null);
  svc.registerProvider({ source: 'sensor', getAltitude: async () => { throw new Error('boom'); } });
  assert.equal((await svc.getAltitude(ctx)).source, 'api');
  assert.throws(() => svc.registerProvider({ source: 'magic' }), /source/);
  const empty = createEnvService();
  assert.equal(await empty.getAltitude({}), null);
});

test('createApiProvider：同位置的海拔與氣壓共用一次請求；失敗回 null 不丟錯', async () => {
  let n = 0;
  const p = createApiProvider(async () => { n++; return { elevation: { value: 9 }, pressure: { surface: 1000 } }; });
  const ctx = { position: { lat: 34.601, lng: 119.201 } };
  await Promise.all([p.getAltitude(ctx), p.getPressure(ctx)]);
  assert.equal(n, 1);
  const bad = createApiProvider(async () => { throw new Error('x'); });
  assert.equal(await bad.getAltitude({ position: { lat: 1, lng: 1 } }), null);
});

import { pickDetent } from '../public/js/lib/sheet.js';
test('sheet：pickDetent 吸附最近段；快速上滑／下滑至少跨一段', () => {
  const d = [120, 400, 760];
  assert.equal(pickDetent(130, 0, d), 0);
  assert.equal(pickDetent(380, 0, d), 1);
  assert.equal(pickDetent(700, 0, d), 2);
  assert.equal(pickDetent(270, 0, d), 1); // 270 靠 400 較近
  assert.equal(pickDetent(410, 1.2, d), 2); // 快速上拉
  assert.equal(pickDetent(410, -1.2, d), 0); // 快速下拉
  assert.equal(pickDetent(770, 2, d), 2); // 已在最高，不越界
  assert.equal(pickDetent(100, -2, d), 0);
});
