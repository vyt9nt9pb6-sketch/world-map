// 高德瓦片圖層設定（GCJ-02，Web Mercator）。
// 實測（2026-10）：
//  - webrd…&scale=2 仍回傳 256px，不是高清圖 → 不採用
//  - wprd…&scl=2&style=7 回傳 512px 高清圖，但「不含文字標註」
//  - wprd…&scl=1&style=8&ltype=4 是「只有文字標註」的透明圖層（256px）
//  - webst…&style=6 衛星影像（256px，JPEG）；webst…&style=8 衛星用路網＋標註（透明 PNG）
// 因此高 DPI 螢幕上：512px 無標註底圖（線條清晰）＋ 透明標註層；一般螢幕：傳統 256px 含標註圖。

export const SUBDOMAINS = ['1', '2', '3', '4'];

export const TILE_URLS = {
  standard1x: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
  standardHdBase: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=2&style=7&x={x}&y={y}&z={z}',
  standardHdLabels: 'https://wprd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scl=1&style=8&ltype=4&x={x}&y={y}&z={z}',
  satellite: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}',
  satelliteLabels: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}',
};

export const ATTRIBUTION = '© 高德地圖 AutoNavi';

/**
 * 依螢幕 DPI 產生圖層組合描述（純資料，方便測試；由 app.js 轉成 Leaflet 圖層）。
 * @param {number} dpr window.devicePixelRatio
 */
export function layerPlan(dpr = 1) {
  const hd = dpr >= 1.5;
  return {
    hd,
    standard: hd
      ? [
          { url: TILE_URLS.standardHdBase, maxNativeZoom: 18, zIndex: 1 },
          { url: TILE_URLS.standardHdLabels, maxNativeZoom: 18, zIndex: 2, overlay: true },
        ]
      : [{ url: TILE_URLS.standard1x, maxNativeZoom: 18, zIndex: 1 }],
    // 衛星影像沒有文字，可放心用「下一級縮放、半尺寸顯示」的方式取得 2 倍清晰度
    satellite: [{ url: TILE_URLS.satellite, maxNativeZoom: hd ? 17 : 18, zIndex: 1, retinaTrick: hd }],
    satelliteLabels: { url: TILE_URLS.satelliteLabels, maxNativeZoom: 18, zIndex: 2, overlay: true },
  };
}
