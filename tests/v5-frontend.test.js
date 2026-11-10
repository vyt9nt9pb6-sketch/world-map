import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/css/glass.css', import.meta.url), 'utf8');

test('圖層面板有三個熱力開關、透明度、圖例與足跡隱私說明', () => {
  assert.match(html, /id="opt-pop"/);
  assert.match(html, /id="opt-traffic"/);
  assert.match(html, /id="opt-foot"/);
  assert.match(html, /id="pop-opacity"/);
  assert.match(html, /id="foot-clear"/);
  assert.match(html, /登入後才能記錄與查看自己的足跡/);
  assert.match(html, /2020 年靜態估計，不是即時人流/);
  assert.match(html, /人\/km² · 2020 靜態估計/);
  assert.match(html, /Chen et al\. 2024/);
  assert.match(app, /createTrafficLayer/);
  assert.match(app, /createPopulationLayer/);
  assert.match(app, /AMap\.HeatMap/);
  assert.match(app, /footprintAdd/);
  assert.match(app, /footprintClear/);
  assert.match(app, /FOOT_BACKGROUND/);
  assert.match(css, /\.heat-hud/);
  assert.match(css, /\.heat-bar/);
});
