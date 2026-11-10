// 中國人口密度疊加層（2020 年靜態估計，不是即時人流）。
// 資料：Chen et al. 2024 第七次人口普查 100 m 網格（CC BY 4.0），建置時加總成較粗的經緯網格。
// 網格是 WGS-84。高德底圖在中國境內是 GCJ-02，所以取樣與上色都只在中國範圍做偏移；境外轉換是恆等（這份資料本來就沒有境外）。
import { gcj02ToWgs84, wgs84ToGcj02 } from './coords.js';
import { mercatorPx, pxToLngLat } from './tianditu.js';

export const POP_LOG_SCALE = 14;
export const POP_URL = '/data/pop/china2020.bin.gz';
export const POP_ATTRIBUTION =
  'Chen, Xu, Ge, Zhang & Zhou (2024). A 100-m gridded population dataset of China’s seventh census. figshare. CC BY 4.0. https://doi.org/10.6084/m9.figshare.24916140';

/** 圖例停靠點（人/km²）。顏色是連續熱力，不是分類填色。 */
export const DENSITY_STOPS = [
  { d: 1, label: '1', hex: '#3050dc', rgb: [48, 80, 220] },
  { d: 10, label: '10', hex: '#00b0f0', rgb: [0, 176, 240] },
  { d: 50, label: '50', hex: '#00c88c', rgb: [0, 200, 140] },
  { d: 200, label: '200', hex: '#aad428', rgb: [170, 212, 40] },
  { d: 500, label: '500', hex: '#ffc400', rgb: [255, 196, 0] },
  { d: 1500, label: '1千', hex: '#ff7800', rgb: [255, 120, 0] },
  { d: 5000, label: '5千', hex: '#e6281e', rgb: [230, 40, 30] },
  { d: 20000, label: '2萬+', hex: '#780028', rgb: [120, 0, 40] },
];

export function encodeDensity(d, scale = POP_LOG_SCALE) {
  if (!(d >= 1) || !Number.isFinite(d)) return 0;
  const code = Math.round(Math.log2(d) * scale);
  return Math.max(1, Math.min(255, code));
}

export function decodeDensity(code, scale = POP_LOG_SCALE) {
  if (!code) return 0;
  return 2 ** (code / scale);
}

/** 約略格子邊長（公里），給畫面上的解析度說明。 */
export function approxCellKm(step, lat = 35) {
  if (!(step > 0)) return null;
  const latKm = step * 110.574;
  const lonKm = step * 111.32 * Math.cos((lat * Math.PI) / 180);
  return Math.round(((latKm + lonKm) / 2) * 10) / 10;
}

export function populationNote(grid) {
  const km = grid ? approxCellKm(grid.step) : null;
  const res = km ? `畫面網格約 ${km} 公里（由 100 公尺普查格子加總，數值是人/km²）。` : '';
  return `2020 年靜態估計，不是即時人流。${res}來源：Chen et al. 2024，中國第七次人口普查 100 m 人口網格，CC BY 4.0。中國境內已平移對齊高德（GCJ-02）；香港、澳門、台灣不在這份網格內。`;
}

export function populationLegendHtml() {
  const gradient = DENSITY_STOPS.map((s) => s.hex).join(',');
  const labels = DENSITY_STOPS.map((s) => `<i>${s.label}</i>`).join('');
  return `<span class="heat-bar" style="background:linear-gradient(90deg,${gradient})"></span><span class="heat-labels">${labels}</span><span class="heat-unit">人/km² · 2020 靜態估計</span>`;
}

export function packPopulation(meta, data) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const out = new Uint8Array(12 + json.length + data.length);
  out.set([0x57, 0x4d, 0x50, 0x4f, 0x50, 0x31]); // WMPOP1
  const view = new DataView(out.buffer);
  view.setUint16(6, 1, true);
  view.setUint32(8, json.length, true);
  out.set(json, 12);
  out.set(data, 12 + json.length);
  return out;
}

