// 更細的人口熱力 + 圖層面板捲動（iPhone 390×844，以及橫向 844×390）
// 用法：node scripts/screenshots-finer.mjs before|after|panel
import { mkdirSync } from 'node:fs';
import { launch, boot, settle, BASE } from './lib-pw.mjs';

const mode = process.argv[2] || 'after';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const local = mode !== 'before';
const { browser, page, errors } = await launch({
  local,
  geo: { longitude: 116.397, latitude: 39.909 },
  dpr: 2,
});
page.on('console', (m) => {
  if (m.type() === 'error' && !/CORS|ERR_FAILED|net::|Content Security Policy/.test(m.text())) errors.push(m.text().slice(0, 240));
});

if (local) {
  await page.route('**/api/auth/me', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: { email: 'kwok@example.com' } }),
  }));
  await page.route('**/api/favorites**', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ items: [], serverTime: Date.now() }),
  }));
  await page.route('**/api/footprint**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store' },
    body: JSON.stringify({ points: [], count: 0, ok: true }),
  }));
}

const shot = (name) => page.screenshot({ path: `${OUT}${name}.png` });
const fly = (lng, lat, z) => page.evaluate(([a, b, c]) => window.__worldMap.view.flyTo({ lng: a, lat: b }, c, 0, false), [lng, lat, z]);

await boot(page);
await settle(page, 1800);
await fly(116.407, 39.904, 15);
await page.evaluate(() => window.__worldMap.setSnap('peek'));
await settle(page, 1200);

if (mode === 'panel') {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFullPanel(page);
  const metrics = await panelMetrics(page);
  await shot('v5-panel-portrait');
  await page.locator('#layer-modal .modal-sheet').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(300);
  const after = await panelMetrics(page);
  const center = await mapCenter(page);
  await page.locator('#layer-modal .modal-sheet').evaluate((el) => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: 400, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(200);
  const center2 = await mapCenter(page);
  await shot('v5-panel-portrait-scrolled');
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(400);
  await page.locator('#layer-modal .modal-sheet').evaluate((el) => { el.scrollTop = 0; });
  await shot('v5-panel-landscape');
  await page.locator('#layer-modal .modal-sheet').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(200);
  const land = await panelMetrics(page);
  await shot('v5-panel-landscape-scrolled');
  console.log(JSON.stringify({ metrics, after, land, center, center2, bodyScroll: await page.evaluate(() => document.scrollingElement.scrollTop), errors }, null, 2));
} else {
  await page.click('#btn-layer');
  await page.locator('#opt-pop').scrollIntoViewIfNeeded();
  await page.click('#opt-pop');
  await page.waitForFunction(() => document.getElementById('pop-note')?.textContent?.includes('公里'), null, { timeout: 25000 }).catch(() => {});
  await settle(page, 2000);
  const note = await page.locator('#pop-note').textContent().catch(() => '');
  await page.click('#layer-close');
  await fly(116.407, 39.904, 15);
  await settle(page, 3500);
  await shot(mode === 'before' ? 'v5-pop-beijing-before' : 'v5-pop-beijing-after');
  console.log(JSON.stringify({ mode, base: BASE, local, note, errors }, null, 2));
}

await browser.close();
if (errors.length) process.exitCode = 1;

async function openFullPanel(page) {
  await page.click('#btn-layer');
  await page.waitForSelector('#layer-modal:not(.hidden)');
  await page.evaluate(() => {
    const w = window.__worldMap;
    w.state.user = { email: 'kwok@example.com' };
    w.state.heat.pop = true;
    w.state.heat.traffic = true;
    w.state.heat.foot = true;
    document.getElementById('opt-pop').setAttribute('aria-checked', 'true');
    document.getElementById('opt-traffic').setAttribute('aria-checked', 'true');
    document.getElementById('opt-foot').setAttribute('aria-checked', 'true');
    document.getElementById('pop-extra')?.classList.remove('hidden');
    document.getElementById('traffic-legend')?.classList.remove('hidden');
    document.getElementById('foot-extra')?.classList.remove('hidden');
    document.getElementById('foot-login')?.classList.add('hidden');
    document.getElementById('foot-tools')?.classList.remove('hidden');
  });
  await page.waitForTimeout(400);
}

async function panelMetrics(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('#layer-modal .modal-sheet');
    const modal = document.getElementById('layer-modal');
    const clear = document.getElementById('foot-clear');
    const cr = clear.getBoundingClientRect();
    const sr = sheet.getBoundingClientRect();
    const vv = window.visualViewport;
    return {
      vw: window.innerWidth,
      vh: window.innerHeight,
      vv: vv ? { w: vv.width, h: vv.height } : null,
      sheetH: Math.round(sr.height),
      scrollH: sheet.scrollHeight,
      clientH: sheet.clientHeight,
      scrollTop: sheet.scrollTop,
      overflowY: getComputedStyle(sheet).overflowY,
      webkit: getComputedStyle(sheet).webkitOverflowScrolling,
      maxH: getComputedStyle(sheet).maxHeight,
      bodyOverflow: getComputedStyle(document.body).overflow,
      modalTouch: getComputedStyle(modal).touchAction,
      clearVisible: cr.bottom <= sr.bottom + 2 && cr.top >= sr.top - 2,
      clearBottom: Math.round(cr.bottom),
      sheetBottom: Math.round(sr.bottom),
    };
  });
}

async function mapCenter(page) {
  return page.evaluate(() => {
    const c = window.__worldMap.view.getCenter();
    return { lng: Math.round(c.lng * 1e5) / 1e5, lat: Math.round(c.lat * 1e5) / 1e5, z: window.__worldMap.view.getZoom() };
  });
}
