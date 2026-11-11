// OSM route relation 的站點成員順序大多沿線，但後來補上的站常被接在最尾端。
// 用「重新插入」啟發式修正：若把某站搬到別處可使整條折線縮短超過門檻，就搬過去。
const R = 6371;
function d(a, b) {
  const r = Math.PI / 180;
  const dl = (b[2] - a[2]) * r;
  const dg = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[2] * r) * Math.cos(b[2] * r) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function fixOrder(stations, thresholdKm = 2, passes = 3) {
  const s = stations.slice();
  for (let p = 0; p < passes; p++) {
    let moved = false;
    for (let i = 0; i < s.length; i++) {
      const prev = s[i - 1];
      const next = s[i + 1];
      const gain = (prev ? d(prev, s[i]) : 0) + (next ? d(s[i], next) : 0) - (prev && next ? d(prev, next) : 0);
      if (gain < thresholdKm) continue;
      const item = s[i];
      const rest = s.slice(0, i).concat(s.slice(i + 1));
      let bestJ = -1;
      let bestCost = Infinity;
      for (let j = 0; j <= rest.length; j++) {
        const a = rest[j - 1];
        const b = rest[j];
        const cost = (a ? d(a, item) : 0) + (b ? d(item, b) : 0) - (a && b ? d(a, b) : 0);
        if (cost < bestCost) {
          bestCost = cost;
          bestJ = j;
        }
      }
      if (gain - bestCost > thresholdKm && bestJ !== i) {
        rest.splice(bestJ, 0, item);
        s.splice(0, s.length, ...rest);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return s;
}

/** 開放路徑 2-opt：反轉子段使總長縮短，直到無改善。 */
export function twoOpt(stations, maxIter = 50) {
  const s = stations.slice();
  const n = s.length;
  for (let it = 0; it < maxIter; it++) {
    let improved = false;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        // 反轉 s[i..j]：改變 (i-1,i) 與 (j,j+1) 兩條邊
        const a = s[i - 1];
        const b = s[i];
        const c = s[j];
        const e = s[j + 1];
        const before = (a ? d(a, b) : 0) + (e ? d(c, e) : 0);
        const after = (a ? d(a, c) : 0) + (e ? d(b, e) : 0);
        if (after + 0.01 < before) {
          for (let l = i, r = j; l < r; l++, r--) [s[l], s[r]] = [s[r], s[l]];
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return s;
}

export function orderStations(stations) {
  return twoOpt(fixOrder(stations));
}
