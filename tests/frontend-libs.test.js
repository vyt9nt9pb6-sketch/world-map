import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amapIosUri, amapWebUrl, appleMapsUrl, amapAndroidUri, detectPlatform } from '../public/js/lib/navlinks.js';
import { formatDistance, formatDuration, formatYuan } from '../public/js/lib/format.js';
import { layerPlan } from '../public/js/lib/layers.js';

const start = { lng: 119.221611, lat: 34.596653, name: '起點A', poiId: 'B0START001' };
const dest = { lng: 118.796877, lat: 32.060255, name: '南京站', poiId: 'B00190YPLY' };
const me = { isCurrentLocation: true, name: '我的位置' };

test('高德 iOS URI：GCJ-02、dev=0、t=0、途經點', () => {
  const u = new URL(amapIosUri({ start, dest, via: [{ lng: 119, lat: 33.5, name: '淮安' }] }).replace('iosamap://', 'https://h/'));
  const q = u.searchParams;
  assert.equal(u.pathname, '/path');
  assert.equal(q.get('sourceApplication'), 'WorldMap');
  assert.equal(q.get('slat'), '34.596653');
  assert.equal(q.get('slon'), '119.221611');
  assert.equal(q.get('dlat'), '32.060255');
  assert.equal(q.get('dname'), '南京站');
  assert.equal(q.get('did'), 'B00190YPLY');
  assert.equal(q.get('dev'), '0');
  assert.equal(q.get('t'), '0');
  assert.equal(q.get('vian'), '1');
  assert.equal(q.get('vialats'), '33.500000');
  assert.ok(amapIosUri({ start, dest }).startsWith('iosamap://path?'));
});

test('起點為「我的位置」時不帶起點座標', () => {
  const q = new URL(amapIosUri({ start: me, dest }).replace('iosamap://', 'https://h/')).searchParams;
  assert.equal(q.get('slat'), null);
  assert.equal(q.get('sname'), null);
  assert.equal(new URL(amapWebUrl({ start: me, dest })).searchParams.get('from'), null);
  assert.equal(new URL(appleMapsUrl({ start: me, dest })).searchParams.get('saddr'), null);
});

test('高德網頁版 URL', () => {
  const u = new URL(amapWebUrl({ start, dest, via: [{ lng: 1, lat: 2, name: 'a,b' }, { lng: 3, lat: 4 }], strategy: 'avoid_tolls' }));
  assert.equal(u.origin + u.pathname, 'https://uri.amap.com/navigation');
  assert.equal(u.searchParams.get('from'), '119.221611,34.596653,起點A');
  assert.equal(u.searchParams.get('to'), '118.796877,32.060255,南京站');
  assert.equal(u.searchParams.get('via'), '1.000000,2.000000,a b'); // 只帶第一個，名稱中的逗號被替換
  assert.equal(u.searchParams.get('policy'), '2');
  assert.equal(u.searchParams.get('coordinate'), 'gaode');
  assert.equal(u.searchParams.get('mode'), 'car');
});

test('Apple 地圖 URL：lat,lng 順序、駕車', () => {
  const u = new URL(appleMapsUrl({ start, dest }));
  assert.equal(u.origin, 'https://maps.apple.com');
  assert.equal(u.searchParams.get('saddr'), '34.596653,119.221611');
  assert.equal(u.searchParams.get('daddr'), '32.060255,118.796877');
  assert.equal(u.searchParams.get('dirflg'), 'd');
});

test('Android URI 與平台判斷', () => {
  assert.ok(amapAndroidUri({ start, dest }).startsWith('amapuri://route/plan/?sourceApplication=WorldMap'));
  assert.equal(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5).isIOS, true);
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5).isIOS, true); // iPadOS
  assert.equal(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0).isMobile, false);
  assert.equal(detectPlatform('Mozilla/5.0 (Linux; Android 14)', 5).isAndroid, true);
  assert.throws(() => appleMapsUrl({ start }));
});

test('格式化', () => {
  assert.equal(formatDistance(850), '850 公尺');
  assert.equal(formatDistance(12345), '12.3 公里');
  assert.equal(formatDistance(321714), '322 公里');
  assert.equal(formatDuration(12271), '3 小時 25 分');
  assert.equal(formatDuration(3600), '1 小時');
  assert.equal(formatDuration(20), '1 分鐘');
  assert.equal(formatYuan(151), '¥151');
  assert.equal(formatYuan(0), '免費');
  assert.equal(formatYuan(null), '—');
});

test('圖層：高 DPI 使用 512px 底圖＋標註層', () => {
  const hd = layerPlan(3);
  assert.equal(hd.hd, true);
  assert.equal(hd.standard.length, 2);
  assert.match(hd.standard[0].url, /scl=2/);
  assert.match(hd.standard[1].url, /ltype=4/);
  const sd = layerPlan(1);
  assert.equal(sd.standard.length, 1);
  assert.match(sd.standard[0].url, /webrd/);
});
