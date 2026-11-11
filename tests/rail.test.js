import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRailMatcher, normName } from '../core/rail.js';

// 合成資料：兩條並行線（普速 0xxx 與高鐵 3xxx）共用 B、C 站名，另一條支線只有 D、E。
const S = (name, x) => [name, 119 + x * 0.1, 34];
const data = {
  lines: [
    { ref: '0001', name: '甲乙線', stations: [S('A', 0), S('B', 1), S('C', 2), S('M', 3), S('N', 4)] },
    { ref: '3001', name: '甲乙高鐵', stations: [S('A', 0), S('B', 1), S('C', 2), S('N', 4)] },
    { ref: '0002', name: '支線', stations: [S('N', 4), S('E', 5), S('F', 6)] },
  ],
};
const stopsOf = (names) => names.map((n) => ({ name: n, lng: 119 + { A: 0, B: 0.1, C: 0.2, M: 0.3, N: 0.4, E: 0.5, F: 0.6 }[n], lat: 34 }));

test('normName：去掉「站」字、括號與空白', () => {
  assert.equal(normName('南京南站'), '南京南');
  assert.equal(normName('徐州 (東)'), '徐州');
  assert.equal(normName(undefined), '');
});

test('依車次偏好：G 字頭配高鐵線，K/普速配普速線；一律 estimated', () => {
  const m = createRailMatcher(data);
  const g = m.matchRoute(stopsOf(['A', 'B', 'C']), 'G123');
  assert.equal(g.estimated, true);
  assert.equal(g.sections.length, 1);
  assert.equal(g.sections[0].line, '甲乙高鐵');
  const k = m.matchRoute(stopsOf(['A', 'B', 'C']), 'K456');
  assert.equal(k.sections[0].line, '甲乙線');
});

test('最長連續涵蓋優先：停靠站只在普速線上時，即使是 G 字頭也只能配普速線', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute(stopsOf(['A', 'M', 'N']), 'G1'); // M 只在 0001
  assert.equal(r.sections[0].line, '甲乙線');
});

test('換線：停靠站序列跨兩條線時分成兩段，接點為共同站', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute(stopsOf(['A', 'B', 'N', 'E']), 'K1');
  assert.deepEqual(r.sections.map((s) => [s.line, s.from, s.to]), [['甲乙線', 'A', 'N'], ['支線', 'N', 'E']]);
  assert.equal(r.unmatched, false);
});

test('沿線站點與路徑：包含不停靠的通過站', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute(stopsOf(['A', 'N']), 'K1'); // 普速線上 A → N 之間有 B、C、M 沒停
  assert.deepEqual(r.sections[0].lineStations, ['B', 'C', 'M']);
  assert.equal(r.sections[0].path.length, 5);
});

test('配不到線路：標記 unmatched，路徑退回停靠站直線', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute([{ name: '不存在甲', lng: 100, lat: 30 }, { name: '不存在乙', lng: 101, lat: 30 }], 'G1');
  assert.equal(r.unmatched, true);
  assert.equal(r.sections[0].line, null);
  assert.deepEqual(r.sections[0].path, [[100, 30], [101, 30]]);
});

test('同名但座標差很遠的站不算（避免不同城市的同名站）', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute([{ name: 'A', lng: 119, lat: 34 }, { name: 'B', lng: 130, lat: 40 }], 'K1');
  assert.equal(r.unmatched, true);
});

test('改名站：名稱不同但座標相近（<800m）也能對上', () => {
  const m = createRailMatcher(data);
  const r = m.matchRoute([{ name: 'A', lng: 119, lat: 34 }, { name: 'B新名', lng: 119.1003, lat: 34.0002 }], 'K1');
  assert.equal(r.unmatched, false);
  assert.equal(r.sections[0].line, '甲乙線');
});

// ───────── 實際 OSM 資料集（ODbL）─────────
const file = new URL('../data/rail-lines.json', import.meta.url);
const real = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;

test('資料集：含 ODbL 出處、站點座標在中國境內、每條線至少 2 站', { skip: !real }, () => {
  assert.match(real.attribution, /OpenStreetMap/);
  assert.match(real.attribution, /ODbL/);
  assert.ok(real.lines.length >= 20);
  for (const ln of real.lines) {
    assert.ok(ln.stations.length >= 2, ln.name);
    for (const [n, lng, lat] of ln.stations) {
      assert.ok(n && lng > 70 && lng < 140 && lat > 10 && lat < 55, `${ln.name} ${n}`);
    }
  }
});

test('資料集：指定的重點線路都在（陇海、连镇、京沪、京沪高铁、沪宁城际、新长、宁启…）', { skip: !real }, () => {
  const names = real.lines.map((l) => l.name).join(' ');
  for (const need of ['陇海线', '连镇线', '京沪线', '京沪高铁', '沪宁城际', '新长线', '宁启']) assert.ok(names.includes(need), `缺 ${need}`);
});

const REAL_STOPS = {
  D5433: [['连云港', 119.162746, 34.609024], ['涟水', 119.198707, 33.775495], ['淮安东', 119.188233, 33.568734], ['镇江', 119.432794, 32.197714], ['南京', 118.79751, 32.087125]],
  C3251: [['连云港', 119.162746, 34.609024], ['淮安东', 119.188233, 33.568734], ['扬州东', 119.52907, 32.404426], ['镇江', 119.432794, 32.197714], ['南京南', 118.798034, 31.968763]],
};
const toStops = (a) => a.map(([name, lng, lat]) => ({ name, lng, lat }));

test('實際資料（Amap 真實停靠站）：D5433 連雲港→漣水→淮安東 配到連鎮線，鎮江→南京配到京滬系', { skip: !real }, () => {
  const r = createRailMatcher(real).matchRoute(toStops(REAL_STOPS.D5433), 'D5433');
  const secs = r.sections.map((s) => [s.line, s.from, s.to]);
  assert.equal(r.estimated, true);
  assert.equal(r.unmatched, false, JSON.stringify(secs));
  assert.equal(r.sections[0].line, '连镇线', JSON.stringify(secs));
  assert.equal(r.sections[0].from, '连云港');
  assert.ok(r.sections[0].lineStations.length >= 0);
  assert.match(r.sections.at(-1).line, /京沪|沪宁/, JSON.stringify(secs));
  assert.equal(r.sections.at(-1).to, '南京');
});

test('實際資料：C3251 淮安東→揚州東→鎮江 走連鎮線，並列出通過的未停靠站', { skip: !real }, () => {
  const r = createRailMatcher(real).matchRoute(toStops(REAL_STOPS.C3251), 'C3251');
  assert.equal(r.sections[0].line, '连镇线');
  assert.ok(r.sections.some((s) => s.lineStations.includes('高邮') || s.lineStations.includes('宝应')), JSON.stringify(r.sections.map((s) => s.lineStations)));
});
