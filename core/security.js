// 安全標頭（Node 伺服器與 Worker 共用）。
const BASE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

// 主地圖改用高德 JS API 2.0（含 3D 向量地圖）：需要載入 webapi.amap.com 的腳本、WebGL 著色器（unsafe-eval）、
// blob: worker，以及 *.amap.com／*.autonavi.com 的圖磚與資料。其餘維持最小授權：
// 不允許內嵌 script、不允許其他來源、不允許被 iframe。高德 Web 服務請求都走同源 /_AMapService 代理。
const MAIN_CSP =
  "default-src 'self'; script-src 'self' https://webapi.amap.com https://*.amap.com 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com https://*.is.autonavi.com https://*.tianditu.gov.cn https://mapproxy.terrascope.be https://api.mapbox.com https://*.tiles.mapbox.com https://tile.googleapis.com; connect-src 'self' data: blob: https://*.amap.com https://*.autonavi.com https://api.mapbox.com https://tile.googleapis.com; worker-src blob: 'self'; font-src 'self' data: https://*.amap.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

export function securityHeaders() {
  return { ...BASE, 'content-security-policy': MAIN_CSP };
}
