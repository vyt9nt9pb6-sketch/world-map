// 火車「推測線路」配對：把高德給的停靠站（起點、via_stops、終點）對到 OSM 鐵路線路關係的站點序列。
// 資料：data/rail-lines.json（© OpenStreetMap contributors，ODbL 1.0；由 scripts/build-rail-lines.mjs 產生）。
// 方法是以「站名＋座標」做集合配對，不是幾何比對，所以結果一律標為「推測」，偶有誤配（尤其高鐵／普速並行、
// 或同名站在不同線上時）。高德 API 本身不提供線路名，這是我們自己的估計。

const NEAR_M = 3000; // 同名站座標誤差上限
const EXT_M = 25000; // 只在完全配不到時：站點離某線路「端點站」這麼近，視為該線的延伸（例：連鎮線 OSM 起點在董集，連雲港在其 21km 外）
const PROX_M = 800; // 名稱不同（改名、別名）時，座標在此距離內也視為同一站

const R = 6371000;
function dist(aLng, aLat, bLng, bLat) {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function normName(name) {
  return String(name ?? '')
    .replace(/[（(].*?[）)]/g, '')
    .replace(/\s+/g, '')
    .replace(/站$/, '');
}

/** 以車次判斷偏好的線路等級：G/C 偏好高速／城際線（ref 3xxx），普速車偏好 0xxx */
function classScore(ref, trip) {
  const high = /^3/.test(ref);
  const t = String(trip ?? '').trim().charAt(0).toUpperCase();
  if (t === 'G' || t === 'C') return high ? 2 : 0;
  if (t === 'D') return high ? 1 : 0.5;
  return high ? 0 : 1;
}

export function createRailMatcher(data) {
  const lines = Array.isArray(data?.lines) ? data.lines : [];
  const byName = new Map();
  lines.forEach((ln, li) => {
    ln.stations.forEach(([name, lng, lat], si) => {
      const k = normName(name);
      if (!byName.has(k)) byName.set(k, []);
      byName.get(k).push({ li, si, lng, lat });
    });
  });

  /** 找出該停靠站在哪些線上，回傳 Map<lineIdx, stationIdx> */
  function linesOfStop(stop) {
    const found = new Map();
    const hits = byName.get(normName(stop.name)) || [];
    for (const h of hits) {
      if (stop.lng == null || dist(stop.lng, stop.lat, h.lng, h.lat) <= NEAR_M) {
        const prev = found.get(h.li);
        if (prev == null) found.set(h.li, h.si);
      }
    }
    if (stop.lng != null) {
      lines.forEach((ln, li) => {
        if (found.has(li)) return;
        for (let si = 0; si < ln.stations.length; si++) {
          const s = ln.stations[si];
          if (dist(stop.lng, stop.lat, s[1], s[2]) <= PROX_M) {
            found.set(li, si);
            break;
          }
        }
      });
    }
    return found;
  }

  /** 備援：站點靠近某線路的端點站 → Map<lineIdx, 端點站索引> */
  function extendedLinesOf(stop) {
    const found = new Map();
    if (stop.lng == null) return found;
    lines.forEach((ln, li) => {
      const last = ln.stations.length - 1;
      const dA = dist(stop.lng, stop.lat, ln.stations[0][1], ln.stations[0][2]);
      const dB = dist(stop.lng, stop.lat, ln.stations[last][1], ln.stations[last][2]);
      if (Math.min(dA, dB) <= EXT_M) found.set(li, dA <= dB ? 0 : last);
    });
    return found;
  }

  /**
   * @param stops [{name,lng,lat}] 依序：起點、中途停靠站…、終點
   * @param trip 車次（用於偏好高速／普速線）
   * @returns {{estimated:true, sections:[{line,ref,from,to,stopCount,lineStations,path}], unmatched:boolean}}
   */
  function matchRoute(stops, trip) {
    const n = stops.length;
    const on = stops.map(linesOfStop);
    const sections = [];
    let i = 0;
    let unmatched = false;
    while (i < n - 1) {
      // 找出從 i 開始能連續涵蓋最多停靠站的線路
      let best = null;
      for (const [li, si0] of on[i]) {
        if (!on[i + 1].has(li)) continue;
        let k = i + 1;
        while (k + 1 < n && on[k + 1].has(li)) k++;
        const ln = lines[li];
        const spanA = on[i].get(li);
        const spanB = on[k].get(li);
        const cand = {
          li,
          k,
          run: k - i,
          cls: classScore(ln.ref, trip),
          // 兩端之間在該線上相隔的站數：越少越「直」
          gap: Math.abs(spanB - spanA),
          si0,
        };
        if (
          !best ||
          cand.run > best.run ||
          (cand.run === best.run && (cand.cls > best.cls || (cand.cls === best.cls && cand.gap < best.gap)))
        ) {
          best = cand;
        }
      }
      let extended = false;
      if (!best) {
        // 備援：允許兩端站點以「線路端點延伸」方式配對
        const eA = extendedLinesOf(stops[i]);
        const eB = extendedLinesOf(stops[i + 1]);
        for (const li of new Set([...on[i].keys(), ...eA.keys()])) {
          const a = on[i].has(li) ? on[i].get(li) : eA.get(li);
          const b = on[i + 1].has(li) ? on[i + 1].get(li) : eB.get(li);
          if (a == null || b == null || (on[i].has(li) && on[i + 1].has(li))) continue;
          const cand = { li, k: i + 1, run: 1, cls: classScore(lines[li].ref, trip), gap: Math.abs(b - a), a, b };
          if (!best || cand.cls > best.cls || (cand.cls === best.cls && cand.gap < best.gap)) best = cand;
        }
        if (best) {
          extended = true;
          on[i] = new Map(on[i]).set(best.li, best.a);
          on[i + 1] = new Map(on[i + 1]).set(best.li, best.b);
          while (best.k + 1 < n && on[best.k + 1].has(best.li)) best.k++;
        }
      }
      if (!best) {
        // 這一段配不到任何線路：保留為未知線路，繼續下一段
        unmatched = true;
        const prev = sections[sections.length - 1];
        if (prev && prev.line == null) prev.to = stops[i + 1].name;
        else sections.push({ line: null, ref: null, from: stops[i].name, to: stops[i + 1].name, fromIdx: i, toIdx: i + 1 });
        i += 1;
        continue;
      }
      sections.push({
        line: lines[best.li].name,
        ref: lines[best.li].ref,
        from: stops[i].name,
        to: stops[best.k].name,
        fromIdx: i,
        toIdx: best.k,
        li: best.li,
        extended,
      });
      i = best.k;
    }
    // 補上沿線站點（含不停靠的通過站）與路徑座標
    const out = sections.map((s) => {
      const base = { line: s.line, ref: s.ref, from: s.from, to: s.to, stopCount: s.toIdx - s.fromIdx + 1 };
      if (s.li == null) return { ...base, lineStations: [], path: stops.slice(s.fromIdx, s.toIdx + 1).map((p) => [p.lng, p.lat]) };
      const ln = lines[s.li];
      const path = [];
      const passed = [];
      for (let q = s.fromIdx; q < s.toIdx; q++) {
        const a = on[q].get(s.li);
        const b = on[q + 1].get(s.li);
        const step = a <= b ? 1 : -1;
        for (let x = a; x !== b + step; x += step) {
          const st = ln.stations[x];
          if (!path.length || path[path.length - 1][0] !== st[1] || path[path.length - 1][1] !== st[2]) path.push([st[1], st[2]]);
          if (x !== a && x !== b) passed.push(st[0]);
        }
      }
      // 延伸段：路徑從站點本身接到線路端點
      if (s.extended) {
        const a = stops[s.fromIdx];
        const b = stops[s.toIdx];
        if (a.lng != null) path.unshift([a.lng, a.lat]);
        if (b.lng != null) path.push([b.lng, b.lat]);
        return { ...base, lineStations: passed, path, extended: true };
      }
      return { ...base, lineStations: passed, path };
    });
    return { estimated: true, unmatched, sections: out };
  }

  return { matchRoute, lineCount: lines.length };
}
