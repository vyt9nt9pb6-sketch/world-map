// 前端呼叫自家後端 /api/*（不含任何金鑰）。
export class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function get(path, params, { signal } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  let res;
  try {
    res = await fetch(`${path}?${q}`, { signal, headers: { accept: 'application/json' } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('網路連線失敗，請檢查網路', 0, 'network');
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) throw new ApiError(body?.error?.message || `伺服器錯誤（${res.status}）`, res.status, body?.error?.code);
  return body;
}

async function send(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('網路連線失敗，請檢查網路', 0, 'network');
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* ignore */
  }
  if (!res.ok) {
    const e = new ApiError(json?.error?.message || `伺服器錯誤（${res.status}）`, res.status, json?.error?.code);
    e.retryAfter = Number(res.headers.get('retry-after')) || 0;
    throw e;
  }
  return json;
}

const ll = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export const api = {
  search: (q, center, opts = {}) => {
    const { area, radius, ...rest } = opts;
    return get('/api/search', { q, location: center ? ll(center) : undefined, area: area ? 1 : undefined, radius: area ? Math.round(radius) : undefined }, rest);
  },
  place: (id, opts) => get('/api/place', { id }, opts),
  geocode: (address, opts) => get('/api/geocode', { address }, opts),
  config: (opts) => get('/api/config', {}, opts),
  regeo: (p, radius, opts) => get('/api/regeo', { location: ll(p), radius }, opts),
  environment: (lat, lng, signal) => get('/api/environment', { lat, lng }, { signal }),
  weather: (lat, lng, opts) => get('/api/weather', { lat, lng }, opts),
  railLines: (opts) => get('/api/rail-lines', {}, opts),
  nearby: ({ kind, center, radius }, opts) => get('/api/nearby', { kind, location: ll(center), radius }, opts),
  authMe: () => get('/api/auth/me', {}),
  requestCode: (email) => send('POST', '/api/auth/request-code', { email }),
  verifyCode: (email, code) => send('POST', '/api/auth/verify', { email, code }),
  logout: () => send('POST', '/api/auth/logout', {}),
  favorites: () => get('/api/favorites', {}),
  syncFavorites: (items) => send('POST', '/api/favorites/sync', { items }),
  footprint: () => get('/api/footprint', {}),
  footprintAdd: (points) => send('POST', '/api/footprint', { points }),
  footprintClear: () => send('DELETE', '/api/footprint'),
  route: ({ start, dest, via = [], strategy, mode = 'driving', avoidHighway, avoidToll, depart }, opts) =>
    get(
      '/api/route',
      {
        origin: ll(start),
        destination: ll(dest),
        waypoints: via.length ? via.map(ll).join(';') : undefined,
        mode,
        strategy,
        avoid_highway: avoidHighway ? 1 : undefined,
        avoid_toll: avoidToll ? 1 : undefined,
        depart: depart || undefined,
        origin_id: start.poiId,
        destination_id: dest.poiId,
      },
      opts,
    ),
};
