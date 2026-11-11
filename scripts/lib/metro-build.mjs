// 把 Overpass 的 route 關係（out geom）整理成「大眾運輸」圖層用的格子資料。純函式，方便測試。
// 資料授權：© OpenStreetMap contributors，ODbL 1.0。

export const CELL_DEG = 2;
const Q = 1e5; // 1e-5 度 ≈ 1 公尺
const PALETTE = ['#e4002b', '#0072ce', '#00a651', '#f7941d', '#8a2be2', '#00a3a1', '#d6006d', '#7b5e3b', '#4a4fc4', '#6bbf2a', '#d4a017', '#0097a7'];
const NAMED = { red: '#e4002b', blue: '#0072ce', green: '#00a651', orange: '#f7941d', yellow: '#f2c200', purple: '#8a2be2', pink: '#e56fa8', brown: '#7b5e3b', grey: '#7f8c8d', gray: '#7f8c8d', black: '#333333', cyan: '#00a3a1', teal: '#00a3a1' };

export function normColor(c) {
  if (!c) return null;
  const s = String(c).trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((x) => x + x).join('');
  if (h === 'ffffff') return null;
  return '#' + h;
}
const hash = (s) => [...s].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
export const cleanName = (n) => {
  const s = String(n || '').trim();
  return /[\u4e00-\u9fff]/.test(s) ? s.replace(/\s+[A-Za-z][\s\S]*$/, '').trim() : s;
};
const baseName = (n) => String(n || '').split(/[:：]/)[0].trim();

export function relKind(t) {
  if (/磁浮|磁悬浮|磁懸浮|maglev/i.test(`${t.name || ''} ${t['name:en'] || ''}`)) return 'maglev';
  return t.route === 'light_rail' ? 'light_rail' : t.route === 'monorail' ? 'monorail' : 'subway';
}

