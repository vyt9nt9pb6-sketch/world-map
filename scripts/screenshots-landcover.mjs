// 全球圖層截圖與檢查（v3）：地表覆蓋（真的 ESA WorldCover 圖磚）＋全球天地圖衛星。
// 天地圖圖磚在海外開發機被 WAF 擋（418），所以 12 號圖用「模擬圖磚」（方格＋圖磚座標）只驗證疊圖／平移邏輯，檔名標 mock。
// 用法：node scripts/screenshots-landcover.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'https://world-map.kwok-worldmap.workers.dev').replace(/\/$/, '');
const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  locale: 'zh-TW', geolocation: { longitude: 119.2163, latitude: 34.5983, accuracy: 30 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
const wc = { ok: 0, bad: 0, urls: [] };
const tdtReq = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|tianditu|418|CORS|Running the JavaScript URL/i.test(m.text()) && errors.push(m.text()));
page.on('response', (r) => {
  if (r.url().includes('mapproxy.terrascope.be')) { r.status() === 200 ? wc.ok++ : wc.bad++; if (wc.urls.length < 400) wc.urls.push(r.url().split('webmercator/')[1]); }
});
// 模擬天地圖：回傳畫著格線與「z/x/y」的 256 圖磚（img 綠色底、cia 透明底只有文字）
const tileHtml = await ctx.newPage();
await tileHtml.goto('about:blank');
const mock = async (route) => {
  const u = new URL(route.request().url());
  const layer = u.pathname.startsWith('/cia') ? 'cia' : 'img';
  const z = u.searchParams.get('TILEMATRIX'), x = u.searchParams.get('TILECOL'), y = u.searchParams.get('TILEROW');
  tdtReq.push(`${layer} ${z}/${x}/${y}`);
  const b64 = await tileHtml.evaluate(([layer, z, x, y]) => {
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
    if (layer === 'img') { g.fillStyle = `hsl(${(x * 37 + y * 17) % 360},35%,35%)`; g.fillRect(0, 0, 256, 256); }
    g.strokeStyle = layer === 'img' ? '#fff' : '#ff0'; g.lineWidth = 2; g.strokeRect(1, 1, 254, 254);
    g.fillStyle = layer === 'img' ? '#fff' : '#ff0'; g.font = 'bold 20px sans-serif'; g.fillText(`${layer} ${z}/${x}/${y}`, 14, 132);
    return c.toDataURL('image/png').split(',')[1];
  }, [layer, z, x, y]);
  await route.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(b64, 'base64') });
};
await ctx.route(/tianditu\.gov\.cn/, mock);

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__worldMap?.view, null, { timeout: 30000 });
await page.waitForTimeout(2000);
const settle = async (ms = 2500) => { await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(ms); };
// mock 回應是排隊處理的（逐張畫 canvas），所以等請求數穩定、並取「最後」的請求才代表當前視圖
const drain = async () => { let n = -1; while (n !== tdtReq.length) { n = tdtReq.length; await page.waitForTimeout(2000); } };
const arrived = (lng, z) => page.waitForFunction(([lng, z]) => { const v = window.__worldMap.view; const c = v.getCenter(); return Math.abs(c.lng - lng) < 0.05 && Math.round(v.getZoom()) === z; }, [lng, z], { timeout: 60000 });
const lastUnique = (a, k = 8) => [...new Set(a.slice().reverse())].slice(0, k);
const shot = async (f) => { await settle(); await page.screenshot({ path: out + f }); console.log('saved', f); };

// 1) 地表覆蓋：連雲港附近（中國境內，會平移）
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 119.0, lat: 34.45 }, 9, undefined, false));
await page.click('#btn-layer');
await page.click('#opt-landcover');
await settle(4000);
await page.screenshot({ path: out + 'v3-iphone-11b-landcover-picker.png' }); console.log('saved picker');
await page.click('#layer-close');
await shot('v3-iphone-11-landcover.png');
const stateChina = await page.evaluate(() => ({ layer: window.__worldMap.state.layer, attrib: document.getElementById('map-attrib').textContent, dataLayer: document.getElementById('map').dataset.layer }));
// 2) 到境外（巴黎、紐約）看地表覆蓋有沒有圖磚
for (const [name, c, z] of [['paris', { lng: 2.35, lat: 48.85 }, 8], ['nyc', { lng: -74.0, lat: 40.7 }, 9]]) {
  await page.evaluate(([c, z]) => window.__worldMap.view.flyTo(c, z, undefined, false), [c, z]);
  await arrived(c.lng, z);
  await settle(6000);
  if (name === 'paris') await page.screenshot({ path: out + 'v3-iphone-11c-landcover-paris.png' });
}
// 3) 全球天地圖衛星（模擬圖磚）：境外（巴黎）與中國境內
await page.click('#btn-layer');
await page.click('#opt-global-sat');
await page.click('#layer-close');
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 2.35, lat: 48.85 }, 8, undefined, false));
await arrived(2.35, 8);
tdtReq.length = 0; // 只記到站之後新發出的請求
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 2.351, lat: 48.851 }, 8, undefined, false)); // 微移以觸發重載
await drain();
await settle(1000);
await page.screenshot({ path: out + 'v3-iphone-12-global-satellite-mock-paris.png' });
const parisReq = lastUnique(tdtReq);
const parisCenter = await page.evaluate(() => ({ c: window.__worldMap.view.getCenter(), z: window.__worldMap.view.getZoom() }));
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 119.2163, lat: 34.5983 }, 10, undefined, false));
await arrived(119.2163, 10);
await drain();
await settle(1000);
await page.screenshot({ path: out + 'v3-iphone-12b-global-satellite-mock-china.png' });
const chinaReq = lastUnique(tdtReq.filter((r) => / 10\//.test(r)), 12);
const chinaCenter = await page.evaluate(() => ({ c: window.__worldMap.view.getCenter(), z: window.__worldMap.view.getZoom() }));
const st3 = await page.evaluate(() => ({ layer: window.__worldMap.state.layer, attrib: document.getElementById('map-attrib').textContent }));
console.log(JSON.stringify({ stateChina, st3, worldcover: { ok: wc.ok, bad: wc.bad, sample: wc.urls.slice(0, 6) }, parisCenter, tdtParis: parisReq, chinaCenter, tdtChina: chinaReq, errors }, null, 1));
await ctx.unrouteAll({ behavior: 'ignoreErrors' });
await browser.close();
