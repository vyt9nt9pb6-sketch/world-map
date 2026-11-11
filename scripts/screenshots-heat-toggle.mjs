// 線上站 iPhone 模擬：舊 app.js（Safari 一小時快取）對上新 HTML，開關不會動；
// 乾淨載入目前的 app.js 時，點開關會改變狀態。
import { chromium, webkit, devices } from 'playwright-core';
import { readFileSync } from 'node:fs';

const BASE = 'https://world-map.kwok-worldmap.workers.dev/';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const engine = process.argv[2] || 'chromium';
const mode = process.argv[3] || 'fresh'; // fresh | stale
const only = process.argv[4] || '';
const oldJs = readFileSync('/tmp/app-v4.js');
const browserType = engine === 'webkit' ? webkit : chromium;
const browser = await browserType.launch(engine === 'webkit' ? {} : {
  executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const ctx = await browser.newContext({ ...devices['iPhone 13'], locale: 'zh-TW' });
if (mode === 'stale') {
  await ctx.route('**/js/app.js*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript; charset=utf-8',
    headers: { 'cache-control': 'public, max-age=3600' },
    body: oldJs,
  }));
}
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)));
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(engine === 'webkit' ? 7000 : 4500);
await page.click('#btn-layer');
await page.waitForTimeout(500);
await page.evaluate(() => document.getElementById('layer-heat')?.scrollIntoView({ block: 'center' }));
await page.waitForTimeout(300);
for (const id of (only ? [only] : ['opt-pop', 'opt-traffic', 'opt-foot'])) {
  const box = await page.locator('#' + id).boundingBox();
  if (box) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(mode === 'fresh' && id === 'opt-pop' ? 1500 : 400);
}
const state = await page.evaluate(() => ({
  pop: document.getElementById('opt-pop')?.getAttribute('aria-checked'),
  traffic: document.getElementById('opt-traffic')?.getAttribute('aria-checked'),
  foot: document.getElementById('opt-foot')?.getAttribute('aria-checked'),
  hasHeatApi: typeof window.__worldMap?.applyHeat,
  script: performance.getEntriesByType('resource').filter((r) => r.name.includes('/js/app.js')).map((r) => r.name),
}));
await page.screenshot({ path: `${OUT}v5-fix-${mode}-${engine}${only ? '-' + only : ''}-sheet.png` });
if (mode === 'fresh') {
  await page.click('#layer-close');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}v5-fix-${mode}-${engine}${only ? '-' + only : ''}-map.png` });
}
console.log(JSON.stringify({ engine, mode, state, errors }, null, 2));
await browser.close();
