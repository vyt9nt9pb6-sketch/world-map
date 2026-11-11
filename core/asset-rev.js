// 讓 iPhone Safari 在每次部署後拿到新的 JS／CSS。
//
// HTML 是 no-cache，但 /js/app.js 以前是 public, max-age=3600。
// Safari 在這一個小時內不會重新驗證模組，所以新的 index.html 會配上舊的 app.js：
// 熱力開關畫得出來（HTML 新的），點下去卻完全沒反應（舊程式沒有這些監聽）。
// 做法：回應 HTML 時把進入點網址加上目前檔案的 etag（?v=），網址一變就不能再用舊快取。
// JS／CSS 本身改成 no-cache，之後改到被 import 的模組也會重新驗證。

export const VERSIONED_ASSETS = ['/js/app.js', '/css/app.css', '/css/glass.css'];

const SAFE_PATH = /^\/[A-Za-z0-9./_-]+$/;

/** 依 Content-Type 決定快取。HTML／JS／CSS 每次都要向伺服器確認。 */
export function assetCacheControl(contentType) {
  const t = String(contentType || '').toLowerCase();
  if (t.startsWith('text/html') || t.includes('javascript') || t.includes('text/css')) return 'no-cache';
  return 'public, max-age=3600';
}

/**
 * 把 href="/js/app.js" 換成 href="/js/app.js?v=etag"。
 * 已經帶 ?v= 的不重複加。versions 的值只留安全字元。
 */
export function rewriteAssetUrls(html, versions) {
  let out = String(html);
  for (const path of VERSIONED_ASSETS) {
    const ver = versions?.[path];
    if (!ver || !SAFE_PATH.test(path)) continue;
    const token = String(ver).replace(/[^A-Za-z0-9._-]/g, '');
    if (!token) continue;
    const next = `${path}?v=${token}`;
    // 只換「引號緊貼路徑」的寫法。已經是 /js/app.js?v=… 時後面不是引號，不會再加一次。
    out = out.replaceAll(`"${path}"`, `"${next}"`).replaceAll(`'${path}'`, `'${next}'`);
  }
  return out;
}

/** 從 etag 標頭取出版本字（去掉引號與弱驗證前綴）。 */
export function versionFromEtag(etag) {
  return String(etag || '').replace(/^W\//, '').replaceAll('"', '').replace(/[^A-Za-z0-9._-]/g, '');
}
