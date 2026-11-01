// 產生「大眾運輸」圖層用的城市軌道資料：地鐵（subway）、輕軌（light_rail）、單軌／磁浮（monorail、磁浮 train）。
// 資料來源：© OpenStreetMap contributors，ODbL 1.0（https://www.openstreetmap.org/copyright）。
// 做法（與 foglet/transit、OpenRailwayMap 一樣用 OSM 的 route 關係，但不依賴它們的圖磚伺服器）：
//   Overpass 取全中國（CN／HK／MO）route=subway|light_rail|monorail 與名稱含「磁浮」的 route=train，
//   取每條路線的軌道幾何與 stop 站點，依「網路＋線路 ref」合併兩個方向、串成長折線、簡化、轉 GCJ-02，
//   再依地理格子切成小檔（gzip，網頁用 DecompressionStream 解壓），只載入畫面附近的格子。
// 用法：node scripts/build-metro-lines.mjs      （OVERPASS_URL 可換鏡像；結果快取在 .run/metro-cache）
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { wgs84ToGcj02 } from '../public/js/lib/coords.js';
import { buildMetro } from './lib/metro-build.mjs';

const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = new URL('../.run/metro-cache/', import.meta.url);
const OUT = new URL('../public/data/metro/', import.meta.url);
await mkdir(CACHE, { recursive: true });
await mkdir(OUT, { recursive: true });

async function overpass(key, query, tries = 8) {
  const file = new URL(key, CACHE);
  if (existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'world-map-build/2.0 (personal project)' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(170_000),
      });
      const text = await res.text();
      if (res.ok && text.trimStart().startsWith('{')) {
        await writeFile(file, text);
        return JSON.parse(text);
      }
    } catch {
      /* 重試 */
    }
    await new Promise((r) => setTimeout(r, 5000 * i));
  }
  throw new Error('Overpass 無回應：' + key);
}

const AREA = '(area["ISO3166-1"="CN"];area["ISO3166-1"="HK"];area["ISO3166-1"="MO"];)->.a;';
const list = await overpass(
  'list.json',
  `[out:json][timeout:160];${AREA}(rel["route"~"^(subway|light_rail|monorail)$"](area.a);rel["route"="train"]["name"~"磁浮|磁悬浮|磁懸浮"](area.a););out tags center;`,
);
const ids = list.elements.map((e) => e.id);
console.log('路線關係', ids.length);
const rels = [];
const BATCH = 12;
// PREFETCH_REVERSE=1：只從尾端往前預先抓取（可與正常建置同時跑，以不同 OVERPASS_URL 加速）
const starts = [];
for (let i = 0; i < ids.length; i += BATCH) starts.push(i);
if (process.env.PREFETCH_REVERSE) starts.reverse();
if (process.env.PREFETCH_FROM) starts.splice(0, 0, ...starts.splice(Number(process.env.PREFETCH_FROM)));
for (const i of starts) {
  const chunk = ids.slice(i, i + BATCH);
  const d = await overpass(`geom-${chunk[0]}-${chunk.length}.json`, `[out:json][timeout:150];rel(id:${chunk.join(',')})->.r;.r out geom;(node(r.r:"stop");node(r.r:"stop_entry_only");node(r.r:"stop_exit_only");node(r.r:"platform");node(r.r:"platform_entry_only");node(r.r:"platform_exit_only"););out;`);
  rels.push(...d.elements);
  process.stdout.write(`\r  ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
}
console.log();
if (process.env.PREFETCH_REVERSE || process.env.PREFETCH_FROM) process.exit(0);
rels.sort((a, b) => a.id - b.id);

const { cells, index, stats } = buildMetro(rels, { toGcj: wgs84ToGcj02 });
for (const f of await readdir(OUT)) await rm(new URL(f, OUT));
let total = 0;
for (const [id, data] of Object.entries(cells)) {
  const gz = gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 });
  total += gz.length;
  await writeFile(new URL(`${id}.json.gz`, OUT), gz);
}
await writeFile(new URL('index.json', OUT), JSON.stringify(index));
console.log(`格子 ${Object.keys(cells).length}，線路 ${stats.lines}，折線 ${stats.chains}，點 ${stats.points}，車站 ${stats.stations}，gzip 合計 ${(total / 1024).toFixed(0)} KB`);
console.log('輸出：public/data/metro/（' + ROOT + '）');
