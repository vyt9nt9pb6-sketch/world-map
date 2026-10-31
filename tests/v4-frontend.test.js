import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest } from '../core/handlers.js';
import { splitTels, telHref, safeImg, subLine, badgesHtml, photosHtml, infoRows, viewportRadius, movedEnough } from '../public/js/lib/place-view.js';
import { drivingCardHtml, routeLabelHtml, midPoint, quickPicks, etaText, tagsHtml } from '../public/js/lib/route-view.js';
import { createReachProbe } from '../public/js/lib/reach.js';
import { fakeFetch, post, FAKE_KEY } from './helpers.js';

test('place-view：電話拆分去重、tel: 連結只留數字、XSS 跳脫', () => {
  assert.deepEqual(splitTels('010-1234;010-1234；021 555'), ['010-1234', '021 555']);
  assert.equal(telHref('(010) 1234-5678'), 'tel:01012345678');
  assert.equal(telHref('+86 138 0000'), 'tel:+861380000');
  assert.equal(telHref('無'), '');
  const rows = infoRows({ tel: '<img onerror=1>;010-1' }, { address: '<b>x</b>' });
  const html = JSON.stringify(rows);
  assert.ok(!html.includes('<img onerror') && !html.includes('<b>x</b>'));
  assert.ok(rows.some((r) => r[0] === '電話' && r[1].includes('href="tel:0101"')));
});

test('place-view：沒有資料的欄位不顯示；評分／人均／營業時間膠囊', () => {
  assert.deepEqual(infoRows({}, {}), []);
  assert.equal(badgesHtml({}), '');
  const b = badgesHtml({ rating: 4.56, cost: 88.4, openToday: '09:00-21:00' });
  assert.match(b, /4\.6/);
  assert.match(b, /人均 ¥88/);
  assert.match(b, /今日 09:00-21:00/);
  assert.equal(subLine({ type: '餐飲服務;中餐廳;川菜' }, 1500), '川菜 · 1.5 公里');
});

test('place-view：照片只接受 https（http 升級、javascript: 丟棄），最多 8 張', () => {
  assert.equal(safeImg('http://store.is.autonavi.com/a.jpg'), 'https://store.is.autonavi.com/a.jpg');
  assert.equal(safeImg('javascript:alert(1)'), '');
  assert.equal(safeImg('data:image/png;base64,AAA'), '');
  const photos = Array.from({ length: 12 }, (_, i) => ({ url: `http://x.autonavi.com/${i}.jpg`, title: `p${i}` }));
  photos.push({ url: 'javascript:1' });
  assert.equal((photosHtml(photos).match(/<img /g) || []).length, 8);
  assert.ok(!photosHtml([{ url: 'javascript:1' }]));
});

test('place-view：視窗半徑（Web Mercator 公式）與是否需要重新搜尋', () => {
  // zoom 15、赤道：4.777 m/px；390×700 取短邊一半 → 約 931 m
  assert.ok(Math.abs(viewportRadius({ zoom: 15, lat: 0, width: 390, height: 700 }) - 931) <= 2);
  // 高緯度每像素公尺數變小
  assert.ok(viewportRadius({ zoom: 15, lat: 60, width: 390, height: 700 }) < 500);
  assert.equal(viewportRadius({ zoom: 22, lat: 30, width: 390, height: 700 }), 300); // 下限
  assert.equal(viewportRadius({ zoom: 3, lat: 0, width: 390, height: 700 }), 50000); // 上限
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const prev = { center: { x: 0, y: 0 }, zoom: 15, radius: 1000 };
  assert.equal(movedEnough(null, prev, dist), true);
  assert.equal(movedEnough(prev, { center: { x: 100, y: 0 }, zoom: 15.1, radius: 1000 }, dist), false); // 小動作不重查
  assert.equal(movedEnough(prev, { center: { x: 300, y: 0 }, zoom: 15, radius: 1000 }, dist), true);
  assert.equal(movedEnough(prev, { center: { x: 0, y: 0 }, zoom: 15.5, radius: 1000 }, dist), true);
});

