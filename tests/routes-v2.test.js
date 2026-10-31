import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, attachRailLines } from '../core/handlers.js';
import { validateRoute, validateNearby } from '../core/validate.js';
import { mapTransitResponse, mapPathRouteResponse, parseSpaceLocation } from '../core/mapping.js';
import { fakeFetch, req, FAKE_KEY } from './helpers.js';

const env = { AMAP_KEY: FAKE_KEY };
const P = (q) => new URLSearchParams(q);
const O = '119.2163,34.5983';
const D = '118.7969,32.0903';

// ───────── 驗證 ─────────
test('validateRoute：mode、城市碼、策略依模式驗證', () => {
  assert.equal(validateRoute(P(`origin=${O}&destination=${D}`)).mode, 'driving');
  assert.equal(validateRoute(P(`origin=${O}&destination=${D}&mode=walking`)).mode, 'walking');
  assert.throws(() => validateRoute(P(`origin=${O}&destination=${D}&mode=teleport`)), /mode/);
  assert.throws(() => validateRoute(P(`origin=${O}&destination=${D}&mode=transit&city1=abc`)), /city1/);
  assert.equal(validateRoute(P(`origin=${O}&destination=${D}&mode=transit&city1=0518&city2=320100&strategy=fastest`)).strategy, 'fastest');
  assert.throws(() => validateRoute(P(`origin=${O}&destination=${D}&mode=transit&strategy=avoid_tolls`)), /strategy/);
  assert.throws(() => validateRoute(P(`origin=${O}&destination=${D}&mode=walking&waypoints=119.1,34.1`)), /途經/);
});

test('validateNearby：種類、半徑、數量', () => {
  assert.deepEqual(validateNearby(P(`kind=gas&location=${O}`)), { kind: 'gas', location: O, radius: 3000, limit: 25 });
  assert.throws(() => validateNearby(P(`location=${O}`)), /kind/);
  assert.throws(() => validateNearby(P(`kind=bank&location=${O}`)), /kind/);
  assert.throws(() => validateNearby(P(`kind=ev&location=${O}&radius=999999`)), /radius/);
  assert.throws(() => validateNearby(P('kind=ev')), /location/);
});

// ───────── 附近搜尋 ─────────
test('nearby：toilet/gas/ev 對應 200300/010100/011100，依距離排序，回應不含 key', async () => {
  for (const [kind, type] of [['toilet', '200300'], ['gas', '010100'], ['ev', '011100']]) {
    const f = fakeFetch(() => ({ infocode: '10000', count: '2', pois: [{ id: 'B1', name: '站', location: '119.21,34.60', distance: '120', type: 'x' }] }));
    const res = await handleApiRequest(req(`/api/nearby?kind=${kind}&location=${O}&radius=2000&limit=10&key=evil`), env, { fetchImpl: f });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(FAKE_KEY));
    const body = JSON.parse(text);
    assert.equal(body.kind, kind);
    assert.equal(body.results[0].nearbyKind, kind);
    assert.equal(body.results[0].distance, 120);
    const u = f.calls[0].url;
    assert.equal(u.pathname, '/v5/place/around');
    assert.equal(u.searchParams.get('types'), type);
    assert.equal(u.searchParams.get('radius'), '2000');
    assert.equal(u.searchParams.get('page_size'), '10');
    assert.equal(u.searchParams.get('sortrule'), 'distance');
    assert.equal(u.searchParams.get('key'), FAKE_KEY);
    assert.equal(u.searchParams.getAll('key').length, 1);
  }
  assert.equal((await handleApiRequest(req(`/api/nearby?kind=bank&location=${O}`), env, { fetchImpl: fakeFetch(() => ({})) })).status, 400);
});

// ───────── 步行／騎行／電動車 ─────────
const pathFixture = (withTopDuration) => ({
  infocode: '10000',
  route: {
    paths: [
      {
        distance: '1200',
        ...(withTopDuration ? { duration: '300' } : {}),
        steps: [
          { instruction: '沿海連路向東步行100米', road_name: '海連路', step_distance: '100', cost: { duration: '70' }, polyline: '119.1,34.1;119.2,34.2' },
          { instruction: '右轉', road_name: '', step_distance: '1100', cost: { duration: '800' }, polyline: '119.2,34.2;119.3,34.3' },
        ],
      },
    ],
  },
});

