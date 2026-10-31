// Mapbox／Google 衛星圖磚（WGS-84 Web Mercator），經 createShiftedFlexible 疊到高德 GCJ 圖面。
// Kwok 明確要求加入；大陸常需 VPN。金鑰由 /api/config 在有 secret 時才下發（與天地圖 tk 相同模式）。
import { createShiftedFlexible } from './tianditu.js';

export const MAPBOX_ATTRIBUTION = '© Mapbox © OpenStreetMap';
export const GOOGLE_ATTRIBUTION = '© Google';

/** Mapbox Satellite 圖磚（Raster Tiles API：mapbox.satellite；亦可用 styles/satellite-v9） */
export function mapboxSatUrl(token, z, x, y) {
  return `https://api.mapbox.com/v4/mapbox.satellite/${z}/${x}/${y}@2x.jpg?access_token=${encodeURIComponent(token)}`;
}

/** Google Map Tiles API 2D satellite（需 session + key） */
export function googleSatUrl(key, session, z, x, y) {
  return `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(key)}`;
}

export function createMapboxSatFlexible(AMap, { token, zIndex = 3 }) {
  return createShiftedFlexible(AMap, {
    urlFor: (z, x, y) => mapboxSatUrl(token, z, x, y),
    zIndex,
    dataZooms: [1, 19],
  });
}

/**
 * Google 衛星：session 由 getSession() 取得（字串或 Promise<string>）。
 * 圖磚網址每次即時讀取最新 session（過期後呼叫端可刷新）。
 */
export function createGoogleSatFlexible(AMap, { key, getSession, zIndex = 3 }) {
  return createShiftedFlexible(AMap, {
    urlFor: (z, x, y) => {
      const s = typeof getSession === 'function' ? getSession() : getSession;
      // createTile 是 sync 呼叫 url；session 必須已就緒（呼叫端先 await）
      const session = typeof s === 'string' ? s : '';
      return googleSatUrl(key, session, z, x, y);
    },
    zIndex,
    dataZooms: [1, 19],
  });
}
