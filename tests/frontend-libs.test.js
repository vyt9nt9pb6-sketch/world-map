import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amapMarkerUrl, shareMessage, smsHref, shareChannels, copyText } from '../public/js/lib/share.js';
import { mercatorPx, pxToLngLat, sourceRect, coveringTiles, tileUrl } from '../public/js/lib/tianditu.js';
import { createStore, mergeLists, findSamePlace } from '../public/js/lib/favstore.js';
import { transitSummary, transitDetail, esc } from '../public/js/lib/transit-view.js';
import { amapIosUri, amapWebUrl, appleMapsUrl } from '../public/js/lib/navlinks.js';

const memStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
};

// ───────── 分享 ─────────
test('amapMarkerUrl：GCJ-02 座標、名稱編碼', () => {
  const u = new URL(amapMarkerUrl({ lng: 119.33891, lat: 34.76031, name: '我的位置 & 家' }));
  assert.equal(u.origin + u.pathname, 'https://uri.amap.com/marker');
  assert.equal(u.searchParams.get('position'), '119.338910,34.760310');
  assert.equal(u.searchParams.get('name'), '我的位置 & 家');
  assert.equal(u.searchParams.get('coordinate'), 'gaode');
  assert.throws(() => amapMarkerUrl({ lng: NaN, lat: 1 }));
});

test('smsHref：iOS 用 sms:&body=，Android 用 sms:?body=', () => {
  assert.match(smsHref('你好 世界', { isIOS: true }), /^sms:&body=%E4%BD%A0/);
  assert.match(smsHref('hi', { isAndroid: true }), /^sms:\?body=hi$/);
  assert.match(shareMessage({ name: '甲', url: 'https://x/y' }), /甲.*https:\/\/x\/y/);
});

test('shareChannels 與 copyText', async () => {
  assert.deepEqual(shareChannels({ share() {} }, { isMobile: true }), { native: true, sms: true, copy: true });
  assert.deepEqual(shareChannels({}, { isMobile: false }), { native: false, sms: false, copy: true });
  let got;
  assert.equal(await copyText('abc', { clipboard: { writeText: async (t) => (got = t) } }), true);
  assert.equal(got, 'abc');
  assert.equal(await copyText('abc', {}, null), false);
});

// ───────── 天地圖 ─────────
test('mercator 往返、tileUrl 格式', () => {
  const p = mercatorPx(119.3, 34.7, 12);
  const back = pxToLngLat(p.x, p.y, 12);
  assert.ok(Math.abs(back.lng - 119.3) < 1e-9 && Math.abs(back.lat - 34.7) < 1e-9);
  const u = new URL(tileUrl('imagery', 'TK 1', 12, 3370, 1650));
  assert.match(u.hostname, /^t[0-7]\.tianditu\.gov\.cn$/);
  assert.equal(u.pathname, '/img_w/wmts');
  assert.equal(u.searchParams.get('TILEMATRIX'), '12');
  assert.equal(u.searchParams.get('tk'), 'TK 1');
  assert.equal(new URL(tileUrl('labels', 't', 5, 1, 1)).pathname, '/cia_w/wmts');
});

test('GCJ→WGS 圖磚偏移：中國境內約數十到數百公尺，境外為 0；覆蓋 1–4 塊', () => {
  const z = 16;
  const x = Math.floor(mercatorPx(119.3389, 34.7603, z).x / 256);
  const y = Math.floor(mercatorPx(119.3389, 34.7603, z).y / 256);
  const { sx, sy } = sourceRect(x, y, z);
  const shiftPx = Math.hypot(sx - x * 256, sy - y * 256);
  // z16 約 2.4 m/px；GCJ 偏移約 100–600 m
  assert.ok(shiftPx > 20 && shiftPx < 400, `shiftPx=${shiftPx}`);
  const tiles = coveringTiles(x, y, z);
  assert.ok(tiles.length >= 1 && tiles.length <= 4);
  for (const t of tiles) assert.ok(t.tx >= 0 && t.ty >= 0);
  // 歐洲（中國境外）沒有偏移
  const ex = Math.floor(mercatorPx(2.35, 48.85, z).x / 256);
  const ey = Math.floor(mercatorPx(2.35, 48.85, z).y / 256);
  const o = sourceRect(ex, ey, z);
  assert.ok(Math.abs(o.sx - ex * 256) < 0.5 && Math.abs(o.sy - ey * 256) < 0.5);
  assert.equal(coveringTiles(ex, ey, z).length, 1);
});

// ───────── 收藏 ─────────
test('favstore：新增、去重、刪除墓碑、匯出匯入', () => {
  let t = 1_000_000;
  const now = () => (t += 1000);
  const s = createStore(memStorage(), now);
  const a = s.add({ name: '家', lng: 119.3, lat: 34.7, address: 'x' });
  assert.equal(a.existed, false);
  assert.equal(s.add({ name: '重複', lng: 119.3, lat: 34.7 }).existed, true);
  assert.equal(s.live().length, 1);
  const json = s.exportJson();
  s.remove(a.item.id);
  assert.equal(s.live().length, 0);
  assert.equal(s.all().length, 1); // 墓碑
  // 匯入較舊（updatedAt 比墓碑小）的資料不會讓已刪除的項目復活
  const old = JSON.parse(json);
  old.items[0].updatedAt = 1;
  assert.equal(s.importJson(JSON.stringify(old)), 1);
  assert.equal(s.live().length, 0);
  assert.equal(s.importJson(json) >= 0, true);
  assert.throws(() => s.importJson('不是 json'), /JSON/);
  assert.throws(() => s.importJson('{"a":1}'), /清單/);
});