test('walking / bicycling / electrobike：各自的上游端點，路線整理正確', async () => {
  for (const mode of ['walking', 'bicycling', 'electrobike']) {
    const f = fakeFetch(() => pathFixture(mode !== 'walking'));
    const res = await handleApiRequest(req(`/api/route?mode=${mode}&origin=${O}&destination=${D}`), env, { fetchImpl: f });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mode, mode);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url.pathname, `/v5/direction/${mode}`);
    assert.equal(f.calls[0].url.searchParams.get('show_fields'), 'cost,polyline');
    const r = body.routes[0];
    assert.equal(r.distance, 1200);
    assert.equal(r.duration, mode === 'walking' ? 870 : 300); // 步行：各步驟加總；其他：路徑層 duration
    assert.equal(r.steps.length, 2);
    assert.deepEqual(r.polyline, [[119.1, 34.1], [119.2, 34.2], [119.3, 34.3]]); // 接點去重
  }
});

test('駕車仍可用且回應多了 mode 欄位', async () => {
  const f = fakeFetch(() => ({ infocode: '10000', route: { paths: [{ distance: '10', steps: [] }] } }));
  const res = await handleApiRequest(req(`/api/route?origin=${O}&destination=${D}`), env, { fetchImpl: f });
  assert.equal((await res.json()).mode, 'driving');
  assert.equal(f.calls[0].url.pathname, '/v5/direction/driving');
});

// ───────── 公交／火車 ─────────
const stop = (name, location, time, extra = {}) => ({ name, id: `ID${name}`, location, time, ...extra });
const transitFixture = {
  infocode: '10000',
  route: {
    transits: [
      {
        distance: '300000',
        walking_distance: '900',
        cost: { duration: '9000', transit_fee: '120' },
        segments: [
          { walking: { distance: '500', cost: { duration: '400' }, steps: [{ instruction: '步行到連雲港站', road: '某路', distance: '500', polyline: { polyline: '119.20,34.60;119.21,34.61' } }] } },
          {
            railway: {
              trip: 'D5433',
              name: '連雲港-南京',
              type: '動車',
              time: '8000',
              distance: '290000',
              departure_stop: stop('連雲港', '119.2300 34.6100', '0739'),
              arrival_stop: stop('南京', '118.7900 32.0900', '0950'),
              via_stops: [stop('漣水', '119.2600 33.7800', '0821', { wait: '2' }), stop('淮安東', '119.1500 33.4800', '0840', { wait: '2' })],
              spaces: [{ code: '二等座', cost: '120.5' }, { code: '一等座', cost: '190' }, { code: '二等座', cost: '130' }],
              alters: [{ name: 'D3195' }, { name: 'G1' }],
            },
          },
          { bus: { buslines: [{ name: '地铁1号线(A--B)', type: '地铁线路', distance: '8000', cost: { duration: '900' }, departure_stop: stop('甲', '118.80,32.10'), arrival_stop: stop('乙', '118.78,32.08'), via_stops: [stop('丙', '118.79,32.09')], start_time: '0600', end_time: '2230', polyline: { polyline: '118.80,32.10;118.78,32.08' } }] } },
          { bus: { buslines: [{ name: '5路(X--Y)', type: '普通公交线路', distance: '3000', cost: { duration: '600' }, departure_stop: stop('X', '118.78,32.08'), arrival_stop: stop('Y', '118.77,32.07'), via_stops: [], polyline: '118.78,32.08;118.77,32.07' }] } },
          {},
        ],
      },
    ],
  },
};

test('parseSpaceLocation：鐵路站座標以空白分隔', () => {
  assert.deepEqual(parseSpaceLocation('119.23 34.61'), { lng: 119.23, lat: 34.61 });
  assert.equal(parseSpaceLocation('abc'), null);
});

