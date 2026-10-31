// 無頭瀏覽器截圖（v2）：iPhone（390×844 @3x）的主要畫面，存成 screenshots/v2-*.png。
// 用法：node scripts/screenshots.mjs [baseUrl]   （本機或已部署的網址皆可；不需要金鑰）
// 選填：SHOT_PREFIX=前綴  SHOT_DESKTOP=1 另外拍一組桌機版
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';

const base = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const out = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
const PREFIX = process.env.SHOT_PREFIX || '';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const GEO = { longitude: 119.2163, latitude: 34.5983, accuracy: 30 }; // 模擬 GPS（WGS-84）：連雲港

const browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

async function waitTiles(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tile')].every((t) => t.complete), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(700);
}

async function run(device, ctxOpts) {
  const ctx = await browser.newContext({ ...ctxOpts, geolocation: GEO, permissions: ['geolocation', 'clipboard-read', 'clipboard-write'], locale: 'zh-TW' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
  const shot = async (name) => {
    await waitTiles(page);
    await page.screenshot({ path: `${out}${PREFIX}v2-${device}-${name}.png` });
  };
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.me-dot', { timeout: 15000 }).catch(() => page.click('#btn-locate'));
  await shot('01-map');

  // 附近：廁所
  await page.click('#nearby-bar [data-kind="toilet"]');
  await page.waitForSelector('#nearby-list li', { timeout: 25000 });
  await shot('02-nearby-toilet');
  const nearbyNames = await page.$$eval('#nearby-list li .name', (e) => e.slice(0, 3).map((x) => x.textContent));
  await page.click('#nearby-bar [data-kind="toilet"]'); // 再按一次關閉
  await page.click('#nearby-bar [data-kind="ev"]');
  await page.waitForFunction(() => /找到|找不到/.test(document.querySelector('#nearby-status')?.textContent || ''), null, { timeout: 25000 });
  await shot('03-nearby-ev');
  await page.click('#nearby-close');

  // 搜尋南京站 → 終點
  await page.fill('#search-input', '南京站');
  await page.press('#search-input', 'Enter');
  await page.waitForFunction(() => document.querySelector('#search-status')?.textContent.includes('找到'), null, { timeout: 20000 });
  await page.click('#results li:not(:has(.badge.addr))');
  await shot('04-place-fav-share');
  await page.click('#place-fav'); // 收藏
  await page.click('#place-as-dest');
  await page.waitForSelector('.route-option', { timeout: 30000 });
  await shot('05-route-driving');

  // 步行（連雲港到南京太遠 → 先看是否回報錯誤；改拍短程）
  await page.click('#mode-tabs [data-mode="bicycling"]');
  await page.waitForFunction(() => document.querySelector('.route-option') || document.querySelector('#route-status')?.classList.contains('error'), null, { timeout: 30000 });
  await shot('06-route-bicycling');

  // 公交／火車：每站、線路名
  await page.click('#mode-tabs [data-mode="transit"]');
  await page.waitForSelector('.route-option .seg.train', { timeout: 40000 });
  await page.evaluate(() => window.__worldMap.setSnap('full'));
  await page.evaluate(() => document.querySelector('.seg.train')?.scrollIntoView({ block: 'start' }));
  await shot('07-transit-train-stops');
  const train = await page.$eval('.seg.train', (el) => ({
    trip: el.querySelector('.seg-head b')?.textContent,
    line: el.querySelector('.line-name')?.textContent.replace(/\s+/g, ' ').trim(),
    stops: [...el.querySelectorAll('.stoplist .n')].map((x) => x.textContent),
  })).catch(() => null);

  // 步行（短程：我的位置 → 附近第一個廁所）
  await page.evaluate(async () => {
    const w = window.__worldMap;
    w.setSnap('half');
  });

  // 分享
  await page.evaluate(() => window.__worldMap.openShare({ lng: 119.2216, lat: 34.5967, name: '我的位置' }));
  await shot('08-share');
  const shareLink = await page.inputValue('#share-link');
  await page.click('#share-close');

  // 收藏、登入
  await page.evaluate(() => window.__worldMap.openFavs());
  await shot('09-favorites');
  await page.click('#btn-account');
  await shot('10-account');
  await page.click('#account-close');

  // 圖層選單
  await page.evaluate(() => document.querySelector('#route-close')?.click());
  await page.click('#btn-layer');
  await shot('11-layer-menu');
  await page.click('#layer-menu [data-layer="satellite"]');
  await shot('12-satellite');

  console.log(`${device}: 附近廁所前 3：${nearbyNames.join('、')}`);
  console.log(`  火車：${JSON.stringify(train)}`);
  console.log(`  分享連結：${shareLink}`);
  if (errors.length) console.log('  頁面錯誤：' + errors.join('; '));
  await ctx.close();
  return errors;
}

const errs = [
  ...(await run('iphone', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' })),
  ...(process.env.SHOT_DESKTOP ? await run('desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }) : []),
];
await browser.close();
console.log('截圖已存到', out);
process.exit(errs.length ? 1 : 0);
