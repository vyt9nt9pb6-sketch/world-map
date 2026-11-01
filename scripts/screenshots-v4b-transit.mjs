// 大眾運輸圖層截圖（iPhone 390×844 @3x）→ screenshots/v4b-4/5-transit-*.png；WM_LOCAL=1 用本機 public/ 覆蓋靜態檔
import { launch, boot, settle } from './lib-pw.mjs';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const { browser, page, errors } = await launch({ local: process.env.WM_LOCAL === '1' });
page.on('console', (m) => { if (m.type() === 'error' && !/CORS|ERR_FAILED|key=/.test(m.text())) errors.push(m.text().slice(0, 160)); });
await boot(page);
await settle(page, 2000);
await page.evaluate(async () => { const w = window.__worldMap; w.state.layer.mode = 'transit'; await w.applyLayer(); w.setSnap('peek'); });
const fly = (lng, lat, z) => page.evaluate(([a, b, c]) => window.__worldMap.view.flyTo({ lng: a, lat: b }, c, 0, false), [lng, lat, z]);
const stats = () => page.evaluate(() => ({ z: window.__worldMap.view.getZoom(), polylines: document.querySelectorAll('canvas').length }));
for (const [name, lng, lat, z] of [['shanghai', 121.4737, 31.2304, 12], ['shanghai-close', 121.4737, 31.2304, 14.5], ['beijing', 116.4074, 39.9042, 11.5]]) {
  await fly(lng, lat, z);
  await settle(page, 5000);
  console.log(name, JSON.stringify(await stats()));
  await page.screenshot({ path: `${OUT}v4b-4-transit-${name}.png` });
}
await browser.close();
console.log(errors.slice(0, 5).join('\n') || '無 JS 錯誤');
