// 把高德的原始回應整理成前端用的精簡格式（不回傳任何上游 URL 或金鑰）。

// 高德有時用 [] 表示空字串
const str = (v) => (Array.isArray(v) ? v.join('') : v == null ? '' : String(v));
const num = (v) => {
  const t = str(v).trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

export function parseLocation(s) {
  const t = str(s);
  const m = /^\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t);
  if (!m) return null;
  return { lng: Number(m[1]), lat: Number(m[2]) };
}

export function mapPoi(p) {
  const loc = parseLocation(p.location);
  if (!loc) return null;
  return {
    kind: 'poi',
    id: str(p.id) || null,
    name: str(p.name),
    address: str(p.address),
    type: str(p.type),
    province: str(p.pname),
    city: str(p.cityname),
    district: str(p.adname),
    adcode: str(p.adcode),
    distance: num(p.distance),
    tel: str(p.business?.tel ?? p.tel) || null,
    lng: loc.lng,
    lat: loc.lat,
  };
}

export function mapSearchResponse(json, source) {
  const pois = Array.isArray(json?.pois) ? json.pois : [];
  return {
    source,
    count: num(json?.count) ?? pois.length,
    results: pois.map(mapPoi).filter(Boolean),
  };
}

export function mapGeocodeResponse(json) {
  const list = Array.isArray(json?.geocodes) ? json.geocodes : [];
  return {
    results: list
      .map((g) => {
        const loc = parseLocation(g.location);
        if (!loc) return null;
        return {
          kind: 'address',
          id: null,
          name: str(g.formatted_address),
          address: [str(g.province), str(g.city), str(g.district)].filter(Boolean).join(' '),
          level: str(g.level),
          province: str(g.province),
          city: str(g.city),
          district: str(g.district),
          adcode: str(g.adcode),
          lng: loc.lng,
          lat: loc.lat,
        };
      })
      .filter(Boolean),
  };
}

/** "lng,lat;lng,lat" → [[lng,lat], ...]（無效點略過） */
export function decodePolyline(s) {
  const out = [];
  for (const pair of str(s).split(';')) {
    const loc = parseLocation(pair);
    if (loc) out.push([loc.lng, loc.lat]);
  }
  return out;
}

export function mapRouteResponse(json, strategy) {
  const paths = Array.isArray(json?.route?.paths) ? json.route.paths : [];
  return {
    strategy,
    taxiCost: num(json?.route?.taxi_cost),
    routes: paths.map((p, idx) => {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const coords = [];
      for (const s of steps) {
        const pts = decodePolyline(s.polyline);
        // 相鄰分段首尾常重複，去重
        if (coords.length && pts.length) {
          const a = coords[coords.length - 1];
          const b = pts[0];
          if (a[0] === b[0] && a[1] === b[1]) pts.shift();
        }
        for (const pt of pts) coords.push(pt);
      }
      // 主要道路：依各道路累計里程取前 8 條，再按行駛順序排列（長途時才會看到 G15、G25 這類幹道）
      const roadLen = new Map();
      for (const s of steps) {
        const r = str(s.road_name);
        if (!r) continue;
        const prev = roadLen.get(r);
        roadLen.set(r, { order: prev ? prev.order : roadLen.size, len: (prev ? prev.len : 0) + (num(s.step_distance) || 0) });
      }
      const roads = [...roadLen.entries()]
        .sort((a, b) => b[1].len - a[1].len)
        .slice(0, 8)
        .sort((a, b) => a[1].order - b[1].order)
        .map(([name]) => name);
      return {
        index: idx,
        distance: num(p.distance), // 公尺
        duration: num(p.cost?.duration), // 秒
        tolls: num(p.cost?.tolls), // 元
        tollDistance: num(p.cost?.toll_distance), // 公尺
        trafficLights: num(p.cost?.traffic_lights),
        restriction: str(p.restriction) === '1',
        roads,
        steps: steps.map((s) => ({
          instruction: str(s.instruction),
          road: str(s.road_name),
          distance: num(s.step_distance),
          duration: num(s.cost?.duration),
        })),
        polyline: coords,
      };
    }),
  };
}

// ───────────────────────────── v2：步行／騎行／電動車／公交 ─────────────────────────────

/** 高德有時用字串、有時用 {polyline: "..."} 包一層 */
function polylineText(p) {
  if (p && typeof p === 'object' && !Array.isArray(p)) return str(p.polyline);
  return str(p);
}

function joinPolylines(parts) {
  const coords = [];
  for (const part of parts) {
    const pts = decodePolyline(polylineText(part));
    if (coords.length && pts.length) {
      const a = coords[coords.length - 1];
      const b = pts[0];
      if (a[0] === b[0] && a[1] === b[1]) pts.shift();
    }
    for (const pt of pts) coords.push(pt);
  }
  return coords;
}

