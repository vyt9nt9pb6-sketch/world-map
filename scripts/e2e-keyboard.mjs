// iPhone 尺寸（390×844）模擬 iOS Safari 開鍵盤：偽造 visualViewport（高度縮小、可選頁面被捲動 offsetTop），
// 驗證搜尋框一直在可見範圍內。並截「精簡圖層選單」。真機鍵盤只有 iPhone 能最終確認。
// 用法：WM_LOCAL=1 node scripts/e2e-keyboard.mjs
import { launch, boot, settle } from './lib-pw.mjs';
const OUT = new URL('../screenshots/', import.meta.url).pathname;
const { browser, ctx, page, errors } = await launch({ local: process.env.WM_LOCAL === '1' });
await ctx.addInitScript(() => {
  const vv = new EventTarget();
  Object.assign(vv, { height: window.innerHeight, width: window.innerWidth, offsetTop: 0, offsetLeft: 0, pageTop: 0, scale: 1 });
  Object.defineProperty(window, 'visualViewport', { get: () => vv, configurable: true });
  window.__vvSet = (h, top = 0) => {
    vv.height = h; vv.offsetTop = top;
    vv.dispatchEvent(new Event('resize')); vv.dispatchEvent(new Event('scroll'));
  };
});
await boot(page);
await settle(page, 2000);
const H = 844, KB = 336;
const check = async (label, top) => {
  await page.evaluate(([h, t]) => window.__vvSet(h, t), [H - KB, top]);
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    const vv = window.visualViewport;
    const inp = b('#search-input'); const sh = b('.sheet');
    return { inpTop: inp.top, inpBottom: inp.bottom, shTop: sh.top, shBottom: sh.bottom, vvTop: vv.offsetTop, vvBottom: vv.offsetTop + vv.height };
  });
  const ok = r.inpTop >= r.vvTop && r.inpBottom <= r.vvBottom && r.shTop >= r.vvTop - 0.5 && r.shBottom <= r.vvBottom + 0.5;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`, JSON.stringify(r));
  if (!ok) process.exitCode = 1;
};
await page.tap('#search-input');
await page.waitForTimeout(400);
await check('鍵盤開啟、頁面沒被捲動', 0);
await page.screenshot({ path: `${OUT}v4b-1-search-keyboard-sim.png` });
await check('鍵盤開啟、Safari 把頁面往上捲 120px', 120);
await page.evaluate(() => window.__vvSet(844, 0));
await page.waitForTimeout(900);
const back = await page.evaluate(() => ({ kb: window.__worldMap.vvState.kb, h: document.querySelector('.sheet').getBoundingClientRect().height }));
console.log('鍵盤收起 →', JSON.stringify(back));
await page.evaluate(() => document.activeElement.blur());
await page.evaluate(() => window.__worldMap.setSnap('half'));
await settle(page, 800);

// 圖層選單（精簡）
await page.click('#btn-layer');
await settle(page, 1200);
const fit = await page.evaluate(() => {
  const sh = document.querySelector('#layer-modal .modal-sheet, .modal-sheet:not(.hidden)') || document.querySelector('.modal-sheet');
  const rows = [...document.querySelectorAll('.layer-opts .opt-row, .layer-opts .opt-block')].filter((e) => e.offsetParent);
  const last = rows.at(-1)?.getBoundingClientRect();
  return { grid: document.querySelector('#layer-cards').getBoundingClientRect().height, lastBottom: last?.bottom, inner: window.innerHeight, scroll: sh ? sh.scrollHeight - sh.clientHeight : null };
});
console.log('圖層選單', JSON.stringify(fit));
await page.screenshot({ path: `${OUT}v4b-2-layer-picker.png` });
await page.click('#layer-close');
await page.evaluate(async () => { const w = window.__worldMap; Object.assign(w.state.layer, { mode: 'satellite', source: 'amap' }); await w.applyLayer(); });
await page.click('#btn-layer');
await settle(page, 1200);
const fit2 = await page.evaluate(() => {
  const sh = document.querySelector('.modal-sheet');
  const rows = [...document.querySelectorAll('.layer-opts .opt-row, .layer-opts .opt-block')].filter((e) => e.offsetParent);
  return { lastBottom: rows.at(-1)?.getBoundingClientRect().bottom, inner: window.innerHeight, scroll: sh.scrollHeight - sh.clientHeight };
});
console.log('圖層選單（衛星模式，選項最多）', JSON.stringify(fit2));
await page.screenshot({ path: `${OUT}v4b-3-layer-picker-satellite.png` });
await browser.close();
console.log(errors.filter((e) => !/key=/.test(e)).slice(0, 5).join('\n') || '無 JS 錯誤');
