import { chromium } from '/workspace/world-map/node_modules/playwright-core/index.mjs';
import { mkdirSync } from 'fs';
const base = 'https://world-map.kwok-worldmap.workers.dev';
const out = '/workspace/world-map/screenshots/';
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  locale: 'zh-TW',
  geolocation: { longitude: 119.2163, latitude: 34.5983 },
  permissions: ['geolocation'],
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.__worldMap?.view, null, { timeout: 45000 });
await page.evaluate(() => localStorage.clear());
const settle = async (ms = 2500) => {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
};
const apply = async (layer) => {
  await page.evaluate(async (layer) => {
    const w = window.__worldMap;
    Object.assign(w.state.layer, layer);
    await w.applyLayer();
  }, layer);
  await settle(2500);
};
const shot = async (name) => {
  await settle(1500);
  await page.screenshot({ path: out + name });
  console.log('saved', name);
};

await apply({ mode: 'standard', source: 'amap', labels: true });
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 119.2163, lat: 34.5983 }, 16, undefined, false));
await settle(3000);
await shot('v3b-01-logo-minimized.png');

// layer picker on satellite so Mapbox/Google source row is visible
await apply({ mode: 'satellite', source: 'amap', labels: true });
await page.click('#btn-layer');
await settle(1500);
const picker = await page.evaluate(() => ({
  sources: [...document.querySelectorAll('#opt-source [data-source]')].map((b) => ({
    src: b.dataset.source, disabled: b.disabled, checked: b.getAttribute('aria-checked'),
  })),
  cards: [...document.querySelectorAll('#layer-cards [data-layer]')].map((b) => b.dataset.layer),
}));
console.log('picker', JSON.stringify(picker));
await shot('v3b-02-layer-picker.png');
await page.click('#layer-close');

// terrain — 天地圖 ter（海外可能 418，仍截模式＋來源標示）
await apply({ mode: 'terrain', source: 'amap', labels: true });
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 100.2, lat: 36.5 }, 6, undefined, false));
await settle(5000);
await shot('v3b-03-terrain.png');

// satellite + attempt 3D（無 GPU 時 pitch 仍為 0；驗證 dataLayer／無 building 白樓）
await apply({ mode: 'satellite', source: 'amap', labels: false });
await page.evaluate(() => window.__worldMap.view.flyTo({ lng: 121.4737, lat: 31.2304 }, 17, undefined, false));
await settle(4000);
await page.evaluate(() => window.__worldMap.set3D(true));
await settle(3000);
const st = await page.evaluate(() => {
  const v = window.__worldMap.view;
  const logo = document.querySelector('.amap-logo');
  return {
    layer: window.__worldMap.state.layer,
    pitch: v.getPitch?.(),
    supports3D: typeof v.supports3D === 'function' ? v.supports3D() : null,
    dataLayer: document.getElementById('map')?.dataset?.layer,
    logoOpacity: logo ? getComputedStyle(logo).opacity : null,
    logoTransform: logo ? getComputedStyle(logo).transform : null,
    attrib: document.getElementById('map-attrib')?.textContent,
  };
});
console.log(JSON.stringify({ st, errors }, null, 1));
await shot('v3b-04-satellite-tilt-no-buildings.png');
await browser.close();