test('route-view：多路線卡片含時間、距離、標籤、直線距離與繞行倍數；內容跳脫', () => {
  const r = { duration: 3600, distance: 52000, tolls: 20, tollDistance: 10000, trafficLights: 7, roads: ['G4', '<script>'], tags: ['fastest', 'shortest'], straightDistance: 40000, detour: 1.3 };
  const html = drivingCardHtml(r, { departSec: 1_800_000_000 });
  assert.match(html, /t-fastest/);
  assert.match(html, /最短距離/);
  assert.match(html, /直線 40/);
  assert.match(html, /繞行 1\.30 倍/);
  assert.match(html, /抵達/);
  assert.ok(!html.includes('<script>'));
  assert.equal(tagsHtml([]), '');
  assert.match(routeLabelHtml(r, true), /route-label sel/);
  assert.match(routeLabelHtml(r, false), /最短/);
});

test('route-view：ETA = 出發時間 ＋ 行駛時間；折線中點；快速選擇', () => {
  const dep = Math.floor(new Date(2030, 0, 15, 8, 0, 0).getTime() / 1000);
  assert.equal(etaText(5400, dep), '1/15 09:30 抵達');
  assert.equal(etaText(NaN, dep), '');
  const m = midPoint([[0, 0], [2, 0], [2, 2]]);
  assert.deepEqual(m, { lng: 2, lat: 0 });
  assert.deepEqual(midPoint([[0, 0], [10, 0]], 0.25), { lng: 2.5, lat: 0 });
  assert.equal(midPoint([]), null);
  const routes = [{ tags: ['recommend'] }, { tags: ['shortest'] }, { tags: ['fastest', 'leastToll'] }];
  assert.deepEqual(quickPicks(routes).map((p) => [p.tag, p.index]), [['fastest', 2], ['shortest', 1], ['leastToll', 2]]);
  assert.deepEqual(quickPicks([{ tags: ['fastest'] }]), []);
});

test('reach：能收到回應＝可達；逾時／網路錯誤＝不可達；結果暫存', async () => {
  let t = 0;
  let calls = 0;
  const ok = createReachProbe({ fetchImpl: async () => { calls++; return {}; }, now: () => t });
  assert.equal(await ok(), true);
  assert.equal(await ok(), true);
  assert.equal(calls, 1);
  t = 61_000;
  assert.equal(await ok(), true);
  assert.equal(calls, 2);
  const bad = createReachProbe({ fetchImpl: async () => { throw new TypeError('network'); }, now: () => 0 });
  assert.equal(await bad(), false);
  // 真的逾時：fetch 永遠不回應，靠 AbortController 中止
  const hang = createReachProbe({ timeoutMs: 20, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  assert.equal(await hang(), false);
});

test('google-tiles/session：type=terrain 時送出 terrain＋layerRoadmap；預設仍是衛星；回應不含 key', async () => {
  const f = fakeFetch(() => ({ session: 'S1', expiry: '1', tileWidth: 256, tileHeight: 256 }));
  const env = { AMAP_KEY: FAKE_KEY, GOOGLE_MAPS_TILE_KEY: 'AIza_TEST' };
  const res = await handleApiRequest(post('/api/google-tiles/session', { type: 'terrain' }), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const sent = JSON.parse(f.calls[0].init.body);
  assert.equal(sent.mapType, 'terrain');
  assert.deepEqual(sent.layerTypes, ['layerRoadmap']);
  const text = await res.text();
  assert.ok(!text.includes('AIza_TEST'));
  assert.equal(JSON.parse(text).type, 'terrain');
  const f2 = fakeFetch(() => ({ session: 'S2' }));
  await handleApiRequest(post('/api/google-tiles/session', {}), env, { fetchImpl: f2 });
  assert.equal(JSON.parse(f2.calls[0].init.body).mapType, 'satellite');
});