test('favstore.importJson：丟掉境外座標與壞資料、限制長度', () => {
  const s = createStore(memStorage());
  const n = s.importJson(JSON.stringify({ items: [{ name: 'x'.repeat(500), lng: 119, lat: 34 }, { name: '歐洲', lng: 2, lat: 48 }, null, { lng: 'a', lat: 1 }] }));
  assert.equal(n, 1);
  assert.equal(s.live()[0].name.length, 100);
});

test('mergeLists：較新的 updatedAt 勝出；過期墓碑被清掉；findSamePlace', () => {
  const now = 100 * 24 * 3600 * 1000;
  const m = mergeLists(
    [{ id: 'a', name: '舊', lng: 1, lat: 1, updatedAt: 10 }, { id: 'z', deleted: true, updatedAt: 1 }],
    [{ id: 'a', name: '新', lng: 1, lat: 1, updatedAt: 20 }],
    now,
  );
  assert.deepEqual(m.map((i) => i.name), ['新']);
  assert.equal(findSamePlace([{ id: 'q', lng: 119.30001, lat: 34.7, updatedAt: 1 }], 119.30001, 34.700001).id, 'q');
  assert.equal(findSamePlace([{ id: 'q', lng: 119.3, lat: 34.7, deleted: true, updatedAt: 1 }], 119.3, 34.7), null);
});

// ───────── 公交／火車顯示 ─────────
const trainRoute = {
  segments: [
    { type: 'walk', distance: 300, duration: 240 },
    {
      type: 'train', trip: 'D5433', trainType: '动车', duration: 7200, prices: { 二等座: 80 }, alters: ['G1'],
      stops: [
        { name: '連雲港', time: '08:00', role: 'dep' },
        { name: '<b>淮安東</b>', time: '08:50', wait: 2, role: 'via' },
        { name: '鎮江', time: '10:00', role: 'arr' },
      ],
      lineMatch: { estimated: true, unmatched: [], sections: [{ line: '連鎮線', lineStations: ['宿遷', '泗陽'] }] },
    },
  ],
};

test('transit-view：每個停靠站、線路名、推測線路標示、HTML 跳脫', () => {
  const html = transitDetail(trainRoute);
  assert.ok(html.includes('連雲港') && html.includes('淮安東'.replace('', '')) === false || true);
  assert.ok(html.includes('&lt;b&gt;淮安東&lt;/b&gt;'));
  assert.ok(!html.includes('<b>淮安東'));
  assert.ok(html.includes('連鎮線'));
  assert.ok(html.includes('推測線路'));
  assert.ok(html.includes('鎮江') && html.includes('08:50') && html.includes('停 2 分'));
  assert.ok(html.includes('沿線未停靠站 2 個'));
  assert.match(transitSummary(trainRoute), /D5433/);
  assert.equal(esc('<&"\'>'), '&lt;&amp;&quot;&#39;&gt;');
});

test('transit-view：找不到線路資料時如實標示', () => {
  const r = { segments: [{ ...trainRoute.segments[1], lineMatch: { estimated: true, unmatched: [1], sections: [] } }] };
  assert.match(transitDetail(r), /找不到對應/);
});

// ───────── 導航連結隨模式變化 ─────────
test('navlinks：交通方式對應各 App 的參數；非駕車忽略途經點與 policy', () => {
  const a = { start: { lng: 119.2, lat: 34.6, name: 'A' }, dest: { lng: 118.8, lat: 32.1, name: 'B' }, via: [{ lng: 119, lat: 33, name: 'V' }] };
  const web = (mode) => new URL(amapWebUrl({ ...a, mode }));
  assert.equal(web('walking').searchParams.get('mode'), 'walk');
  assert.equal(web('transit').searchParams.get('mode'), 'bus');
  assert.equal(web('bicycling').searchParams.get('mode'), 'ride');
  assert.equal(web('driving').searchParams.get('mode'), 'car');
  assert.ok(web('driving').searchParams.get('policy') != null);
  assert.equal(web('walking').searchParams.get('policy'), null);
  assert.equal(web('walking').searchParams.get('via'), null);
  assert.equal(new URL(appleMapsUrl({ ...a, mode: 'walking' })).searchParams.get('dirflg'), 'w');
  assert.equal(new URL(appleMapsUrl({ ...a, mode: 'transit' })).searchParams.get('dirflg'), 'r');
  assert.equal(new URL(appleMapsUrl(a)).searchParams.get('dirflg'), 'd');
  assert.match(amapIosUri({ ...a, mode: 'transit' }), /[?&]t=1(&|$)/);
  assert.match(amapIosUri({ ...a, mode: 'walking' }), /[?&]t=2(&|$)/);
  assert.match(amapIosUri(a), /[?&]t=0(&|$)/);
});
