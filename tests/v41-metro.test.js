import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { distToChains, normColor, cleanName, relKind, simplify, stitch, buildMetro } from '../scripts/lib/metro-build.mjs';
import { decodeCell, cellsForBounds, collectStations, createMetroLoader } from '../public/js/lib/metro-layer.js';

const way = (id, pts) => ({ type: 'way', ref: id, role: '', geometry: pts.map(([lon, lat]) => ({ lon, lat })) });
const fixture = () => [
  { type: 'node', id: 1, tags: { name: '人民廣場 People’s Square' } },
  { type: 'node', id: 2, tags: { name: '陸家嘴' } },
  {
    type: 'relation', id: 100,
    tags: { route: 'subway', name: '地鐵2號線: 浦東 => 虹橋', ref: '2', colour: '#8cc220', network: '上海地鐵' },
    members: [
      way(10, [[121.47, 31.23], [121.48, 31.23], [121.49, 31.235]]),
      way(11, [[121.49, 31.235], [121.5, 31.24]]),
      { type: 'node', ref: 1, role: 'stop', lon: 121.47, lat: 31.23 },
      { type: 'node', ref: 2, role: 'stop', lon: 121.5, lat: 31.24 },
    ],
  },
  { // 反方向：同一條線，不應重複
    type: 'relation', id: 101,
    tags: { route: 'subway', name: '地鐵2號線: 虹橋 => 浦東', ref: '2', colour: '#8cc220', network: '上海地鐵' },
    members: [way(10, [[121.47, 31.23], [121.48, 31.23], [121.49, 31.235]]), way(11, [[121.49, 31.235], [121.5, 31.24]])],
  },
  { // 磁浮
    type: 'relation', id: 200,
    tags: { route: 'monorail', name: '上海磁浮示範運營線', network: '上海地鐵', colour: 'red' },
    members: [way(20, [[121.8, 31.2], [121.9, 31.15]])],
  },
  { // 規劃中：略過
    type: 'relation', id: 300,
    tags: { route: 'subway', name: '未來線', state: 'proposed' },
    members: [way(30, [[121.1, 31.1], [121.2, 31.1]])],
  },
];

test('metro-build：顏色、站名、類型', () => {
  assert.equal(normColor('#ABC'), '#aabbcc');
  assert.equal(normColor('red'), '#e4002b');
  assert.equal(normColor('not-a-color'), null);
  assert.equal(cleanName('人民廣場 People’s Square'), '人民廣場');
  assert.equal(cleanName('Central'), 'Central');
  assert.equal(relKind({ route: 'light_rail' }), 'light_rail');
  assert.equal(relKind({ route: 'monorail', name: '上海磁浮示範運營線' }), 'maglev');
  assert.equal(relKind({ route: 'subway', name: '1號線' }), 'subway');
});

test('metro-build：stitch 串接、simplify 去掉共線點', () => {
  const chains = stitch([[[0, 0], [1, 0]], [[1, 0], [2, 0]], [[5, 5], [6, 5]]]);
  assert.equal(chains.length, 2);
  assert.ok(chains.some((c) => c.length === 3));
  const s = simplify([[121, 31], [121.0005, 31], [121.001, 31], [121.002, 31]], 8);
  assert.equal(s.length, 2);
});

test('metro-build：兩個方向合併成一條線、規劃中不收、磁浮分類、車站名稱接上', () => {
  const { cells, index, stats } = buildMetro(fixture());
  assert.equal(stats.lines, 2);
  const lines = Object.values(cells).flatMap((c) => c.lines);
  const l2 = lines.find((l) => l.r === '2');
  assert.equal(l2.k, 'subway');
  assert.equal(l2.c, '#8cc220');
  assert.equal(l2.p.length, 1); // 兩段 way 串成一條
  assert.deepEqual(l2.s.map((s) => s[0]), ['人民廣場', '陸家嘴']);
  assert.ok(lines.some((l) => l.k === 'maglev'));
  assert.ok(!lines.some((l) => /未來/.test(l.n)));
  assert.ok(index.cells.every((c) => c.bbox.length === 4) && index.attribution.includes('OpenStreetMap'));
});

