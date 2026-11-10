import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { levelForZoom, tilesCovering, tileCoord, lookupDensity, encodeDensity, packPopulation, decodePopulation } from '../public/js/lib/population.js';
import { footprintRadiusPx, footprintHeatOpacity } from '../public/js/lib/footprint.js';

const origin = { west: 73, south: 17.5, east: 135.5, north: 54 };
const levels = [
  { id: 'c', step: 0.04, tileDeg: 0, minZoom: 3, file: 'c.bin.gz' },
  { id: 'm', step: 0.01, tileDeg: 4, minZoom: 8, tileSet: new Set(['10_5']) },
  { id: 'f', step: 0.005, tileDeg: 2, minZoom: 11, tileSet: new Set(['21_11']) },
  { id: 'n', step: 0.001, tileDeg: 1, minZoom: 13.5, tileSet: new Set(['43_22']) },
];

test('人口圖磚：縮小用粗網格，城市放大用 500 m，再放大用 100 m', () => {
  assert.equal(levelForZoom(levels, 5).id, 'c');
  assert.equal(levelForZoom(levels, 9).step, 0.01);
  assert.equal(levelForZoom(levels, 12).step, 0.005);
  assert.equal(levelForZoom(levels, 15).step, 0.001);
});

test('人口圖磚：北京視野只抓蓋到的幾塊，不存在的格子不請求', () => {
  const [ix, iy] = tileCoord(levels[3], 116.4, 39.9, origin);
  assert.deepEqual([ix, iy], [43, 22]);
  const tiles = tilesCovering(levels[3], { west: 116.3, south: 39.85, east: 116.55, north: 40.05 }, origin);
  assert.ok(tiles.length >= 1 && tiles.length <= 4);
  assert.ok(tiles.every((t) => t.url.startsWith('/data/pop/n/') && t.url.endsWith('.bin.gz')));
  const missing = tilesCovering(levels[3], { west: 80, south: 40, east: 80.2, north: 40.2 }, origin);
  assert.equal(missing.length, 0);
});

test('人口取樣：細格子已載入就用細的，沒載入才退回粗的', () => {
  const coarse = decodePopulation(packPopulation(
    { west: 73, north: 54, step: 1, cols: 2, rows: 2, logScale: 14 },
    Uint8Array.from([encodeDensity(100), 0, 0, 0]),
  ));
  const fineMeta = { west: 116, north: 40, step: 0.5, cols: 2, rows: 2, logScale: 14 };
  const fine = decodePopulation(packPopulation(fineMeta, Uint8Array.from([encodeDensity(8000), 0, 0, 0])));
  const index = { west: 73, south: 17, levels: [
    { id: 'c', step: 1, tileDeg: 0, file: 'c.bin.gz' },
    { id: 'n', step: 0.5, tileDeg: 1, minZoom: 13, tileSet: new Set(['43_22']) },
  ]};
  // 北京落在 fine 格點 (116, 40) 上。tile 43_22 的原點要能對上，這裡直接把網格掛在查詢會命中的網址。
  const hit = tileCoord(index.levels[1], 116, 40, { west: 73, south: 17 });
  const grids = new Map([
    ['/data/pop/c.bin.gz', coarse],
    [`/data/pop/n/${hit[0]}_${hit[1]}.bin.gz`, fine],
  ]);
  index.levels[1].tileSet = new Set([`${hit[0]}_${hit[1]}`]);
  assert.ok(lookupDensity(index, grids, 116, 40) > 5000);
  grids.delete(`/data/pop/n/${hit[0]}_${hit[1]}.bin.gz`);
  assert.ok(lookupDensity(index, grids, 116, 40) < 500);
});

test('足跡熱力半徑比固定 28px 更緊，放大時更清楚', () => {
  const mpp = (z, lat) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
  const city = footprintRadiusPx(14, 39.9);
  assert.ok(city >= 8 && city <= 16);
  assert.ok(city * mpp(14, 39.9) < 28 * mpp(14, 39.9));
  assert.ok(footprintRadiusPx(11, 39.9) * mpp(11, 39.9) < 28 * mpp(11, 39.9) * 0.5);
  assert.ok(footprintHeatOpacity(16)[1] > footprintHeatOpacity(11)[1]);
});

test('100 m 圖磚可由 WM_POP 讀出，沒有綁定就不會擋其他路徑', async () => {
  const env = {
    WM_POP: { async get(key) {
      if (key === 'data/pop/f/1_2.bin.gz') return { body: 'TILE' };
      if (key === 'data/pop/m/10_5.bin.gz') return { body: 'MID' };
      return null;
    } },
    ASSETS: { async fetch() { return new Response('static', { status: 200, headers: { 'content-type': 'text/plain' } }); } },
  };
  const hit = await worker.fetch(new Request('https://w.example/data/pop/f/1_2.bin.gz'), env);
  assert.equal(await hit.text(), 'TILE');
  assert.match(hit.headers.get('content-type'), /gzip/);
  const mid = await worker.fetch(new Request('https://w.example/data/pop/m/10_5.bin.gz'), env);
  assert.equal(await mid.text(), 'MID');
  const miss = await worker.fetch(new Request('https://w.example/data/pop/n/9_9.bin.gz'), env);
  assert.equal(await miss.text(), 'static');
});

test('圖層面板在手機上限制在可視高度內並可捲動', () => {
  const app = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const glass = readFileSync(new URL('../public/css/glass.css', import.meta.url), 'utf8');
  assert.match(app, /max-height:\s*calc\(100dvh - env\(safe-area-inset-top/);
  assert.match(app, /overflow-y:\s*auto/);
  assert.match(app, /-webkit-overflow-scrolling:\s*touch/);
  assert.match(app, /overscroll-behavior:\s*contain/);
  assert.match(app, /touch-action:\s*pan-y/);
  assert.match(glass, /orientation:\s*landscape/);
  assert.match(glass, /position:\s*sticky/);
});