/** 步行／騎行／電動車：結構相同（route.paths[].steps[]） */
export function mapPathRouteResponse(json, mode) {
  const paths = Array.isArray(json?.route?.paths) ? json.route.paths : [];
  return {
    mode,
    routes: paths.map((p, idx) => {
      const steps = Array.isArray(p.steps) ? p.steps : [];
      const stepDur = steps.reduce((a, s) => a + (num(s.cost?.duration) || 0), 0);
      return {
        index: idx,
        distance: num(p.distance),
        // 步行把時間放在 cost.duration；騎行／電動車放在路徑層的 duration
        duration: num(p.cost?.duration) ?? num(p.duration) ?? (stepDur || null),
        steps: steps.map((s) => ({
          instruction: str(s.instruction),
          road: str(s.road_name),
          distance: num(s.step_distance),
          duration: num(s.cost?.duration),
        })),
        polyline: joinPolylines(steps.map((s) => s.polyline)),
      };
    }),
  };
}

/** 高德鐵路站座標是 "lng lat"（空白分隔），公交站是 "lng,lat" */
export function parseSpaceLocation(s) {
  return parseLocation(str(s).trim().replace(/\s+/, ','));
}

function mapStop(s, extra = {}) {
  const loc = parseSpaceLocation(s?.location);
  return { name: str(s?.name), lng: loc?.lng ?? null, lat: loc?.lat ?? null, ...extra };
}

/** "1705" → "17:05" */
function hhmm(v) {
  const t = str(v);
  return /^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : '';
}

function mapWalking(w) {
  const steps = Array.isArray(w.steps) ? w.steps : [];
  return {
    type: 'walk',
    distance: num(w.distance),
    duration: num(w.cost?.duration),
    steps: steps.map((s) => ({ instruction: str(s.instruction), road: str(s.road), distance: num(s.distance) })),
    polyline: joinPolylines(steps.map((s) => s.polyline)),
  };
}

function mapBusline(b) {
  const type = str(b.type);
  const isSubway = type.includes('地铁') || /^地铁|轨道交通/.test(str(b.name));
  const via = Array.isArray(b.via_stops) ? b.via_stops : [];
  return {
    type: isSubway ? 'subway' : 'bus',
    name: str(b.name),
    kind: type,
    distance: num(b.distance),
    duration: num(b.cost?.duration),
    from: mapStop(b.departure_stop),
    to: mapStop(b.arrival_stop),
    viaStops: via.map((s) => mapStop(s)),
    startTime: hhmm(b.start_time),
    endTime: hhmm(b.end_time),
    polyline: joinPolylines([b.polyline]),
  };
}

function mapRailway(r) {
  const via = Array.isArray(r.via_stops) ? r.via_stops : [];
  const spaces = Array.isArray(r.spaces) ? r.spaces : [];
  // 各席別最低價（元）
  const prices = {};
  for (const sp of spaces) {
    const c = num(sp.cost);
    const k = str(sp.code).replace(/^火车/, '');
    if (c != null && k && (prices[k] == null || c < prices[k])) prices[k] = c;
  }
  const dep = r.departure_stop || {};
  const arr = r.arrival_stop || {};
  const stops = [
    mapStop(dep, { time: hhmm(dep.time), role: 'dep' }),
    ...via.map((s) => mapStop(s, { time: hhmm(s.time), wait: num(s.wait), role: 'via' })),
    mapStop(arr, { time: hhmm(arr.time), role: 'arr' }),
  ];
  return {
    type: 'train',
    trip: str(r.trip),
    name: str(r.name),
    trainType: str(r.type),
    distance: num(r.distance),
    duration: num(r.time),
    from: stops[0],
    to: stops[stops.length - 1],
    stops, // 起點 → 中途停靠站 → 終點（高德提供，是這班車實際停靠的站）
    prices,
    alters: (Array.isArray(r.alters) ? r.alters : []).map((a) => str(a.name)).filter(Boolean).slice(0, 6),
  };
}

export function mapTransitResponse(json) {
  const transits = Array.isArray(json?.route?.transits) ? json.route.transits : [];
  return {
    mode: 'transit',
    routes: transits.map((t, idx) => {
      const segments = [];
      for (const seg of Array.isArray(t.segments) ? t.segments : []) {
        if (seg.walking && (num(seg.walking.distance) || (seg.walking.steps || []).length)) segments.push(mapWalking(seg.walking));
        const line = seg.bus?.buslines?.[0];
        if (line) segments.push(mapBusline(line));
        if (seg.railway && (seg.railway.departure_stop || seg.railway.name)) segments.push(mapRailway(seg.railway));
      }
      return {
        index: idx,
        distance: num(t.distance),
        duration: num(t.cost?.duration),
        fee: num(t.cost?.transit_fee),
        walkingDistance: num(t.walking_distance),
        segments,
        polyline: [], // 由 handler 在鐵路線路配對後組合
      };
    }),
  };
}
