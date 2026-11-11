// Playwright 輔助：以真的 WebGL（SwiftShader）開手機視窗；可選擇用本機 public/ 檔案覆蓋線上靜態檔（API 仍打線上 Worker）
import { chromium } from 'playwright-core';
import { readFileSync, existsSync, statSync } from 'fs';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';
export const BASE = process.env.WM_BASE || 'https://world-map.kwok-worldmap.workers.dev';
const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.gz': 'application/gzip', '.bin': 'application/octet-stream', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
export async function launch({ local = false, geo = { longitude: 121.4737, latitude: 31.2304 }, dpr = 3, dark = false } = {}) {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, locale: 'zh-TW',
    geolocation: geo, permissions: ['geolocation'], colorScheme: dark ? 'dark' : 'light',
  });
  // 高德 JS API 偵測到軟體渲染器（SwiftShader）會退回 2D；測試環境把渲染器名稱偽裝成一般 GPU（只影響這個測試瀏覽器）
  await ctx.addInitScript(() => {
    window.forceWebGL = true; // Linux 被高德視為 'other' 平台而不啟用 3D；測試環境強制
    const patch = (proto) => {
      const orig = proto.getParameter;
      proto.getParameter = function (p) {
        if (p === 0x9245) return 'Apple Inc.';
        if (p === 0x9246) return 'Apple GPU';
        return orig.call(this, p);
      };
    };
    if (window.WebGLRenderingContext) patch(WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) patch(WebGL2RenderingContext.prototype);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (local) {
    const root = PUBLIC;
    await page.route(`${BASE}/**`, (route) => {
      const u = new URL(route.request().url());
      if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/_AMapService')) return route.continue();
      let p = u.pathname === '/' ? '/index.html' : u.pathname;
      const f = join(root, p);
      if (existsSync(f) && statSync(f).isFile()) {
        return route.fulfill({ status: 200, body: readFileSync(f), headers: { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' } });
      }
      return route.continue();
    });
  }
  return { browser, ctx, page, errors };
}
export async function boot(page) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!window.__worldMap?.view, null, { timeout: 45000 });
  await page.evaluate(() => localStorage.clear());
}
export const settle = async (page, ms = 2500) => {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
};
