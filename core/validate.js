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

/** 導航方式：driving 駕車、walking 步行、bicycling 騎行、electrobike 電動車、transit 公交／鐵路（含火車） */
export const ROUTE_MODES = { driving: 1, walking: 1, bicycling: 1, electrobike: 1, transit: 1 };

/** 公交策略：高德 v5 transit strategy 代碼 */
export const TRANSIT_STRATEGIES = {
  recommend: '0', // 推薦
  cheapest: '1', // 最經濟
  least_transfer: '2', // 最少換乘
  least_walk: '3', // 最少步行
  comfortable: '5', // 不乘地鐵
  subway_first: '7', // 地鐵優先
  fastest: '8', // 時間短
  // 高德 v5 沒有「鐵路／火車優先」的 strategy（只有 7＝地鐵優先）。
  // rail_first 是本服務自己的排序：同時查多種策略、合併後把含火車段的方案排前面（見 handlers.js）。
  rail_first: '0',
};

const CITY_CODE = /^[0-9]{3,6}$/;
export function cityCode(params, field) {
  const raw = params.get(field);
  if (raw == null || raw.trim() === '') return undefined;
  if (!CITY_CODE.test(raw.trim())) throw new ValidationError(field, `${field} 必須是城市區號或行政區代碼`);
  return raw.trim();
}

export function validateRoute(params) {
  const mode = oneOf(params, 'mode', ROUTE_MODES, 'driving');
  const v = {
    mode,
    city1: cityCode(params, 'city1'),
    city2: cityCode(params, 'city2'),
    origin: lngLat(params, 'origin', { required: true }),
    destination: lngLat(params, 'destination', { required: true }),
    waypoints: lngLatList(params, 'waypoints', { max: 16 }),
    strategy:
      mode === 'driving'
        ? oneOf(params, 'strategy', ROUTE_STRATEGIES, 'recommend')
        : mode === 'transit'
          ? oneOf(params, 'strategy', TRANSIT_STRATEGIES, 'recommend')
          : 'recommend',
    originId: poiId(params, 'origin_id'),
    destinationId: poiId(params, 'destination_id'),
  };
  if (v.origin === v.destination) throw new ValidationError('destination', '起點和終點相同');
  if (mode !== 'driving' && v.waypoints.length) throw new ValidationError('waypoints', '只有駕車支援途經點');
  return v;
}

/** 附近搜尋的種類 → 高德 POI 分類碼 */
export const NEARBY_TYPES = {
  toilet: '200300', // 公共厠所
  gas: '010100', // 加油站
  ev: '011100', // 充電站
};

export function validateNearby(params) {
  const kind = oneOf(params, 'kind', NEARBY_TYPES, undefined);
  if (!kind) throw new ValidationError('kind', '缺少參數 kind');
  return {
    kind,
    location: lngLat(params, 'location', { required: true }),
    radius: int(params, 'radius', { min: 100, max: 10000, def: 3000 }),
    limit: int(params, 'limit', { min: 1, max: 25, def: 25 }),
  };
}

/** 點選地圖：逆地理編碼＋附近 POI（半徑單位：公尺） */
export function validateRegeo(params) {
  return {
    location: lngLat(params, 'location', { required: true }),
    radius: int(params, 'radius', { min: 10, max: 300, def: 50 }),
  };
}

const COORD = /^-?\d{1,3}(\.\d{1,8})?$/;
/** 海拔／氣壓：WGS-84 座標（瀏覽器定位的原始座標）。四捨五入到 0.01° 以提高快取命中，也不精確洩漏位置。 */
export function validateEnvironment(params) {
  const read = (f, lim) => {
    const raw = params.get(f);
    if (raw == null || !COORD.test(raw.trim())) throw new ValidationError(f, `${f} 必須是數字`);
    const n = Number(raw);
    if (!(Math.abs(n) <= lim)) throw new ValidationError(f, `${f} 超出範圍`);
    return Math.round(n * 100) / 100;
  };
  return { lat: read('lat', 90), lng: read('lng', 180) };
}
