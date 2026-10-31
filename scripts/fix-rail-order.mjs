// 對 data/rail-lines.json 套用站序修正（可重複執行）
import { readFileSync, writeFileSync } from 'node:fs';
import { orderStations } from './lib/rail-order.mjs';
const f = new URL('../data/rail-lines.json', import.meta.url);
const data = JSON.parse(readFileSync(f, 'utf8'));
let changed = 0;
for (const ln of data.lines) {
  const fixed = orderStations(ln.stations);
  if (fixed.some((x, i) => x !== ln.stations[i])) { changed++; ln.stations = fixed; }
}
writeFileSync(f, JSON.stringify(data));
console.log(`已修正 ${changed}/${data.lines.length} 條線的站序`);