/** 簡化折線（Douglas–Peucker，tol 單位：公尺） */
export function simplify(pts, tolM = 8) {
  if (pts.length < 3) return pts;
  const k = Math.cos((pts[0][1] * Math.PI) / 180);
  const P = pts.map(([x, y]) => [x * 111320 * k, y * 110540]);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0;
    let mi = -1;
    const [ax, ay] = P[a];
    const dx = P[b][0] - ax;
    const dy = P[b][1] - ay;
    const L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (ay - P[i][1]) - (ax - P[i][0]) * dy) / L;
      if (d > md) (md = d), (mi = i);
    }
    if (md > tolM && mi > 0) {
      keep[mi] = 1;
      stack.push([a, mi], [mi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

const ek = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
/** 把一堆折線首尾相接串成較長的折線 */
export function stitch(ways) {
  const ends = new Map();
  ways.forEach((w, i) => {
    for (const p of [w[0], w[w.length - 1]]) {
      const k = ek(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const used = new Set();
  const out = [];
  const take = (p, chain, atTail) => {
    for (;;) {
      const next = (ends.get(ek(p)) || []).find((i) => !used.has(i));
      if (next == null) return;
      used.add(next);
      let w = ways[next];
      const startsHere = ek(w[0]) === ek(p);
      if (atTail) {
        w = startsHere ? w : [...w].reverse();
        chain.push(...w.slice(1));
        p = chain[chain.length - 1];
      } else {
        w = startsHere ? [...w].reverse() : w;
        chain.unshift(...w.slice(0, -1));
        p = chain[0];
      }
    }
  };
  ways.forEach((w, i) => {
    if (used.has(i)) return;
    used.add(i);
    const chain = [...w];
    take(chain[chain.length - 1], chain, true);
    take(chain[0], chain, false);
    out.push(chain);
  });
  return out;
}

const OK_ROLE = /^(|forward|backward|main|route)$/;
const STOP_ROLE = /^(stop|stop_entry_only|stop_exit_only)$/;
const PLAT_ROLE = /^(platform|platform_entry_only|platform_exit_only)$/;

export const STATION_SNAP_M = 150;
/** 點到一組折線的最短距離（公尺，局部平面近似） */
export function distToChains(chains, lon, lat) {
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  for (const c of chains) {
    for (let i = 1; i < c.length; i++) {
      const ax = (c[i - 1][0] - lon) * kx, ay = (c[i - 1][1] - lat) * ky;
      const bx = (c[i][0] - lon) * kx, by = (c[i][1] - lat) * ky;
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

export function buildMetro(rels, { toGcj = (x, y) => [x, y], tolM = 8 } = {}) {
  const groups = new Map();
  const nodeTags = new Map(rels.filter((e) => e.type === 'node').map((e) => [e.id, e.tags || {}]));
  const nodeName = (m) => cleanName(nodeTags.get(m.ref)?.name || m.tags?.name || '');
  for (const r of rels) {
    if (r.type !== 'relation') continue;
    const t = r.tags || {};
    if (/^(proposed|construction|disused|abandoned)$/.test(t.state || '') || t.disused === 'yes') continue;
    const mem = r.members || [];
    const ways = mem
      .filter((m) => m.type === 'way' && OK_ROLE.test(m.role || '') && Array.isArray(m.geometry))
      .map((m) => ({ ...m, geometry: m.geometry.filter(Boolean) })) // 範圍外的點 Overpass 會給 null
      .filter((m) => m.geometry.length > 1);
    if (!ways.length) continue;
    const c0 = ways[0].geometry[0];
    const base = baseName(t.name) || t.ref || String(r.id);
    const net = t.network || t.operator || '';
    const cellKey = net ? '' : `${Math.floor(c0.lon / CELL_DEG)}_${Math.floor(c0.lat / CELL_DEG)}`;
    const key = `${net}|${t.ref || base}|${cellKey}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, kind: relKind(t), name: base, ref: t.ref || '', color: null, ways: new Map(), stops: [], plats: [] }));
    g.color ||= normColor(t.colour);
    if (relKind(t) === 'maglev') g.kind = 'maglev';
    for (const w of ways) if (!g.ways.has(w.ref)) g.ways.set(w.ref, w.geometry.map((p) => [p.lon, p.lat]));
    for (const m of mem) {
      if (m.type !== 'node') continue;
      const rl = m.role || '';
      if (STOP_ROLE.test(rl)) g.stops.push(m);
      else if (PLAT_ROLE.test(rl)) g.plats.push(m);
    }
  }

  const cells = {};
  const stats = { lines: 0, chains: 0, points: 0, stations: 0 };
  const iq = (g) => {
    const [x, y] = toGcj(g[0], g[1]);
    return [Math.round(x * Q), Math.round(y * Q)];
  };
  for (const g of groups.values()) {
    const chains = stitch([...g.ways.values()])
      .map((c) => simplify(c, tolM))
      .filter((c) => c.length >= 2);
    if (!chains.length) continue;
    const paths = chains.map((c) => {
      const q = c.map(iq);
      const flat = [q[0][0], q[0][1]];
      for (let i = 1; i < q.length; i++) flat.push(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]);
      stats.points += q.length;
      return flat;
    });
    // 站點：優先用有名字的 stop 節點，沒有就用 platform
    const named = (arr) => arr.filter((m) => m.lat != null && nodeName(m));
    const nodes = named(g.stops).length >= 2 ? named(g.stops) : named(g.plats);
    const seen = new Set();
    const stations = [];
    for (const m of nodes) {
      const nm = nodeName(m);
      if (seen.has(nm)) continue;
      if (distToChains(chains, m.lon, m.lat) > STATION_SNAP_M) continue; // 離線路太遠的是支線／別條線的站，丟掉
      seen.add(nm);
      stations.push([nm, ...iq([m.lon, m.lat])]);
    }
    const color = g.color || PALETTE[hash(g.key) % PALETTE.length];
    const flatPts = chains.flat();
    const lngs = flatPts.map((p) => p[0]);
    const lats = flatPts.map((p) => p[1]);
    const box = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
    const cid = `${Math.floor(((box[0] + box[2]) / 2) / CELL_DEG)}_${Math.floor(((box[1] + box[3]) / 2) / CELL_DEG)}`;
    const cell = (cells[cid] ||= { lines: [], bbox: [Infinity, Infinity, -Infinity, -Infinity] });
    cell.lines.push({ k: g.kind, n: g.name, r: g.ref, c: color, p: paths, s: stations });
    const [gx0, gy0] = toGcj(box[0], box[1]);
    const [gx1, gy1] = toGcj(box[2], box[3]);
    cell.bbox = [Math.min(cell.bbox[0], gx0), Math.min(cell.bbox[1], gy0), Math.max(cell.bbox[2], gx1), Math.max(cell.bbox[3], gy1)];
    stats.lines++;
    stats.chains += chains.length;
    stats.stations += stations.length;
  }
  const index = { v: 1, q: Q, attribution: '© OpenStreetMap contributors (ODbL)', cells: [] };
  const out = {};
  for (const [id, c] of Object.entries(cells)) {
    out[id] = { v: 1, q: Q, lines: c.lines };
    index.cells.push({ id, bbox: c.bbox.map((v) => +v.toFixed(4)), n: c.lines.length });
  }
  return { cells: out, index, stats };
}
