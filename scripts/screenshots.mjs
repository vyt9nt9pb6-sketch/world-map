// 無頭瀏覽器截圖：iPhone（390×844 @3x）與桌機（1440×900），畫出 連雲港→南京 的路線。
// 需要本機伺服器已啟動。用法：node scripts/screenshots.mjs [baseUrl]
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
// 模擬 GPS（WGS-84）：連雲港市海州區附近
const GEO = { longitude: 119.2163, latitude: 34.5983, accuracy: 30 };

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function waitTiles(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tile')].every((t) => t.complete), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(800);
}

async function run(name, ctxOpts) {
  const ctx = await browser.newContext({ ...ctxOpts, geolocation: GEO, permissions: ['geolocation'], locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForSelector('.me-dot', { timeout: 15000 }).catch(() => page.click('#btn-locate'));
  await waitTiles(page);
  await page.screenshot({ path: `${out}${name}-1-map.png` });

  // 搜尋 → 結果清單
  await page.fill('#search-input', '加油站');
  await page.press('#search-input', 'Enter');
  await page.waitForSelector('#results li', { timeout: 20000 });
  await waitTiles(page);
  await page.screenshot({ path: `${out}${name}-2-search.png` });

  // 搜尋南京站 → 設為終點 → 規劃路線
  await page.fill('#search-input', '南京站');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#search-status')?.textContent.includes('找到'), null, { timeout: 20000 });
  await page.click('#results li:not(:has(.badge.addr))');
  await page.click('#place-as-dest');
  await page.waitForSelector('.route-option', { timeout: 30000 });
  await waitTiles(page);
  await page.screenshot({ path: `${out}${name}-3-route.png` });

  // 衛星圖
  await page.click('#btn-layer');
  await waitTiles(page);
  await page.screenshot({ path: `${out}${name}-4-satellite.png` });

  const summary = await page.$$eval('.route-option', (els) => els.map((e) => e.querySelector('.top').innerText.replace(/\s+/g, ' ')));
  console.log(`${name}: ${summary.join(' | ')}${errors.length ? '\n  頁面錯誤：' + errors.join('; ') : ''}`);
  await ctx.close();
  return errors;
}

const errs = [
  ...(await run('iphone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })),
  ...(await run('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })),
];
await browser.close();
console.log('截圖已存到', out);
process.exit(errs.length ? 1 : 0);
