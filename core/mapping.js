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
