import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wgs84ToGcj02, gcj02ToWgs84, outOfChina, haversine } from '../public/js/lib/coords.js';

test('outOfChina：境內外判斷', () => {
  assert.equal(outOfChina(119.3389, 34.7603), false); // 連雲港
  assert.equal(outOfChina(116.397, 39.909), false); // 北京
  assert.equal(outOfChina(-122.4194, 37.7749), true); // 舊金山
  assert.equal(outOfChina(139.6917, 35.6895), true);
  assert.equal(outOfChina(2.3522, 48.8566), true); // 巴黎
});

test('wgs84ToGcj02：已知參考值（北京天安門）', () => {
  // 參考值：公開實作 eviltransform / coordtransform 的同一演算法輸出
  const [lng, lat] = wgs84ToGcj02(116.391305, 39.907333);
  assert.ok(Math.abs(lng - 116.397549) < 2e-5, `lng ${lng}`);
  assert.ok(Math.abs(lat - 39.908735) < 2e-5, `lat ${lat}`);
});

test('wgs84ToGcj02：中國境內偏移量合理（100–700 公尺）', () => {
  for (const [lng, lat] of [[119.3389, 34.7603], [118.7969, 32.0603], [121.4737, 31.2304], [104.0665, 30.5723], [87.6168, 43.8256]]) {
    const [g1, g2] = wgs84ToGcj02(lng, lat);
    const d = haversine(lng, lat, g1, g2);
    assert.ok(d > 100 && d < 700, `offset ${d.toFixed(1)}m at ${lng},${lat}`);
  }
});

test('wgs84ToGcj02：境外不偏移', () => {
  assert.deepEqual(wgs84ToGcj02(-122.4194, 37.7749), [-122.4194, 37.7749]);
  assert.deepEqual(wgs84ToGcj02(151.2093, -33.8688), [151.2093, -33.8688]);
});

test('gcj02ToWgs84 為 wgs84ToGcj02 的反函數（誤差 < 1 公分）', () => {
  for (const [lng, lat] of [[119.3389, 34.7603], [113.2644, 23.1291], [126.6424, 45.7569], [91.1409, 29.6456]]) {
    const g = wgs84ToGcj02(lng, lat);
    const w = gcj02ToWgs84(g[0], g[1]);
    assert.ok(haversine(lng, lat, w[0], w[1]) < 0.01);
  }
});

test('無效輸入會丟出錯誤', () => {
  assert.throws(() => wgs84ToGcj02(NaN, 30));
  assert.throws(() => wgs84ToGcj02(120, undefined));
});
