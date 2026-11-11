import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, rankRailFirst, trainDistance } from '../core/handlers.js';
import { validateRegeo, validateEnvironment, validateRoute } from '../core/validate.js';
import { mapRegeoResponse } from '../core/mapping.js';
import { fakeFetch, req, FAKE_KEY } from './helpers.js';

const env = { AMAP_KEY: FAKE_KEY };
const P = (q) => new URLSearchParams(q);
const PT = { lng: 119.2, lat: 34.6 };

// ───────── 驗證 ─────────
test('validateRegeo：location 必填、radius 10–300', () => {
  assert.deepEqual(validateRegeo(P('location=119.2,34.6')), { location: '119.2,34.6', radius: 50 });
  assert.equal(validateRegeo(P('location=119.2,34.6&radius=120')).radius, 120);
  assert.throws(() => validateRegeo(P('radius=50')), /location/);
  assert.throws(() => validateRegeo(P('location=119.2,34.6&radius=5000')), /radius/);
});

test('validateEnvironment：只收數字座標並四捨五入到 0.01°', () => {
  assert.deepEqual(validateEnvironment(P('lat=34.60123&lng=119.2234')), { lat: 34.6, lng: 119.22 });
  assert.throws(() => validateEnvironment(P('lat=abc&lng=1')), /lat/);
  assert.throws(() => validateEnvironment(P('lat=95&lng=1')), /lat/);
  assert.throws(() => validateEnvironment(P('lat=1')), /lng/);
});

test('validateRoute：transit 支援 rail_first，其他模式不支援', () => {
  const q = 'origin=119.2,34.6&destination=118.8,32.1&mode=transit&city1=0518&city2=025&strategy=rail_first';
  assert.equal(validateRoute(P(q)).strategy, 'rail_first');
});

// ───────── 逆地理編碼 → 點選地點 ─────────
const regeoBody = (over = {}) => ({
  status: '1',
  infocode: '10000',
  regeocode: {
    formatted_address: '江蘇省連雲港市海州區某路1號',
    addressComponent: { province: '江蘇省', city: [], district: '海州區', adcode: '320706', citycode: '0518', township: '某街道', streetNumber: { street: '某路', number: '1號' } },
    pois: [
      { id: 'B0FFAAAA11', name: '遠一點的店', distance: '80', location: '119.2005,34.6005', address: '某路2號', type: '餐飲' },
      { id: 'B0FFBBBB22', name: '近的公園', distance: '12', location: '119.2001,34.6001', address: '某路', type: '風景名勝', tel: '0518-1' },
    ],
    aois: [{ id: 'B0AOI', name: '某社區', location: '119.201,34.601', type: '住宅' }],
    roads: [{ name: '某路', distance: '8' }],
    ...over,
  },
});

test('mapRegeoResponse：半徑內最近 POI 優先', () => {
  const r = mapRegeoResponse(regeoBody(), PT, 100);
  assert.equal(r.kind, 'poi');
  assert.equal(r.name, '近的公園');
  assert.equal(r.id, 'B0FFBBBB22');
  assert.equal(r.distance, 12);
  assert.deepEqual(r.tapped, PT);
  assert.equal(r.citycode, '0518');
});

test('mapRegeoResponse：POI 都超出半徑 → 用 AOI；沒有 AOI → 門牌地址', () => {
  const far = regeoBody();
  assert.equal(mapRegeoResponse(far, PT, 5).kind, 'aoi');
  assert.equal(mapRegeoResponse(far, PT, 5).name, '某社區');
  const noAoi = regeoBody({ aois: [] });
  const a = mapRegeoResponse(noAoi, PT, 5);
  assert.equal(a.kind, 'address');
  assert.equal(a.name, '某路1號');
  assert.equal(a.lng, PT.lng);
  const empty = mapRegeoResponse({ regeocode: { formatted_address: [], addressComponent: {} } }, PT, 50);
  assert.equal(empty.name, '選取的位置');
});