export function decodePopulation(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 12 || String.fromCharCode(...u8.subarray(0, 6)) !== 'WMPOP1') throw new Error('人口資料格式不正確');
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (view.getUint16(6, true) !== 1) throw new Error('不支援的人口資料版本');
  const len = view.getUint32(8, true);
  if (12 + len > u8.length) throw new Error('人口資料格式不正確');
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + len)));
  const data = u8.subarray(12 + len);
  if (!meta.cols || !meta.rows || data.length !== meta.cols * meta.rows) throw new Error('人口網格長度不符');
  return { ...meta, data };
}

export async function gunzipBytes(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length < 2 || u8[0] !== 0x1f || u8[1] !== 0x8b) return u8;
  if (typeof DecompressionStream !== 'function') throw new Error('此瀏覽器無法解壓人口資料');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function loadPopulationGrid(url = POP_URL, fetchImpl = fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error('人口密度資料載入失敗');
  const raw = new Uint8Array(await res.arrayBuffer());
  return decodePopulation(await gunzipBytes(raw));
}

/** 雙線性取樣，座標是 WGS-84。低於 1 人/km² 或格外回 0。 */
export function sampleDensity(grid, lng, lat) {
  const { west, north, step, cols, rows, data, logScale } = grid;
  if (!(step > 0) || !Number.isFinite(lng) || !Number.isFinite(lat)) return 0;
  const x = (lng - west) / step;
  const y = (north - lat) / step;
  if (x < 0 || y < 0 || x > cols - 1 || y > rows - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const scale = logScale || POP_LOG_SCALE;
  const at = (c, r) => decodeDensity(data[r * cols + c], scale);
  const d00 = at(x0, y0);
  const d10 = at(x1, y0);
  const d01 = at(x0, y1);
  const d11 = at(x1, y1);
  return d00 * (1 - tx) * (1 - ty) + d10 * tx * (1 - ty) + d01 * (1 - tx) * ty + d11 * tx * ty;
}

/** 地圖座標（高德，中國境內為 GCJ-02）→ 人口密度。境外不做偏移。 */
export function sampleOnMap(grid, lng, lat) {
  const [wLng, wLat] = gcj02ToWgs84(lng, lat);
  return sampleDensity(grid, wLng, wLat);
}

export function colorForDensity(d) {
  if (!(d >= 1)) return [0, 0, 0, 0];
  const stops = DENSITY_STOPS;
  let rgb = stops[stops.length - 1].rgb;
  if (d <= stops[0].d) rgb = stops[0].rgb;
  else {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (d <= b.d) {
        const t = (Math.log(d) - Math.log(a.d)) / (Math.log(b.d) - Math.log(a.d));
        rgb = a.rgb.map((c, k) => Math.round(c + (b.rgb[k] - c) * t));
        break;
      }
    }
  }
  const t = Math.min(1, Math.max(0, (Math.log(d) - Math.log(1)) / (Math.log(20000) - Math.log(1))));
  const alpha = Math.round(110 + 120 * t);
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function fillRect(out, size, x0, y0, x1, y1, rgba) {
  let xa = Math.floor(Math.min(x0, x1));
  let xb = Math.ceil(Math.max(x0, x1));
  let ya = Math.floor(Math.min(y0, y1));
  let yb = Math.ceil(Math.max(y0, y1));
  if (xa < 0) xa = 0;
  if (ya < 0) ya = 0;
  if (xb > size) xb = size;
  if (yb > size) yb = size;
  if (xb <= xa || yb <= ya) return;
  for (let y = ya; y < yb; y++) {
    let i = (y * size + xa) * 4;
    for (let x = xa; x < xb; x++) {
      out[i] = rgba[0];
      out[i + 1] = rgba[1];
      out[i + 2] = rgba[2];
      out[i + 3] = rgba[3];
      i += 4;
    }
  }
}

function blockMax(data, cols, rows, row, col, stride) {
  let m = 0;
  const step = stride <= 4 ? 1 : Math.ceil(stride / 4);
  const r1 = Math.min(rows, row + stride);
  const c1 = Math.min(cols, col + stride);
  for (let r = row; r < r1; r += step) {
    const base = r * cols;
    for (let c = col; c < c1; c += step) {
      const v = data[base + c];
      if (v > m) m = v;
    }
  }
  return m;
}

/**
 * 畫一張高德圖磚（圖磚座標是地圖上的 GCJ 網格）。
 * 每個人口格子先轉成 GCJ 再畫，所以只在中國境內平移；用格子填色，低縮放會合併取值，避免城市被跳過。
 */
export function renderTilePixels(x, y, z, grid, { size = 256 } = {}) {
  const out = new Uint8ClampedArray(size * size * 4);
  const { west, north, step, cols, rows, data, logScale } = grid;
  if (!(step > 0) || !(z >= 0)) return out;
  const corners = [
    pxToLngLat(x * 256, y * 256, z),
    pxToLngLat((x + 1) * 256, y * 256, z),
    pxToLngLat(x * 256, (y + 1) * 256, z),
    pxToLngLat((x + 1) * 256, (y + 1) * 256, z),
  ].map((p) => gcj02ToWgs84(p.lng, p.lat));
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of corners) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const pad = step * 2 + 0.02;
  const c0 = Math.max(0, Math.floor((minLng - pad - west) / step));
  const c1 = Math.min(cols - 1, Math.ceil((maxLng + pad - west) / step));
  const r0 = Math.max(0, Math.floor((north - (maxLat + pad)) / step));
  const r1 = Math.min(rows - 1, Math.ceil((north - (minLat - pad)) / step));
  if (c1 < c0 || r1 < r0) return out;

  let stride = 1;
  const budget = 70000;
  while (Math.ceil((c1 - c0 + 1) / stride) * Math.ceil((r1 - r0 + 1) / stride) > budget) stride += 1;

  const scale = logScale || POP_LOG_SCALE;
  const toPx = (lng, lat) => {
    const p = mercatorPx(lng, lat, z);
    return { tx: ((p.x - x * 256) / 256) * size, ty: ((p.y - y * 256) / 256) * size };
  };

  for (let row = r0; row <= r1; row += stride) {
    for (let col = c0; col <= c1; col += stride) {
      const code = stride === 1 ? data[row * cols + col] : blockMax(data, cols, rows, row, col, stride);
      if (!code) continue;
      const rgba = colorForDensity(decodeDensity(code, scale));
      if (!rgba[3]) continue;
      const westCell = west + col * step;
      const northCell = north - row * step;
      const [lng0, lat0] = wgs84ToGcj02(westCell, northCell - stride * step);
      const [lng1, lat1] = wgs84ToGcj02(westCell + stride * step, northCell);
      const a = toPx(lng0, lat0);
      const b = toPx(lng1, lat1);
      fillRect(out, size, a.tx - 0.5, a.ty - 0.5, b.tx + 0.5, b.ty + 0.5, rgba);
    }
  }
  return out;
}

/** 高德 Flexible 圖層。opacity 0–1。 */
export function createPopulationLayer(AMap, grid, { opacity = 0.72, zIndex = 4 } = {}) {
  const layer = new AMap.TileLayer.Flexible({
    cacheSize: 96,
    zIndex,
    opacity,
    zooms: [4, 20],
    dataZooms: [4, 13],
    createTile(x, y, z, success, fail) {
      try {
        const size = 256;
        const px = renderTilePixels(x, y, z, grid, { size });
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d', { willReadFrequently: false });
        ctx.putImageData(new ImageData(px, size, size), 0, 0);
        success(canvas);
      } catch {
        fail();
      }
    },
  });
  return layer;
}
