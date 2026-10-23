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

const ll = (p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export const api = {
  search: (q, center, opts) => get('/api/search', { q, location: center ? ll(center) : undefined }, opts),
  geocode: (address, opts) => get('/api/geocode', { address }, opts),
  route: ({ start, dest, via = [], strategy }, opts) =>
    get(
      '/api/route',
      {
        origin: ll(start),
        destination: ll(dest),
        waypoints: via.length ? via.map(ll).join(';') : undefined,
        strategy,
        origin_id: start.poiId,
        destination_id: dest.poiId,
      },
      opts,
    ),
};
