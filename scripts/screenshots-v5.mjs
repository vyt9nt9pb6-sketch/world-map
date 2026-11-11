// v5 熱力圖截圖（iPhone 390×844 @2x）→ screenshots/v5-*.png
// 靜態檔用本機 public/（含人口網格），/api 仍走線上 Worker（高德金鑰）。足跡 API 在截圖裡模擬已登入，不寫入正式 KV。
import { launch, boot, settle, BASE } from './lib-pw.mjs';

const OUT = new URL('../screenshots/', import.meta.url).pathname;
const { browser, page, errors } = await launch({ local: true, geo: { longitude: 121.4737, latitude: 31.2304 }, dpr: 2 });
page.on('console', (m) => {
  if (m.type() === 'error' && !/CORS|ERR_FAILED|net::/.test(m.text())) errors.push(m.text().slice(0, 240));
});

const points = [];
const t0 = Date.now() - 2 * 86400000;
for (let i = 0; i < 36; i++) {
  points.push({
    lng: 121.47 + Math.sin(i / 3) * 0.02 + i * 0.0004,
    lat: 31.22 + Math.cos(i / 4) * 0.015,
    t: t0 + i * 20 * 60 * 1000,
  });
}
for (let i = 0; i < 14; i++) points.push({ lng: 121.499 + i * 0.0002, lat: 31.239, t: t0 + i * 30 * 60 * 1000 });

await page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { email: 'kwok@example.com' } }) }));
await page.route('**/api/favorites**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], serverTime: Date.now() }) }));
await page.route('**/api/footprint**', (route) => {
  const body = JSON.stringify({ points, count: points.length, ok: true });
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body });
});

const shot = (name) => page.screenshot({ path: `${OUT}v5-${name}.png` });
const fly = (lng, lat, z) => page.evaluate(([a, b, c]) => window.__worldMap.view.flyTo({ lng: a, lat: b }, c, 0, false), [lng, lat, z]);

await boot(page);
await settle(page, 2000);
await fly(121.47, 31.23, 11);
await page.evaluate(() => window.__worldMap.setSnap('peek'));
await settle(page, 1500);

// 1 圖層面板裡的三個熱力開關（未開啟）
await page.click('#btn-layer');
await page.evaluate(() => document.getElementById('layer-heat')?.scrollIntoView({ block: 'center' }));
await settle(page, 600);
await shot('1-layer-picker');

// 2 人口密度（上海）
await page.click('#opt-pop');
await page.waitForFunction(() => document.getElementById('pop-note')?.textContent?.includes('人/km'), null, { timeout: 20000 }).catch(() => {});
await settle(page, 2500);
await page.click('#layer-close');
await fly(121.47, 31.23, 11);
await settle(page, 2500);
await shot('2-population-shanghai');

// 3 即時路況（陸家嘴附近，路比較密）
await page.click('#btn-layer');
await page.evaluate(() => document.getElementById('opt-traffic')?.scrollIntoView({ block: 'center' }));
await page.click('#opt-traffic');
await settle(page, 400);
await page.click('#layer-close');
await fly(121.505, 31.235, 14);
await settle(page, 4000);
await shot('3-traffic');

// 4 我的足跡（模擬已登入；先關掉人口與路況，熱力才看得清楚）
await page.evaluate(() => {
  const w = window.__worldMap;
  w.state.heat.pop = false;
  w.state.heat.traffic = false;
  w.state.heat.foot = true;
  w.state.user = { email: 'kwok@example.com' };
  return w.applyHeat();
});
await settle(page, 2500);
await fly(121.49, 31.23, 13);
await page.evaluate(() => window.__worldMap.setSnap('peek'));
await settle(page, 1500);
await shot('4-footprint');

// 5 未登入時的提示
await page.evaluate(() => {
  const w = window.__worldMap;
  w.state.user = null;
  w.state.heat.foot = true;
  w.state.heat.footRec = false;
  w.applyHeat();
});
await page.click('#btn-layer');
await page.evaluate(() => document.getElementById('foot-login')?.scrollIntoView({ block: 'center' }));
await settle(page, 500);
await shot('5-footprint-login');

console.log('base', BASE);
console.log(errors.length ? 'errors:\n' + errors.join('\n') : 'no page errors');
await browser.close();