test('metro-layer：差分編碼可還原、格子與站點整理', () => {
  const { cells, index } = buildMetro(fixture());
  const lines = Object.values(cells).flatMap((c) => decodeCell(c));
  const l2 = lines.find((l) => l.ref === '2');
  assert.ok(Math.abs(l2.paths[0][0][0] - 121.47) < 1e-4 && Math.abs(l2.paths[0].at(-1)[1] - 31.24) < 1e-4);
  assert.equal(l2.stations[0].name, '人民廣場');
  const b = { west: 121.3, east: 121.7, south: 31.0, north: 31.4 };
  assert.ok(cellsForBounds(index, b).length >= 1);
  assert.deepEqual(cellsForBounds(index, { west: 10, east: 11, south: 10, north: 11 }, 0), []);
  const st = collectStations([l2, { ...l2, color: '#0072ce', stations: l2.stations.slice(0, 1) }], null);
  assert.equal(st.find((s) => s.name === '人民廣場').transfer, true);
  assert.equal(st.find((s) => s.name === '陸家嘴').transfer, false);
});

test('metro-layer：loader 只抓相交的格子、gzip 解壓、不重複抓', async () => {
  const { cells, index } = buildMetro(fixture());
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('index.json')) return new Response(JSON.stringify(index));
    const id = url.match(/\/([^/]+)\.json\.gz$/)[1];
    return new Response(gzipSync(Buffer.from(JSON.stringify(cells[id]))));
  };
  const loader = createMetroLoader({ fetchImpl });
  const b = { west: 121.3, east: 121.7, south: 31.0, north: 31.4 };
  const r1 = await loader.load(b);
  assert.ok(r1.lines.some((l) => l.ref === '2'));
  const n = calls.length;
  await loader.load(b);
  assert.equal(calls.length, n);
  const far = await loader.load({ west: 10, east: 11, south: 10, north: 11 });
  assert.equal(far.lines.length, 0);
});

test('metro-layer：已建好的資料（若存在）格式正確、很小、不含國鐵高鐵', () => {
  let index;
  try {
    index = JSON.parse(readFileSync(new URL('../public/data/metro/index.json', import.meta.url), 'utf8'));
  } catch {
    return; // 尚未建置
  }
  let total = 0;
  let nLines = 0;
  for (const c of index.cells) {
    const gz = readFileSync(new URL(`../public/data/metro/${c.id}.json.gz`, import.meta.url));
    total += gz.length;
    const cell = JSON.parse(gunzipSync(gz));
    for (const l of decodeCell(cell)) {
      nLines++;
      assert.ok(['subway', 'light_rail', 'monorail', 'maglev'].includes(l.kind), l.kind);
      assert.match(l.color, /^#[0-9a-f]{6}$/);
      assert.ok(l.paths.every((p) => p.length >= 2 && p.every(([x, y]) => x > 70 && x < 140 && y > 15 && y < 56)));
    }
  }
  assert.ok(nLines > 100, `線路數 ${nLines}`);
  assert.ok(total < 1.6 * 1024 * 1024, `資料總量 ${total}`);
});

test('版面：圖層卡片精簡（2×2 小卡）、visualViewport 鍵盤處理與 16px 輸入框都在', () => {
  const glass = readFileSync(new URL('../public/css/glass.css', import.meta.url), 'utf8');
  assert.match(glass, /\.layer-card[^}]*padding:\s*6px/);
  assert.match(glass, /\.thumb[^}]*height:\s*46px/);
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /visualViewport/);
  assert.match(app, /--vv-bottom/);
  const css = readFileSync(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /body\.kb-open \.sheet/);
  assert.match(css, /\.search-field input \{[^}]*font-size: 1[6-9]px/);
});

test('metro-build：離線路太遠的站點被丟掉', () => {
  assert.ok(distToChains([[[121, 31], [121.01, 31]]], 121.005, 31.0005) < 60);
  assert.ok(distToChains([[[121, 31], [121.01, 31]]], 121.005, 31.01) > 1000);
  const rels = fixture();
  rels.push({ type: 'node', id: 9, tags: { name: '遠方站' } });
  rels.find((r) => r.id === 100).members.push({ type: 'node', ref: 9, role: 'stop', lon: 121.6, lat: 31.4 });
  const { cells } = buildMetro(rels);
  const l2 = Object.values(cells).flatMap((c) => c.lines).find((l) => l.r === '2');
  assert.ok(!l2.s.some((s) => s[0] === '遠方站'));
});
