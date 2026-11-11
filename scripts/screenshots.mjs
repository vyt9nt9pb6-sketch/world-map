// 無頭瀏覽器截圖（v3）：iPhone（390×844 @3x，zh-TW）10 個主要畫面 → screenshots/v3-iphone-*.png
// 用法：node scripts/screenshots.mjs [baseUrl]   例：node scripts/screenshots.mjs https://world-map.kwok-worldmap.workers.dev
// 需要線上版（高德 JS Key 由伺服器的 /api/config 提供）；沒有 GPU 時以 SwiftShader 軟體 WebGL 嘗試 3D。
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const GEO = { longitude: 119.2163, latitude: 34.5983, accuracy: 30 }; // 模擬 GPS（WGS-84）：連雲港（沒有海拔）

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  locale: 'zh-TW', geolocation: GEO, permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|tianditu|418|CORS|Running the JavaScript URL/i.test(m.text()) && errors.push(m.text()));
const made = [];
const shot = async (name, settle = 1200) => {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(settle);
  const f = `v3-iphone-${name}.png`;
  await page.screenshot({ path: out + f });
  made.push(f);
};
const wm = (fn, ...a) => page.evaluate(fn, ...a);

await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!window.__worldMap?.view, null, { timeout: 30000 });
await page.click('#btn-locate');
await page.waitForFunction(() => !!window.__worldMap.state.meRaw, null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('01-map', 2500);

// 2) 搜尋面板：先搜尋一次產生記錄，再回到首頁（記錄＋搜尋附近＋目前位置）
await page.fill('#search-input', '連雲港站');
await page.press('#search-input', 'Enter');
await page.waitForSelector('#results li, #results button', { timeout: 20000 }).catch(() => {});
await page.fill('#search-input', '南京南站');
await page.press('#search-input', 'Enter');
await page.waitForSelector('#results li, #results button', { timeout: 20000 }).catch(() => {});
await page.click('#search-cancel').catch(() => {});
await page.click('#search-input');
await page.waitForTimeout(800);
await shot('02-search-history-nearby');

// 搜尋附近 → 結果（額外）
await page.click('.nearby-btn[data-kind="toilet"]').catch(() => {});
await page.waitForSelector('#nearby-list li', { timeout: 25000 }).catch(() => {});
await shot('02b-nearby-toilet');
await page.click('#nearby-close').catch(() => {});

// 3) 點地圖選地點
await wm(() => window.__worldMap.setSnap?.('peek'));
await page.click('#btn-locate');
await page.waitForTimeout(2500);
await page.touchscreen.tap(250, 300);
await page.waitForFunction(() => document.querySelector('#view-place:not([hidden])') && document.querySelector('#place-name')?.textContent.trim(), null, { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('03-place-card-tap');
const tapName = await page.textContent('#place-name').catch(() => '');

// 4) 長按 → 地點詳細資訊＋路線
await page.click('#place-close').catch(() => {});
await page.waitForTimeout(500);
const box = { x: 120, y: 330 };
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.waitForTimeout(900);
await page.mouse.up();
await page.waitForFunction(() => document.querySelector('#view-place:not([hidden])'), null, { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(1500);
await shot('04-longpress-card-route');
await page.click('#place-close').catch(() => {});

// 5) 圖層面板；6) 大眾運輸圖層
await page.click('#btn-layer');
await page.waitForTimeout(600);
await shot('05-layer-picker', 600);
await page.click('.layer-card[data-layer="transit"]');
await page.waitForTimeout(500);
await page.click('#layer-close').catch(() => {});
await page.waitForTimeout(500);
await wm(() => window.__worldMap.view.flyTo({ lng: 118.9, lat: 32.2 }, 10));
await page.waitForTimeout(6000);
await shot('06-transit-layer', 1500);
await page.click('#btn-layer');
await page.click('.layer-card[data-layer="standard"]');
await page.click('#layer-close').catch(() => {});
await page.waitForTimeout(500);

// 7) 路線：搜尋南京南站 → 路線 → 公交火車 → 鐵路優先
await page.click('#btn-locate');
await page.waitForTimeout(1500);
await page.fill('#search-input', '南京南站');
await page.press('#search-input', 'Enter');
await page.waitForSelector('#results li, #results button', { timeout: 20000 });
await page.click('#results li, #results button >> nth=0');
await page.waitForSelector('#place-route', { timeout: 15000 });
await page.click('#place-route');
await page.waitForSelector('#mode-tabs [data-mode="transit"]');
await page.click('#mode-tabs [data-mode="transit"]');
await page.waitForSelector('#strategy-chips button', { timeout: 10000 });
const chips = await page.$$eval('#strategy-chips button', (b) => b.map((x) => x.textContent.trim()));
await page.click('#strategy-chips button:has-text("鐵路優先")');
await page.waitForSelector('#route-options li, #route-options .route-card, #route-options button', { timeout: 40000 }).catch(() => {});
await page.waitForTimeout(2500);
await wm(() => window.__worldMap.setSnap?.('half'));
await shot('07-route-rail-first', 2500);

// 8) 帳號／收藏
await page.click('#route-close').catch(() => {});
await page.click('#btn-avatar').catch(async () => { await page.click('#search-input'); await page.click('#btn-avatar'); });
await page.waitForSelector('#view-account:not([hidden])', { timeout: 8000 }).catch(() => {});
await shot('08-account-favorites', 700);
await page.click('#account-close').catch(() => {});

// 9) 目前位置：海拔／氣壓（估計值）
await page.click('#search-input');
await page.waitForTimeout(500);
await wm(() => window.__worldMap.refreshEnv?.());
await page.waitForFunction(() => /hPa/.test(document.querySelector('#search-home [data-env-slot]')?.textContent || ''), null, { timeout: 20000 }).catch(() => {});
await shot('09-altitude-pressure', 800);
const envText = await page.textContent('#search-home [data-env-slot]').catch(() => '');

// 10) 3D 開關
await page.click('#search-cancel').catch(() => {});
await wm(() => window.__worldMap.setSnap?.('peek'));
await page.click('#btn-locate');
await page.waitForTimeout(1500);
await page.click('#btn-3d');
await page.waitForTimeout(900); // 無 WebGL 時，這時會顯示「無法使用 3D」的提示
await page.screenshot({ path: out + 'v3-iphone-10-3d-toggle.png' });
made.push('v3-iphone-10-3d-toggle.png');
const info3d = await wm(() => ({ pitch: window.__worldMap.view?.map?.getPitch?.(), webgl: !!document.createElement('canvas').getContext('webgl') }));

console.log(JSON.stringify({ made, tapName, chips, envText: envText.replace(/\s+/g, ' ').slice(0, 160), info3d, errors: errors.slice(0, 8) }, null, 1));
await browser.close();
