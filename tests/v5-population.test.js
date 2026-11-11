import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { gcj02ToWgs84, wgs84ToGcj02, outOfChina } from '../public/js/lib/coords.js';
import { mercatorPx } from '../public/js/lib/tianditu.js';
import {
  POP_LOG_SCALE,
  DENSITY_STOPS,
  encodeDensity,
  decodeDensity,
  packPopulation,
  decodePopulation,
  sampleDensity,
  sampleOnMap,
  colorForDensity,
  renderTilePixels,
  populationLegendHtml,
  populationNote,
  approxCellKm,
  POP_ATTRIBUTION,
} from '../public/js/lib/population.js';
import { trafficLayerOptions, trafficLegendHtml, TRAFFIC_LEGEND, TRAFFIC_INTERVAL_SEC } from '../public/js/lib/traffic-layer.js';

function spikeGrid() {
  const step = 0.002;
  const west = 121.4;
  const north = 31.3;
  const cols = 50;
  const rows = 50;
  const data = new Uint8Array(cols * rows);
  const col = 35;
  const row = 35;
  // 數值放在網格節點上，取樣對準節點才不會被旁邊的 0 雙線性稀釋
  const lng = west + col * step;
  const lat = north - row * step;
  data[row * cols + col] = encodeDensity(20000);
  const meta = { west, north, step, cols, rows, year: 2020, logScale: POP_LOG_SCALE, east: west + cols * step, south: north - rows * step };
  return { grid: { ...meta, data }, lng, lat, col, row };
}

test('人口密度：log 編碼可還原、低於 1 人/km² 為 0', () => {
  assert.equal(encodeDensity(0.2), 0);
  assert.equal(encodeDensity(Number.NaN), 0);
  for (const d of [1, 10, 50, 200, 1500, 8000, 40000]) {
    const back = decodeDensity(encodeDensity(d));
    // 1 人/km² 落在編碼的最底層，相對誤差會比中間值大一點
    assert.ok(Math.abs(back - d) / d < 0.06, `${d} → ${back}`);
  }
  assert.equal(encodeDensity(1e9), 255);
});

test('人口密度：打包後可解回，取樣用 WGS-84', () => {
  const { grid, lng, lat } = spikeGrid();
  const back = decodePopulation(packPopulation({ west: grid.west, north: grid.north, step: grid.step, cols: grid.cols, rows: grid.rows, logScale: POP_LOG_SCALE }, grid.data));
  assert.equal(back.cols, grid.cols);
  assert.ok(sampleDensity(back, lng, lat) > 15000);
  assert.equal(sampleDensity(back, lng + 0.05, lat), 0);
  assert.equal(sampleDensity(back, 0, 0), 0);
});

test('人口密度：只在中國境內做 GCJ 偏移', () => {
  const { grid, lng, lat } = spikeGrid();
  assert.equal(outOfChina(lng, lat), false);
  const [gLng, gLat] = wgs84ToGcj02(lng, lat);
  assert.ok(Math.hypot(gLng - lng, gLat - lat) > 0.002, '上海的 GCJ 偏移應該大於一格');
  assert.ok(sampleOnMap(grid, gLng, gLat) > 10000, '用 GCJ 座標查得到原本的 WGS 高峰');
  assert.ok(sampleDensity(grid, gLng, gLat) < 100, '把 GCJ 數字直接當 WGS 會錯過那一格');
  const [backLng, backLat] = gcj02ToWgs84(gLng, gLat);
  assert.ok(Math.abs(backLng - lng) < 1e-6 && Math.abs(backLat - lat) < 1e-6);

  // 巴黎在框外：偏移是恆等，高峰就在傳入的座標上
  const pStep = 0.01;
  const pWest = 2.2;
  const pNorth = 49.0;
  const pCols = 30;
  const pRows = 30;
  const pData = new Uint8Array(pCols * pRows);
  const pLng = pWest + 15 * pStep;
  const pLat = pNorth - 14 * pStep;
  assert.equal(outOfChina(pLng, pLat), true);
  pData[14 * pCols + 15] = encodeDensity(5000);
  const paris = { west: pWest, north: pNorth, step: pStep, cols: pCols, rows: pRows, logScale: POP_LOG_SCALE, data: pData };
  assert.ok(sampleOnMap(paris, pLng, pLat) > 4000);
  assert.equal(sampleOnMap(paris, pLng, pLat), sampleDensity(paris, pLng, pLat));
});

