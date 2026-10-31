import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planCalls, mergeRoutes, haversine, isDuplicate, decorate } from '../core/driving.js';
import { departTime, validateRoute, validateSearch, validatePlace } from '../core/validate.js';
import { mapPlaceDetail, mapPoi, httpsUrl, splitTels, mapDrivingV3Response } from '../core/mapping.js';
import { handleApiRequest, shanghaiDateTime } from '../core/handlers.js';

const P = (o) => new URLSearchParams(o);
const env = { AMAP_KEY: 'TESTKEY_NOT_REAL' };
const req = (path) => new Request(`https://x.test${path}`, { headers: { origin: 'https://x.test' } });
function fakeFetch(fn) {
  const calls = [];
  const f = async (url) => {
    const u = new URL(url);
    calls.push(u);
    return new Response(JSON.stringify(fn(u)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  f.calls = calls;
  return f;
}

test('planCalls：開關對應到已查證的高德策略值', () => {
  assert.deepEqual(planCalls({}), [['v5', '32'], ['v3', '11']]);
  assert.deepEqual(planCalls({ avoidHighway: true }), [['v5', '35'], ['v5', '40'], ['v3', '13']]);
  assert.deepEqual(planCalls({ avoidToll: true }), [['v5', '1'], ['v5', '36'], ['v3', '14']]);
  assert.deepEqual(planCalls({ avoidHighway: true, avoidToll: true }), [['v5', '42'], ['v3', '16'], ['v3', '7']]);
  for (const n of [0, 1, 2, 3].map((i) => planCalls({ avoidToll: i % 2 === 0, avoidHighway: i > 1 }).length)) assert.ok(n <= 3, '每次最多 3 個上游請求');
});

const R = (o) => ({ index: 0, distance: 1000, duration: 600, tolls: 0, trafficLights: 5, roads: ['A'], steps: [], polyline: [[1, 1], [2, 2]], ...o });

test('mergeRoutes：去重、標記最快／最短／少收費、保證最短一定在內', () => {
  const g1 = { routes: [R({ distance: 100000, duration: 4000, tolls: 50, roads: ['G1'] }), R({ distance: 110000, duration: 3900, tolls: 80, roads: ['G2'] })] };
  const g2 = {
    routes: [
      R({ distance: 100100, duration: 4010, tolls: 50, roads: ['G1'] }), // 與第一條重複
      R({ distance: 90000, duration: 5200, tolls: 0, roads: ['S1'], trafficLights: 40 }), // 最短＋免費
      R({ distance: 120000, duration: 6000, tolls: 10, roads: ['S2'] }),
    ],
  };
  const m = mergeRoutes([g1, g2]);
  assert.equal(m.length, 4, '重複的被合併');
  assert.deepEqual(m.map((r) => r.index), [0, 1, 2, 3]);
  assert.ok(m[0].tags.includes('recommend'));
  assert.equal(m.find((r) => r.tags.includes('shortest')).distance, 90000);
  assert.equal(m.find((r) => r.tags.includes('fastest')).duration, 3900);
  assert.equal(m.find((r) => r.tags.includes('leastToll')).tolls, 0);
  assert.ok(m.some((r) => r.tags.includes('leastLights')));
});

test('mergeRoutes：避開收費優先留下免費路線；全都要收費時照實提示', () => {
  const free = { routes: [R({ tolls: 0, roads: ['S1'], distance: 5000 }), R({ tolls: 30, roads: ['G'], distance: 9000, duration: 300 })] };
  const m = mergeRoutes([free], { avoidToll: true });
  assert.equal(m.length, 1);
  assert.equal(m[0].tolls, 0);
  const allToll = mergeRoutes([{ routes: [R({ tolls: 30 })] }], { avoidToll: true });
  assert.equal(allToll.length, 1);
  assert.equal(allToll.tollNote, 'no_toll_free');
});

test('mergeRoutes：最多 5 條；沒有折線的丟掉', () => {
  const routes = Array.from({ length: 9 }, (_, i) => R({ distance: 1000 * (i + 1) * 1.2, duration: 600 + i * 100, roads: [`R${i}`] }));
  routes.push(R({ polyline: [], distance: 1 }));
  assert.equal(mergeRoutes([{ routes }]).length, 5);
});

test('haversine 與 decorate：直線距離、繞行比', () => {
  const d = haversine({ lng: 119.22, lat: 34.6 }, { lng: 118.79, lat: 32.06 });
  assert.ok(d > 280000 && d < 290000, String(d));
  const [r] = decorate([R({ distance: 400000 })], 200000);
  assert.equal(r.straightDistance, 200000);
  assert.equal(r.detour, 2);
  assert.equal(isDuplicate(R({}), R({})), true);
});

test('departTime：現在／未來／範圍／格式', () => {
  const now = 1_800_000_000;
  assert.equal(departTime(P({}), now), null);
  assert.equal(departTime(P({ depart: 'now' }), now), null);
  assert.equal(departTime(P({ depart: String(now - 60) }), now), null);
  assert.equal(departTime(P({ depart: String(now + 3600) }), now), now + 3600);
  assert.throws(() => departTime(P({ depart: String(now + 31 * 86400) }), now), /30 天/);
  assert.throws(() => departTime(P({ depart: String(now - 3600) }), now));
  assert.throws(() => departTime(P({ depart: '12abc' }), now));
  const v = validateRoute(P({ origin: '1,1', destination: '2,2', avoid_highway: '1', avoid_toll: '1' }));
  assert.equal(v.avoidHighway, true);
  assert.equal(v.avoidToll, true);
  assert.equal(v.depart, null);
});

test('shanghaiDateTime：以 UTC+8 輸出日期與時間', () => {
  // 2026-11-01 00:30:00 UTC = 2026-11-01 08:30 CST
  assert.deepEqual(shanghaiDateTime(Date.UTC(2026, 10, 1, 0, 30) / 1000), { date: '2026-11-01', time: '08:30' });
  assert.deepEqual(shanghaiDateTime(Date.UTC(2026, 10, 1, 17, 5) / 1000), { date: '2026-11-02', time: '01:05' });
});

test('mapPlaceDetail：電話、營業時間、評分、照片（升成 https）', () => {
  const place = mapPlaceDetail({
    pois: [
      {
        id: 'B000A',
        name: '某咖啡',
        type: '餐飲服務;咖啡廳',
        address: '某路 1 號',
        location: '119.2,34.6',
        business: { tel: '0518-111;0518-111;13800000000', opentime_today: '08:00-22:00', opentime_week: '周一至周日 08:00-22:00', rating: '4.6', cost: '35.00', business_area: '新浦' },
        photos: [{ title: [], url: 'http://aos-comment.amap.com/a.jpg' }, { title: '店內', url: 'https://store.is.autonavi.com/b.jpg' }, { url: 'javascript:alert(1)' }],
      },
    ],
  });
  assert.deepEqual(place.tels, ['0518-111', '13800000000']);
  assert.equal(place.tel, '0518-111');
  assert.equal(place.rating, 4.6);
  assert.equal(place.cost, 35);
  assert.equal(place.openToday, '08:00-22:00');
  assert.equal(place.openWeek, '周一至周日 08:00-22:00');
  assert.deepEqual(place.photos.map((p) => p.url), ['https://aos-comment.amap.com/a.jpg', 'https://store.is.autonavi.com/b.jpg']);
  assert.equal(mapPlaceDetail({ pois: [] }), null);
  assert.equal(httpsUrl('//x.amap.com/a.png'), 'https://x.amap.com/a.png');
  assert.equal(httpsUrl('ftp://x'), '');
  assert.deepEqual(splitTels(['']), []);
  assert.equal(mapPoi({ id: 'x', name: 'n', location: '1,2', business: { rating: '' } }).rating, null);
});

test('mapDrivingV3Response：v3 路線 → 同一格式', () => {
  const m = mapDrivingV3Response({
    route: { paths: [{ distance: '2000', duration: '300', tolls: '5', toll_distance: '1000', traffic_lights: '3', restriction: '0', steps: [{ road: 'S1', distance: '1200', instruction: 'go', polyline: '119,34;119.1,34.1' }, { road: [], distance: '800', polyline: '119.1,34.1;119.2,34.2' }] }] },
  });
  const r = m.routes[0];
  assert.equal(r.distance, 2000);
  assert.equal(r.duration, 300);
  assert.equal(r.tolls, 5);
  assert.deepEqual(r.roads, ['S1']);
  assert.equal(r.polyline.length, 3);
});

test('/api/place：呼叫 v5 place/detail 並帶 business,photos', async () => {
  const f = fakeFetch(() => ({ infocode: '10000', pois: [{ id: 'B000A', name: 'x', location: '119,34', business: { tel: '1' } }] }));
  const res = await handleApiRequest(req('/api/place?id=B000A12345'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal(f.calls[0].pathname, '/v5/place/detail');
  assert.equal(f.calls[0].searchParams.get('show_fields'), 'business,photos');
  assert.equal((await res.json()).place.name, 'x');
  assert.equal((await handleApiRequest(req('/api/place?id=bad%20id'), env, { fetchImpl: f })).status, 400);
  assert.equal((await handleApiRequest(req('/api/place'), env, { fetchImpl: f })).status, 400);
  const none = fakeFetch(() => ({ infocode: '10000', pois: [] }));
  assert.equal((await handleApiRequest(req('/api/place?id=B000A12345'), env, { fetchImpl: none })).status, 404);
  assert.throws(() => validatePlace(P({})));
});

test('/api/search area=1：用半徑範圍搜尋、不退回全國搜尋', async () => {
  const f = fakeFetch(() => ({ infocode: '10000', pois: [{ id: 'B1', name: '完全不相關', location: '119,34' }] }));
  const res = await handleApiRequest(req('/api/search?q=咖啡&location=119,34&area=1&radius=1500'), env, { fetchImpl: f });
  const b = await res.json();
  assert.equal(b.area, true);
  assert.equal(f.calls.length, 1, '不會再補查 /place/text');
  assert.equal(f.calls[0].pathname, '/v5/place/around');
  assert.equal(f.calls[0].searchParams.get('radius'), '1500');
  assert.equal(f.calls[0].searchParams.get('show_fields'), 'business,photos');
  assert.throws(() => validateSearch(P({ q: 'a', radius: '100' })));
  assert.throws(() => validateSearch(P({ q: 'a', radius: '99999' })));
});

test('/api/route 駕車：多來源合併、直線距離、出發時間誠實標示', async () => {
  const v5 = { infocode: '10000', route: { paths: [{ distance: '100000', cost: { duration: '4000', tolls: '40' }, steps: [{ road_name: 'G1', step_distance: '100000', polyline: '119,34;119.5,33' }] }] } };
  const v3 = {
    status: '1', infocode: '10000',
    route: { paths: [
      { distance: '90000', duration: '5000', tolls: '0', traffic_lights: '20', steps: [{ road: 'S1', distance: '90000', polyline: '119,34;119.3,33.2' }] },
      { distance: '120000', duration: '3900', tolls: '90', steps: [{ road: 'G2', distance: '120000', polyline: '119,34;119.7,33.1' }] },
    ] },
  };
  const f = fakeFetch((u) => (u.pathname === '/v3/direction/driving' ? v3 : v5));
  const when = Math.floor(Date.now() / 1000) + 7200;
  const res = await handleApiRequest(req(`/api/route?origin=119,34&destination=118.7,32&depart=${when}`), env, { fetchImpl: f });
  const b = await res.json();
  assert.equal(b.routes.length, 3);
  assert.ok(b.routes.every((r) => r.straightDistance > 200000 && r.detour > 0));
  assert.equal(b.routes.find((r) => r.tags.includes('shortest')).distance, 90000);
  assert.deepEqual(b.depart, { at: when, mode: 'live', supported: false });
  assert.ok(!f.calls.some((u) => u.pathname.includes('etd')), '不呼叫企業限定的 etd');
});

test('/api/route 駕車：其中一個上游失敗仍回傳其他結果；全部失敗才報錯', async () => {
  const v5 = { infocode: '10000', route: { paths: [{ distance: '1000', cost: { duration: '100' }, steps: [{ polyline: '119,34;119.1,34.1' }] }] } };
  const f = fakeFetch((u) => (u.pathname === '/v3/direction/driving' ? { status: '0', infocode: '10009' } : v5));
  const res = await handleApiRequest(req('/api/route?origin=119,34&destination=118.7,32'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).routes.length, 1);
  const bad = fakeFetch(() => ({ status: '0', infocode: '20800' }));
  assert.equal((await handleApiRequest(req('/api/route?origin=119,34&destination=118.7,32'), env, { fetchImpl: bad })).status, 422);
});

test('/api/route 公交：出發時間 → date／time（UTC+8）', async () => {
  const f = fakeFetch((u) => (u.pathname === '/v3/geocode/regeo'
    ? { status: '1', infocode: '10000', regeocode: { addressComponent: { citycode: '0518', adcode: '320700' } } }
    : { infocode: '10000', route: { transits: [] } }));
  const at = Math.floor(Date.now() / 1000) + 3600;
  await handleApiRequest(req(`/api/route?mode=transit&origin=119,34&destination=118.7,32&city1=0518&city2=025&depart=${at}`), env, { fetchImpl: f });
  const t = f.calls.find((u) => u.pathname === '/v5/direction/transit/integrated');
  assert.match(t.searchParams.get('date'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(t.searchParams.get('time'), /^\d{2}:\d{2}$/);
});
