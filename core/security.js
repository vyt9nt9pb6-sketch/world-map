// 安全標頭（Node 伺服器與 Worker 共用）。
// 主頁面使用嚴格 CSP；3D 頁（/3d.html）要載入高德 JS API 2.0，需要放寬 script-src／worker-src／connect-src，
// 所以獨立成另一頁，避免主頁面的 CSP 被放寬。
const BASE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

const MAIN_CSP =
  "default-src 'self'; img-src 'self' data: https://*.is.autonavi.com https://*.tianditu.gov.cn; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

const AMAP3D_CSP =
  "default-src 'self'; script-src 'self' https://webapi.amap.com https://*.amap.com 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com https://*.is.autonavi.com; connect-src 'self' data: blob: https://*.amap.com https://*.autonavi.com; worker-src blob: 'self'; font-src 'self' data: https://*.amap.com; frame-ancestors 'none'; base-uri 'self'";

export function securityHeaders(pathname = '/') {
  return { ...BASE, 'content-security-policy': pathname === '/3d.html' ? AMAP3D_CSP : MAIN_CSP };
}