test('mapTransitResponse：步行／地鐵／公車／火車分段，via_stops 與票價', () => {
  const r = mapTransitResponse(transitFixture).routes[0];
  assert.equal(r.fee, 120);
  assert.equal(r.duration, 9000);
  assert.deepEqual(r.segments.map((s) => s.type), ['walk', 'train', 'subway', 'bus']);
  const t = r.segments[1];
  assert.equal(t.trip, 'D5433');
  assert.deepEqual(t.stops.map((s) => `${s.role}:${s.name}:${s.time}`), ['dep:連雲港:07:39', 'via:漣水:08:21', 'via:淮安東:08:40', 'arr:南京:09:50']);
  assert.equal(t.stops[1].lng, 119.26);
  assert.deepEqual(t.prices, { 二等座: 120.5, 一等座: 190 }); // 取各席別最低價
  assert.deepEqual(t.alters, ['D3195', 'G1']);
  assert.equal(r.segments[2].viaStops[0].name, '丙');
  assert.equal(r.segments[2].startTime, '06:00');
});

test('transit：沒帶 city1/city2 時用逆地理編碼補，並要求 extensions=all 與 polyline', async () => {
  const f = fakeFetch((u) => {
    if (u.pathname === '/v3/geocode/regeo') {
      const loc = u.searchParams.get('location');
      return { status: '1', infocode: '10000', regeocode: { addressComponent: { citycode: loc === O ? '0518' : '025', adcode: '999999' } } };
    }
    return transitFixture;
  });
  const res = await handleApiRequest(req(`/api/route?mode=transit&origin=${O}&destination=${D}&strategy=least_transfer`), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const t = f.calls.find((c) => c.url.pathname === '/v5/direction/transit/integrated').url;
  assert.equal(t.searchParams.get('city1'), '0518');
  assert.equal(t.searchParams.get('city2'), '025');
  assert.equal(t.searchParams.get('extensions'), 'all');
  assert.equal(t.searchParams.get('show_fields'), 'cost,polyline');
  assert.equal(t.searchParams.get('strategy'), '2');
  const body = await res.json();
  const train = body.routes[0].segments.find((s) => s.type === 'train');
  assert.equal(train.lineMatch.estimated, true); // 一律標示為推測
  assert.ok(body.routes[0].polyline.length > 3);
  assert.ok(!JSON.stringify(body).includes(FAKE_KEY));
});

test('transit：帶了 city1/city2 就不呼叫逆地理編碼', async () => {
  const f = fakeFetch(() => transitFixture);
  await handleApiRequest(req(`/api/route?mode=transit&origin=${O}&destination=${D}&city1=0518&city2=025`), env, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test('transit：上游沒有路線（空結果）→ routes 為空陣列而非錯誤', async () => {
  const f = fakeFetch(() => ({ infocode: '10000', route: { transits: [] } }));
  const body = await (await handleApiRequest(req(`/api/route?mode=transit&origin=${O}&destination=${D}&city1=0518&city2=025`), env, { fetchImpl: f })).json();
  assert.deepEqual(body.routes, []);
});

test('transit：上游 208xx → 422 no_route', async () => {
  const f = fakeFetch(() => ({ infocode: '20800', info: 'x' }));
  const res = await handleApiRequest(req(`/api/route?mode=transit&origin=${O}&destination=${D}&city1=0518&city2=025`), env, { fetchImpl: f });
  assert.equal(res.status, 422);
});

test('attachRailLines：配不到線路時退回「停靠站直線連接」，並標示 unmatched', () => {
  const route = {
    segments: [{ type: 'train', trip: 'G1', stops: [{ name: '甲', lng: 1, lat: 1 }, { name: '乙', lng: 2, lat: 2 }], polyline: [] }],
    polyline: [],
  };
  const matcher = { matchRoute: (stops) => ({ estimated: true, unmatched: true, sections: [{ line: null, path: stops.map((s) => [s.lng, s.lat]) }] }) };
  attachRailLines(route, matcher);
  assert.deepEqual(route.polyline, [[1, 1], [2, 2]]);
  assert.equal(route.segments[0].lineMatch.unmatched, true);
});

test('mapPathRouteResponse：沒有路徑時回空陣列', () => {
  assert.deepEqual(mapPathRouteResponse({ route: {} }, 'walking'), { mode: 'walking', routes: [] });
});
