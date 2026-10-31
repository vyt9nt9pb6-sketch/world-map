// 天地圖影像圖層（img_w / cia_w，EPSG:3857，座標是 WGS-84 真實座標）。
// 我們的地圖是 GCJ-02（高德）。同一張影像若直接疊上去會有數百公尺的偏移，
// 所以每個 GCJ 圖磚要去抓「對應的 WGS-84 圖磚」並平移後畫在 canvas 上。
// 條款：金鑰是瀏覽器型（限網域）；不經伺服器代理、不快取、不鏡像（只有瀏覽器自己的記憶體暫存）。
import { gcj02ToWgs84 } from './coords.js';

const TILE = 256;

/** 經緯度 → 縮放 z 的 Web Mercator 像素座標 */
export function mercatorPx(lng, lat, z) {
  const scale = TILE * 2 ** z;
  const x = ((lng + 180) / 360) * scale;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

export function pxToLngLat(x, y, z) {
  const scale = TILE * 2 ** z;
  const lng = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lng, lat };
}

/**
 * 顯示在 GCJ 圖磚 (x,y,z) 的畫面，需要從 WGS 圖磚空間的哪個矩形取像？
 * 回傳 { sx, sy }：來源矩形左上角（WGS 像素座標）；來源大小同為 256×256。
 */
export function sourceRect(x, y, z) {
  const cx = x * TILE + TILE / 2;
  const cy = y * TILE + TILE / 2;
  const gcj = pxToLngLat(cx, cy, z);
  const [wl, wa] = gcj02ToWgs84(gcj.lng, gcj.lat);
  const w = mercatorPx(wl, wa, z);
  // 四捨五入到 1/16 像素：避免浮點誤差讓「完全沒偏移」的圖磚多抓一塊鄰居
  const r = (v) => Math.round(v * 16) / 16;
  return { sx: r(x * TILE + (w.x - cx)), sy: r(y * TILE + (w.y - cy)) };
}

/** 來源矩形涵蓋哪些 WGS 圖磚，以及每塊要畫在 canvas 的哪個位置 */
export function coveringTiles(x, y, z) {
  const { sx, sy } = sourceRect(x, y, z);
  const max = 2 ** z;
  const x0 = Math.floor(sx / TILE);
  const x1 = Math.floor((sx + TILE - 1) / TILE);
  const y0 = Math.floor(sy / TILE);
  const y1 = Math.floor((sy + TILE - 1) / TILE);
  const out = [];
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (ty < 0 || ty >= max) continue;
      out.push({ tx: ((tx % max) + max) % max, ty, dx: Math.round(tx * TILE - sx), dy: Math.round(ty * TILE - sy) });
    }
  }
  return out;
}

export function tileUrl(layer, tk, z, x, y) {
  const sub = (x + y) % 8;
  const l = layer === 'labels' ? 'cia' : 'img';
  return `https://t${sub}.tianditu.gov.cn/${l}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${l}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}&tk=${encodeURIComponent(tk)}`;
}

export const TIANDITU_ATTRIBUTION = '© 天地圖 · 國家地理信息公共服務平台';

/**
 * 產生一個 GCJ 圖磚 (x,y,z) 的 canvas（把需要的 WGS 圖磚平移後畫上去）。
 * load(z,x,y) → Promise<HTMLImageElement|null>；回傳 Promise<canvas|null>（全部載入失敗 → null）。
 */
export async function renderTile(x, y, z, load, doc = document) {
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d');
  const oks = await Promise.all(
    coveringTiles(x, y, z).map(async (t) => {
      const img = await load(z, t.tx, t.ty);
      if (img) ctx.drawImage(img, t.dx, t.dy, TILE, TILE);
      return !!img;
    }),
  );
  return oks.some(Boolean) ? canvas : null;
}

/** 這張 GCJ 圖磚（以圖磚中心判斷）是否需要平移？境外（含框外）回傳 false，圖磚原封不動 */
export function tileIsShifted(x, y, z) {
  const { sx, sy } = sourceRect(x, y, z);
  return Math.abs(sx - x * TILE) > 0.5 || Math.abs(sy - y * TILE) > 0.5;
}

/**
 * 通用：把「WGS-84 的 Web Mercator 圖磚來源」變成高德 JS API 2.0 的 AMap.TileLayer.Flexible 圖層
 * （官方文件：3D 模式下自訂圖磚用 canvas 才不受 CORS 限制）。
 * 中國境內平移對齊高德 GCJ-02；境外高德座標＝WGS-84，不平移。
 * urlFor(z,x,y) → 圖磚網址。天地圖影像／注記與 ESA WorldCover 共用。
 */
export function createShiftedFlexible(AMap, { urlFor, zIndex = 3, opacity = 1, dataZooms = [3, 18], zooms = [3, 20] }) {
  const mem = new Map(); // 僅瀏覽器記憶體內的小型暫存：相鄰 GCJ 圖磚重複使用同一批 WGS 圖磚
  const load = (z, x, y) => {
    const key = `${z}/${x}/${y}`;
    if (mem.has(key)) return mem.get(key);
    // 先用 crossOrigin（3D/WebGL 需要未污染的 canvas）；若來源沒有回 CORS 標頭而失敗，退回一般載入（2D 模式仍可顯示）
    const attempt = (cors) =>
      new Promise((resolve) => {
        const img = new Image();
        if (cors) img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = urlFor(z, x, y);
      });
    const p = attempt(true).then((img) => img || attempt(false));
    mem.set(key, p);
    if (mem.size > 96) mem.delete(mem.keys().next().value);
    return p;
  };
  return new AMap.TileLayer.Flexible({
    cacheSize: 80,
    zIndex,
    opacity,
    dataZooms,
    zooms,
    createTile(x, y, z, success, fail) {
      renderTile(x, y, z, load).then((c) => (c ? success(c) : fail()), () => fail());
    },
  });
}

/** 天地圖影像（img_w）或影像注記（cia_w）。kind: 'imagery' | 'labels'。全球可用；境外影像約 500 m 解析度。 */
export function createTiandituFlexible(AMap, { tk, kind = 'imagery', zIndex }) {
  return createShiftedFlexible(AMap, {
    urlFor: (z, x, y) => tileUrl(kind, tk, z, x, y),
    zIndex: zIndex ?? (kind === 'imagery' ? 3 : 4),
    dataZooms: [3, 18],
  });
}
