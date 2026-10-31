// 全球地表覆蓋圖層：ESA WorldCover 2021 v200（10 m，11 類）。
// 授權：CC BY 4.0（免費、不限用途，需標示來源）。
// 圖磚：Terrascope（VITO，比利時）MapProxy 的 WMTS（REST），Web Mercator、WGS-84、回應帶 access-control-allow-origin:*。
// 我們不代理、不快取、不鏡像：瀏覽器直接向 Terrascope 取圖磚（與官方 WMTS 用法相同）。
import { createShiftedFlexible } from './tianditu.js';

export const WORLDCOVER_LAYER = 'esa-worldcover-map-10m-2021-v2_map';
export const WORLDCOVER_HOST = 'https://mapproxy.terrascope.be';

export function worldcoverUrl(z, x, y) {
  return `${WORLDCOVER_HOST}/mapproxy/wmts/${WORLDCOVER_LAYER}/webmercator/${z}/${x}/${y}.png`;
}

export const WORLDCOVER_ATTRIBUTION = '© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium · CC BY 4.0';

/** 官方色碼（ESA WorldCover PUM v2.0 表 3）。group 供圖例分組 */
export const WORLDCOVER_LEGEND = [
  { code: 10, name: '森林／樹木', en: 'Tree cover', rgb: [0, 100, 0] },
  { code: 20, name: '灌木', en: 'Shrubland', rgb: [255, 187, 34] },
  { code: 30, name: '草地', en: 'Grassland', rgb: [255, 255, 76] },
  { code: 40, name: '農田', en: 'Cropland', rgb: [240, 150, 255] },
  { code: 50, name: '建成區', en: 'Built-up', rgb: [250, 0, 0] },
  { code: 60, name: '裸地／稀疏植被', en: 'Bare / sparse vegetation', rgb: [180, 180, 180] },
  { code: 70, name: '冰雪', en: 'Snow and ice', rgb: [240, 240, 240] },
  { code: 80, name: '永久水體', en: 'Permanent water bodies', rgb: [0, 100, 200] },
  { code: 90, name: '草本濕地', en: 'Herbaceous wetland', rgb: [0, 150, 160] },
  { code: 95, name: '紅樹林', en: 'Mangroves', rgb: [0, 207, 117] },
  { code: 100, name: '苔蘚地衣', en: 'Moss and lichen', rgb: [250, 230, 160] },
];

export const legendColor = (c) => `rgb(${c.rgb.join(',')})`;

/** 地表覆蓋疊加層（半透明，底下仍看得到高德標準底圖的道路與地名）。WorldCover 只提供到 z19，且 z<=3 時解析度很粗但可用 */
export function createWorldCoverFlexible(AMap, { zIndex = 2, opacity = 0.68 } = {}) {
  return createShiftedFlexible(AMap, { urlFor: worldcoverUrl, zIndex, opacity, dataZooms: [3, 19], zooms: [3, 20] });
}