test('/api/regeo：金鑰只在上游請求、回應不含金鑰；回傳 POI', async () => {
  const f = fakeFetch(() => regeoBody());
  const res = await handleApiRequest(req('/api/regeo?location=119.2,34.6&radius=60'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes(FAKE_KEY));
  assert.equal(JSON.parse(text).name, '近的公園');
  assert.equal(f.calls[0].url.pathname, '/v3/geocode/regeo');
  assert.equal(f.calls[0].url.searchParams.get('extensions'), 'all');
  assert.equal(f.calls[0].url.searchParams.get('key'), FAKE_KEY);
});

// ───────── 海拔／氣壓 ─────────
const omBody = { elevation: 4.0, current: { time: '2026-10-31T11:00', surface_pressure: 1018.6, pressure_msl: 1019.1, temperature_2m: 16.7 } };

test('/api/environment：由伺服器代呼 Open-Meteo，回傳帶 source 與 estimate 的值，不帶金鑰', async () => {
  const f = fakeFetch(() => omBody);
  const res = await handleApiRequest(req('/api/environment?lat=34.60&lng=119.22'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=300/);
  const b = await res.json();
  assert.equal(b.estimate, true);
  assert.equal(b.elevation.value, 4);
  assert.equal(b.elevation.source, 'api');
  assert.equal(b.pressure.surface, 1018.6);
  assert.equal(b.pressure.seaLevel, 1019.1);
  assert.equal(b.pressure.source, 'api');
  assert.equal(b.pressure.time, '2026-10-31T11:00:00Z');
  assert.match(b.attribution, /Open-Meteo/);
  const u = f.calls[0].url;
  assert.equal(u.host, 'api.open-meteo.com');
  assert.equal(u.searchParams.get('latitude'), '34.6');
  assert.ok(!u.search.includes(FAKE_KEY));
  assert.equal(f.calls[0].init?.headers?.cookie, undefined);
});

test('/api/environment：缺資料時對應欄位為 null；上游錯誤 → 502', async () => {
  const f = fakeFetch(() => ({ elevation: null, current: {} }));
  const b = await (await handleApiRequest(req('/api/environment?lat=1&lng=2'), env, { fetchImpl: f })).json();
  assert.equal(b.elevation, null);
  assert.equal(b.pressure, null);
  const bad = async () => new Response('x', { status: 500 });
  const res = await handleApiRequest(req('/api/environment?lat=1&lng=2'), env, { fetchImpl: bad });
  assert.equal(res.status, 502);
  const bad2 = await handleApiRequest(req('/api/environment?lat=zzz&lng=2'), env, { fetchImpl: bad });
  assert.equal(bad2.status, 400);
});

// ───────── 鐵路線資料 ─────────
test('/api/rail-lines：回傳線路與 ODbL 出處、可快取', async () => {
  const res = await handleApiRequest(req('/api/rail-lines'), env, {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=86400/);
  const b = await res.json();
  assert.ok(b.lines.length > 100);
  assert.match(String(b.attribution), /OpenStreetMap/i);
  assert.ok(Array.isArray(b.lines[0].stations[0]));
});

// ───────── 鐵路優先 ─────────
const seg = (type, distance, extra = {}) => ({ type, distance, from: { name: extra.f || 'A' }, to: { name: extra.t || 'B' }, trip: extra.trip, name: extra.name, polyline: [] });
const route = (duration, distance, segments) => ({ index: 0, duration, distance, segments, polyline: [] });

test('rankRailFirst：含火車的排前面、火車比例高者優先、去重', () => {
  const bus = route(3000, 100000, [seg('walk', 500), seg('bus', 99000, { name: '長途車' })]);
  const slowTrain = route(9000, 100000, [seg('walk', 500), seg('train', 60000, { trip: 'G1' })]);
  const mostlyTrain = route(10000, 100000, [seg('train', 95000, { trip: 'G2' })]);
  const dup = route(9100, 100000, [seg('walk', 500), seg('train', 60000, { trip: 'G1' })]);
  const out = rankRailFirst([bus, slowTrain, dup, mostlyTrain]);
  assert.equal(out.length, 3);
  assert.equal(out[0].segments[0].trip, 'G2');
  assert.equal(out[1].segments[1].trip, 'G1');
  assert.equal(trainDistance(out[2]), 0);
  assert.deepEqual(out.map((r) => r.index), [0, 1, 2]);
});

test('/api/route transit rail_first：三種策略各查一次、結果含火車者在前、回報 hasTrain', async () => {
  const transit = (railway) => ({
    status: '1',
    infocode: '10000',
    route: {
      transits: [
        {
          distance: '100000',
          cost: { duration: '5000', transit_fee: '10' },
          segments: railway
            ? [{ railway: { trip: 'G1', name: '高鐵G1', type: '高速', distance: '95000', time: '3000', departure_stop: { name: '甲站', location: '119.1,34.5' }, arrival_stop: { name: '乙站', location: '118.8,32.1' }, via_stops: [], spaces: [] } }]
            : [{ bus: { buslines: [{ name: '長途車', type: '跨城公交', distance: '99000', cost: { duration: '4000' }, departure_stop: { name: 'a', location: '119.1,34.5' }, arrival_stop: { name: 'b', location: '118.8,32.1' }, via_stops: [] }] } }],
        },
      ],
    },
  });
  const f = fakeFetch((u) => {
    if (u.pathname === '/v3/geocode/regeo') return { status: '1', infocode: '10000', regeocode: { addressComponent: { citycode: '0518' } } };
    return transit(u.searchParams.get('strategy') === '8');
  });
  const res = await handleApiRequest(req('/api/route?origin=119.2,34.6&destination=118.8,32.1&mode=transit&strategy=rail_first&city1=0518&city2=025'), env, { fetchImpl: f });
  assert.equal(res.status, 200);
  const b = await res.json();
  const up = f.calls.filter((c) => c.url.pathname.includes('transit'));
  assert.deepEqual(up.map((c) => c.url.searchParams.get('strategy')).sort(), ['0', '2', '8']);
  assert.equal(b.railFirst, true);
  assert.equal(b.hasTrain, true);
  assert.equal(b.routes[0].segments[0].type, 'train');
  assert.ok(b.routes.length >= 2);
});
