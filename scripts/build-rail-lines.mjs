// 從 OpenStreetMap（Overpass API）抽取華東／華中鐵路「線路關係」與其站點，輸出靜態資料 data/rail-lines.json。
// 資料來源：© OpenStreetMap contributors，ODbL 1.0（https://www.openstreetmap.org/copyright）。
// 用法：node scripts/build-rail-lines.mjs        （環境變數 OVERPASS_URL 可換鏡像；預設 overpass-api.de）
// 輸出座標已轉為 GCJ-02（與高德 via_stops 同座標系），四捨五入到 1e-4 度（約 10 公尺）。
import { orderStations } from './lib/rail-order.mjs';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { wgs84ToGcj02 } from '../public/js/lib/coords.js';

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const BBOX = '29.5,114,36.5,123.5'; // 江蘇、上海、安徽、浙北、魯南、豫東（S,W,N,E）
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const CACHE = new URL('../.run/rail-cache/', import.meta.url);
const EXCLUDE = /聯絡|联络|專用|专用|疏解|线路所|線路所|有軌|有轨|地鐵|地铁|特大桥|特大橋|貨線|货线|枢纽|樞紐|環線|环线|老线|老線|\(原\)|（原）|疏港|支线|支線|直通|立交/;
const KEEP_REF = /^(0\d{3}|3\d{3})$/;

async function overpass(query, tries = 8) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'world-map-build/2.0' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(150_000),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) return JSON.parse(text);
    } catch {
      /* 重試 */
    }
    await new Promise((r) => setTimeout(r, 6000 * i));
  }
  throw new Error('Overpass 無回應：' + query.slice(0, 60));
}

const STATION_OK = (t) =>
  t.name && /^(station|halt|stop)$/.test(t.railway || '') && !/线路所|線路所|信号所|信號所|线路站/.test(t.name);

const list = await overpass(`[out:json][timeout:110];rel["route"="railway"](${BBOX});out tags;`);
const HIGH_NAME = /高速|客专|客運專線|客运专线|城际|城際|高铁|高鐵/;
const PRIORITY = /京沪|陇海|沪宁|新长|宁启|宁芜|宁西|徐盐|徐连|连镇|盐通|沪苏|宁安|淮南|京九|青连|胶济|京广|合福|宁杭|杭深|商合杭|郑徐|合蚌|蚌|阜淮|淮阜|新沂|兖石|石太|沪昆|日兰|通苏|海盐|宁洛/;
const wanted = list.elements
  .filter((e) => {
    const t = e.tags || {};
    if (!t.name || EXCLUDE.test(t.name) || !t.from || !t.to) return false;
    if (KEEP_REF.test(t.ref || '')) return true;
    return !t.ref && /(高速线|客专|客运专线|城际线|城际铁路|高速铁路|铁路)$/.test(t.name); // 沒有 ref 的客專／高鐵
  })
  .map((e) => {
    if (!e.tags.ref) e.tags.ref = HIGH_NAME.test(e.tags.name) ? '3000' : '0000';
    return e;
  })
  .sort((a, b) => Number(PRIORITY.test(b.tags.name)) - Number(PRIORITY.test(a.tags.name)));
console.log(`候選線路 ${list.elements.length}，保留 ${wanted.length}`);

await mkdir(CACHE, { recursive: true });
async function relationData(id) {
  const f = new URL(`${id}.json`, CACHE);
  try {
    return JSON.parse(await readFile(f, 'utf8'));
  } catch {
    const data = await overpass(`[out:json][timeout:110];rel(${id});out body;node(r);out body;`);
    await writeFile(f, JSON.stringify(data));
    return data;
  }
}

async function buildLine(rel) {
  const data = await relationData(rel.id);
  const relation = data.elements.find((e) => e.type === 'relation');
  const nodes = new Map(data.elements.filter((e) => e.type === 'node').map((n) => [n.id, n]));
  const stations = [];
  const seen = new Set();
  for (const m of relation.members) {
    if (m.type !== 'node') continue;
    const n = nodes.get(m.ref);
    if (!n || !STATION_OK(n.tags || {})) continue;
    const name = n.tags.name.replace(/站$/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    const [lng, lat] = wgs84ToGcj02(n.lon, n.lat);
    stations.push([name, +lng.toFixed(4), +lat.toFixed(4)]);
  }
  if (stations.length < 2) return null;
  stations.splice(0, stations.length, ...orderStations(stations));
  console.log(rel.tags.ref, rel.tags.name, stations.length);
  return { id: rel.id, ref: rel.tags.ref, name: rel.tags.name, from: rel.tags.from, to: rel.tags.to, stations };
}

const results = new Array(wanted.length);
async function snapshot() {
  const ls = results.filter(Boolean).sort((a, b) => a.ref.localeCompare(b.ref) || a.name.localeCompare(b.name));
  await writeFile(new URL('../data/rail-lines.json', import.meta.url), JSON.stringify({ version: 1, generated: new Date().toISOString().slice(0, 10), attribution: '© OpenStreetMap contributors, ODbL 1.0', bbox: BBOX, lines: ls }));
}
let next = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (next < wanted.length) {
      const i = next++;
      try {
        results[i] = await buildLine(wanted[i]);
        await snapshot();
      } catch (e) {
        console.error('失敗', wanted[i].tags.name, e.message);
      }
    }
  }),
);
const lines = results.filter(Boolean).sort((a, b) => a.ref.localeCompare(b.ref));

const out = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  attribution: '© OpenStreetMap contributors, ODbL 1.0',
  bbox: BBOX,
  lines,
};
await mkdir(new URL('../data/', import.meta.url), { recursive: true });
await writeFile(new URL('../data/rail-lines.json', import.meta.url), JSON.stringify(out));
console.log('完成：', lines.length, '條線路');