test('人口密度：圖磚把高峰畫在 GCJ 位置，海洋圖磚是空的', () => {
  const { grid, lng, lat } = spikeGrid();
  const [gLng, gLat] = wgs84ToGcj02(lng, lat);
  const z = 12;
  const p = mercatorPx(gLng, gLat, z);
  const x = Math.floor(p.x / 256);
  const y = Math.floor(p.y / 256);
  const px = renderTilePixels(x, y, z, grid, { size: 64 });
  let ink = 0;
  for (let i = 3; i < px.length; i += 4) if (px[i] > 0) ink += 1;
  assert.ok(ink > 0, '上海那張圖磚應該有顏色');
  const ocean = renderTilePixels(0, 0, 6, grid, { size: 32 });
  assert.ok(ocean.every((v, i) => i % 4 !== 3 || v === 0));
});

test('人口密度：圖例是人/km²、標成 2020 靜態估計，顏色隨密度變熱', () => {
  const html = populationLegendHtml();
  assert.match(html, /人\/km²/);
  assert.match(html, /2020/);
  assert.ok(DENSITY_STOPS.length >= 6);
  const low = colorForDensity(0);
  assert.equal(low[3], 0);
  const mid = colorForDensity(80);
  const hot = colorForDensity(20000);
  assert.ok(mid[3] > 0 && hot[3] >= mid[3]);
  assert.ok(hot[0] > hot[2], '高密度偏紅');
  assert.ok(colorForDensity(8)[2] > colorForDensity(8)[0], '低密度偏藍');
  const note = populationNote({ step: 0.015 });
  assert.match(note, /不是即時/);
  assert.match(note, /CC BY 4\.0/);
  assert.match(note, /GCJ-02/);
  assert.ok(approxCellKm(0.015) > 1 && approxCellKm(0.015) < 2);
  assert.match(POP_ATTRIBUTION, /24916140/);
});

test('路況圖層：自動更新、圖例含暢通／緩行／擁堵', () => {
  const opt = trafficLayerOptions();
  assert.equal(opt.autoRefresh, true);
  assert.equal(opt.interval, TRAFFIC_INTERVAL_SEC);
  assert.ok(opt.interval >= 60);
  const html = trafficLegendHtml();
  for (const name of ['暢通', '緩行', '擁堵']) assert.match(html, new RegExp(name));
  assert.equal(TRAFFIC_LEGEND.length, 4);
  assert.match(html, /高德/);
});

test('已建好的普查網格（若存在）：覆蓋中國、上海密、高原疏、總人口合理', () => {
  const file = new URL('../public/data/pop/c.bin.gz', import.meta.url);
  if (!existsSync(file)) return;
  const grid = decodePopulation(gunzipSync(readFileSync(file)));
  assert.equal(grid.year, 2020);
  assert.equal(grid.license, 'CC BY 4.0');
  assert.ok(grid.west < 75 && grid.east > 130 && grid.south < 20 && grid.north > 50);
  assert.ok(grid.step <= 0.04 && grid.step >= 0.001);
  assert.ok(grid.peopleTotal > 1.15e9 && grid.peopleTotal < 1.7e9);
  const shanghai = sampleDensity(grid, 121.4737, 31.2304);
  const tibet = sampleDensity(grid, 86.5, 32.5);
  const sea = sampleDensity(grid, 123.8, 27.2);
  assert.ok(shanghai > 2000, `上海 ${shanghai}`);
  assert.ok(tibet < 30, `藏北 ${tibet}`);
  assert.ok(sea < 5, `海 ${sea}`);
  const [gLng, gLat] = wgs84ToGcj02(121.4737, 31.2304);
  const shifted = sampleOnMap(grid, gLng, gLat);
  assert.ok(shifted > 1000, `GCJ 對齊後的上海 ${shifted}`);
});
