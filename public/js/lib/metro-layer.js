// 「大眾運輸」圖層的資料層：城市地鐵／輕軌／磁浮線路（OpenStreetMap，ODbL；scripts/build-metro-lines.mjs 產生）。
// 資料依地理格子切成 gzip 小檔（/data/metro/<格>.json.gz），只載入畫面附近的格子。座標已是 GCJ-02（與高德底圖對齊）。

/** 解開一個格子：整數（1e-5 度）差分 → [lng, lat] 陣列 */
export function decodeCell(cell) {
  const q = cell.q || 1e5;
  return (cell.lines || []).map((l) => ({
    kind: l.k,
    name: l.n,
    ref: l.r,
    color: l.c,
    paths: l.p.map((flat) => {
      const pts = [];
      let x = flat[0];
      let y = flat[1];
      pts.push([x / q, y / q]);
      for (let i = 2; i + 1 < flat.length; i += 2) {
        x += flat[i];
        y += flat[i + 1];
        pts.push([x / q, y / q]);
      }
      return pts;
    }),
    stations: (l.s || []).map(([name, sx, sy]) => ({ name, lng: sx / q, lat: sy / q })),
  }));
}

/** 與畫面範圍（可加邊界 margin 度）相交的格子 id */
export function cellsForBounds(index, b, margin = 0.15) {
  if (!index?.cells) return [];
  return index.cells
    .filter((c) => c.bbox[0] <= b.east + margin && c.bbox[2] >= b.west - margin && c.bbox[1] <= b.north + margin && c.bbox[3] >= b.south - margin)
    .map((c) => c.id);
}

export const KIND_LABEL = { subway: '地鐵', light_rail: '輕軌', monorail: '單軌', maglev: '磁浮' };

/** 去重後的站點（同名且 200 m 內視為同一站；多條線經過者標為轉乘站） */
export function collectStations(lines, bounds) {
  const map = new Map();
  for (const l of lines) {
    for (const s of l.stations) {
      if (bounds && (s.lng < bounds.west || s.lng > bounds.east || s.lat < bounds.south || s.lat > bounds.north)) continue;
      const k = `${s.name}|${s.lng.toFixed(2)}|${s.lat.toFixed(2)}`;
      let e = map.get(k);
      if (!e) map.set(k, (e = { name: s.name, lng: s.lng, lat: s.lat, colors: [], kinds: new Set() }));
      if (!e.colors.includes(l.color)) e.colors.push(l.color);
      e.kinds.add(l.kind);
    }
  }
  return [...map.values()].map((e) => ({ ...e, transfer: e.colors.length > 1 }));
}

export function createMetroLoader({ fetchImpl = (...a) => fetch(...a), base = '/data/metro' } = {}) {
  let index = null;
  let indexP = null;
  const cells = new Map(); // id -> lines | Promise
  async function ungzip(res) {
    if (typeof DecompressionStream === 'undefined') throw new Error('此瀏覽器不支援解壓縮（需要 iOS 16.4 以上）');
    const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).json();
  }
  async function ensureIndex() {
    if (index) return index;
    indexP ||= fetchImpl(`${base}/index.json`).then((r) => {
      if (!r.ok) throw new Error(`索引載入失敗 ${r.status}`);
      return r.json();
    });
    try {
      index = await indexP;
    } finally {
      if (!index) indexP = null;
    }
    return index;
  }
  /** 載入與範圍相交的格子，回傳 { lines, added }（added＝這次新增了哪些線路） */
  async function load(bounds) {
    const idx = await ensureIndex();
    const ids = cellsForBounds(idx, bounds);
    const added = [];
    await Promise.all(
      ids.map(async (id) => {
        if (cells.has(id)) return;
        const p = fetchImpl(`${base}/${id}.json.gz`)
          .then((r) => {
            if (!r.ok) throw new Error(`格子 ${id} 載入失敗 ${r.status}`);
            return ungzip(r);
          })
          .then((c) => decodeCell(c));
        cells.set(id, p);
        try {
          const lines = await p;
          cells.set(id, lines);
          added.push(...lines);
        } catch (e) {
          cells.delete(id);
          throw e;
        }
      }),
    );
    const lines = [];
    for (const id of ids) {
      const v = cells.get(id);
      if (Array.isArray(v)) lines.push(...v);
    }
    return { lines, added, ids };
  }
  return { load, ensureIndex, _cells: cells };
}
