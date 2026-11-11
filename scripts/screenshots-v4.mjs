// v4 iPhone 截圖（390×844 @3x）→ screenshots/v4-*.png。預設打線上網站（真的 AMap 金鑰在伺服器端注入）；WM_LOCAL=1 則用本機 public/ 覆蓋靜態檔。
import { launch, boot, settle } from './lib-pw.mjs';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const local = process.env.WM_LOCAL === '1';
const { browser, page, errors } = await launch({ local, geo: { longitude: 121.4737, latitude: 31.2304 } });
page.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED/.test(m.text())) errors.push(m.text().slice(0, 200)); });
const shot = (name) => page.screenshot({ path: `${OUT}v4-${name}.png` });
const fly = (lng, lat, z, pitch) => page.evaluate(([a, b, c, d]) => window.__worldMap.view.flyTo({ lng: a, lat: b }, c, d, false), [lng, lat, z, pitch]);
await boot(page);
await settle(page, 2500);
await fly(121.4737, 31.2304, 15.5);
await page.evaluate(() => window.__worldMap.setSnap('half'));

// 1 圖層 2×2
await page.click('#btn-layer');
await settle(page, 1200);
await shot('1-layer-grid');
await page.click('#layer-close');

// 2 衛星傾斜（陸家嘴，無白色立體方塊）
await page.evaluate(async () => { const w = window.__worldMap; Object.assign(w.state.layer, { mode: 'satellite', source: 'amap', labels: false }); await w.applyLayer(); });
await fly(121.5055, 31.2397, 17.5);
await settle(page, 2500);
await page.evaluate(() => window.__worldMap.set3D(true));
await settle(page, 9000);
await page.evaluate(() => window.__worldMap.setSnap('peek'));
await settle(page, 1200);
await shot('2-satellite-tilt');

// 後面幾張維持衛星底圖（沙盒的軟體 WebGL 畫不出高德標準向量圖，衛星影像是最能看出玻璃材質的背景）
await page.evaluate(async () => { const w = window.__worldMap; Object.assign(w.state.layer, { mode: 'satellite', labels: true }); await w.applyLayer(); w.set3D(false); w.setSnap('half'); });
await fly(121.4737, 31.2304, 15.5, 0);
await settle(page, 2500);

// 3 搜尋 → 結果＋「搜尋附近」建議
await page.fill('#search-input', '咖啡');
await page.press('#search-input', 'Enter');
await settle(page, 3500);
await page.evaluate(() => window.__worldMap.setSnap('half'));
await settle(page, 800);
await shot('3-search-nearby-suggest');

// 4 地點頁
await page.click('#results li >> nth=0');
await settle(page, 4000);
await page.evaluate(() => window.__worldMap.setSnap('half'));
await settle(page, 1200);
await shot('4-place-detail');

// 5 多路線＋選項（上海人民廣場 → 浦東機場）
await page.evaluate(async () => {
  const w = window.__worldMap;
  w.state.start = { name: '人民廣場', lng: 121.4737, lat: 31.2304 };
  w.state.dest = { name: '浦東國際機場', lng: 121.8053, lat: 31.1443 };
  w.openRoute?.();
  w.setMode('driving');
});
await settle(page, 600);
await page.evaluate(async () => { await window.__worldMap.planRoute(); });
await settle(page, 5000);
await shot('5-multi-route');
await page.click('#route-opts > summary');
await page.click('#depart-seg [data-d=at]');
await page.check('#opt-avoid-toll', { force: true }).catch(() => {});
await settle(page, 6000);
await page.evaluate(() => document.getElementById('route-opts').scrollIntoView({ block: 'start' }));
await settle(page, 800);
await shot('5b-route-options');
await page.evaluate(() => { localStorage.removeItem('wm.routeopts.v4'); });

// 6 整體玻璃介面（首頁，深色玻璃疊在衛星上更能看出材質）
await page.evaluate(async () => { const w = window.__worldMap; w.state.start = null; w.state.dest = null; w.state.routes = []; document.getElementById('route-close')?.click(); document.getElementById('search-clear')?.click(); document.getElementById('search-cancel')?.click(); w.view.flyTo({ lng: 121.4999, lat: 31.2397 }, 16, 0, false); });
await settle(page, 4000);
await page.evaluate(() => window.__worldMap.setSnap('half'));
await settle(page, 1000);
await shot('6-glass-overview');

console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
await browser.close();
