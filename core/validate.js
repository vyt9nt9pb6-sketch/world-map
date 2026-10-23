// 參數驗證／白名單。所有對外輸入都要經過這裡，只有驗證後的值才會被轉送到高德。

export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

// 去掉控制字元，壓縮空白
function cleanText(v) {
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function text(params, field, { required = false, max = 80 } = {}) {
  const raw = params.get(field);
  if (raw == null || cleanText(raw) === '') {
    if (required) throw new ValidationError(field, `缺少參數 ${field}`);
    return undefined;
  }
  const v = cleanText(raw);
  if ([...v].length > max) throw new ValidationError(field, `${field} 太長（最多 ${max} 字）`);
  return v;
}

const NUM = /^-?\d{1,3}(\.\d+)?$/;

/** 解析 "lng,lat" 字串，回傳四捨五入到 6 位小數的字串 "lng,lat"（高德規定小數不超過 6 位）。 */
export function parseLngLat(str, field = 'location') {
  if (typeof str !== 'string') throw new ValidationError(field, `${field} 格式錯誤`);
  const parts = str.split(',');
  if (parts.length !== 2 || !NUM.test(parts[0].trim()) || !NUM.test(parts[1].trim())) {
    throw new ValidationError(field, `${field} 必須是「經度,緯度」`);
  }
  const lng = Number(parts[0]);
  const lat = Number(parts[1]);
  if (!(lng >= -180 && lng <= 180) || !(lat >= -90 && lat <= 90)) {
    throw new ValidationError(field, `${field} 超出範圍`);
  }
  return `${round6(lng)},${round6(lat)}`;
}

function round6(n) {
  return String(Math.round(n * 1e6) / 1e6);
}

export function lngLat(params, field, { required = false } = {}) {
  const raw = params.get(field);
  if (raw == null || raw.trim() === '') {
    if (required) throw new ValidationError(field, `缺少參數 ${field}`);
    return undefined;
  }
  return parseLngLat(raw.trim(), field);
}

export function lngLatList(params, field, { max = 16 } = {}) {
  const raw = params.get(field);
  if (raw == null || raw.trim() === '') return [];
  const items = raw.split(';').map((s) => s.trim()).filter(Boolean);
  if (items.length > max) throw new ValidationError(field, `${field} 最多 ${max} 個`);
  return items.map((s) => parseLngLat(s, field));
}

export function int(params, field, { min, max, def }) {
  const raw = params.get(field);
  if (raw == null || raw === '') return def;
  if (!/^\d{1,4}$/.test(raw)) throw new ValidationError(field, `${field} 必須是整數`);
  const n = Number(raw);
  if (n < min || n > max) throw new ValidationError(field, `${field} 必須介於 ${min}–${max}`);
  return n;
}

export function oneOf(params, field, allowed, def) {
  const raw = params.get(field);
  if (raw == null || raw === '') return def;
  if (!Object.prototype.hasOwnProperty.call(allowed, raw)) {
    throw new ValidationError(field, `${field} 不支援：可用 ${Object.keys(allowed).join(', ')}`);
  }
  return raw;
}

const POI_ID = /^[A-Za-z0-9]{6,20}$/;
export function poiId(params, field) {
  const raw = params.get(field);
  if (raw == null || raw === '') return undefined;
  if (!POI_ID.test(raw)) throw new ValidationError(field, `${field} 格式錯誤`);
  return raw;
}

/** 路線策略：App 內的名稱 → 高德 v5 driving strategy 代碼 */
export const ROUTE_STRATEGIES = {
  recommend: '32', // 高德推薦（同高德 App 預設，可回傳多條）
  fastest: '38', // 速度最快
  avoid_tolls: '1', // 費用優先：不走收費路段且耗時最少
  highway: '34', // 高速優先
  no_highway: '35', // 不走高速
};

export function validateSearch(params) {
  return {
    keywords: text(params, 'q', { required: true, max: 80 }),
    location: lngLat(params, 'location'),
    city: text(params, 'city', { max: 30 }),
    page: int(params, 'page', { min: 1, max: 10, def: 1 }),
  };
}

export function validateGeocode(params) {
  return {
    address: text(params, 'address', { required: true, max: 100 }),
    city: text(params, 'city', { max: 30 }),
  };
}

export function validateRoute(params) {
  const v = {
    origin: lngLat(params, 'origin', { required: true }),
    destination: lngLat(params, 'destination', { required: true }),
    waypoints: lngLatList(params, 'waypoints', { max: 16 }),
    strategy: oneOf(params, 'strategy', ROUTE_STRATEGIES, 'recommend'),
    originId: poiId(params, 'origin_id'),
    destinationId: poiId(params, 'destination_id'),
  };
  if (v.origin === v.destination) throw new ValidationError('destination', '起點和終點相同');
  return v;
}
