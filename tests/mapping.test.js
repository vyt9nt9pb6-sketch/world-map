import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapSearchResponse, mapGeocodeResponse, mapRouteResponse, decodePolyline, parseLocation } from '../core/mapping.js';

test('parseLocation / decodePolyline', () => {
  assert.deepEqual(parseLocation('119.2,34.6'), { lng: 119.2, lat: 34.6 });
  assert.equal(parseLocation([]), null);
  assert.equal(parseLocation('bad'), null);
  assert.deepEqual(decodePolyline('1,2;3,4;bad;5,6'), [[1, 2], [3, 4], [5, 6]]);
});

test('mapSearchResponse：v5 POI', () => {
  const raw = {
    count: '2',
    infocode: '10000',
    pois: [
      { id: 'B0FFM4MUB6', name: '中国石化学院路加油站', address: '学院路', location: '119.225393,34.600460', type: '汽车服务;加油站;中国石化', pname: '江苏省', cityname: '连云港市', adname: '海州区', adcode: '320706', distance: '1165', business: { tel: '0518-1' } },
      { id: 'X', name: '無座標', location: '' },
      { id: 'Y', name: '空地址', address: [], location: '119,34' },
    ],
  };
  const m = mapSearchResponse(raw, 'around');
  assert.equal(m.source, 'around');
  assert.equal(m.results.length, 2);
  assert.deepEqual(m.results[0], {
    kind: 'poi', id: 'B0FFM4MUB6', name: '中国石化学院路加油站', address: '学院路', type: '汽车服务;加油站;中国石化',
    province: '江苏省', city: '连云港市', district: '海州区', adcode: '320706', distance: 1165, tel: '0518-1', lng: 119.225393, lat: 34.60046,
  });
  assert.equal(m.results[1].address, '');
  assert.equal(m.results[1].distance, null);
  assert.deepEqual(mapSearchResponse({}, 'text').results, []);
});

test('mapGeocodeResponse：v3 地理編碼', () => {
  const m = mapGeocodeResponse({ geocodes: [{ formatted_address: '江苏省连云港市连云区', province: '江苏省', city: '连云港市', district: '连云区', adcode: '320703', location: '119.338901,34.760317', level: '区县', street: [] }] });
  assert.equal(m.results[0].kind, 'address');
  assert.equal(m.results[0].name, '江苏省连云港市连云区');
  assert.equal(m.results[0].lat, 34.760317);
  assert.equal(m.results[0].level, '区县');
});

test('mapRouteResponse：距離、時間、過路費、合併 polyline', () => {
  const raw = {
    route: {
      taxi_cost: '797',
      paths: [
        {
          distance: '321714', restriction: '0',
          cost: { duration: '12271', tolls: '151', toll_distance: '284471', traffic_lights: '17' },
          steps: [
            { instruction: 'a', road_name: 'G15', step_distance: '10', cost: { duration: '5' }, polyline: '1,1;2,2' },
            { instruction: 'b', road_name: 'G15', step_distance: '20', cost: { duration: '6' }, polyline: '2,2;3,3' },
            { instruction: 'c', road_name: [], step_distance: '5', polyline: '3,3;4,4' },
          ],
        },
        { distance: '313162', restriction: '1', cost: { duration: '21257', tolls: '0' }, steps: [] },
      ],
    },
  };
  const m = mapRouteResponse(raw, 'recommend');
  assert.equal(m.taxiCost, 797);
  assert.equal(m.routes.length, 2);
  const r = m.routes[0];
  assert.equal(r.distance, 321714);
  assert.equal(r.duration, 12271);
  assert.equal(r.tolls, 151);
  assert.equal(r.tollDistance, 284471);
  assert.equal(r.trafficLights, 17);
  assert.equal(r.restriction, false);
  assert.deepEqual(r.roads, ['G15']);
  assert.deepEqual(r.polyline, [[1, 1], [2, 2], [3, 3], [4, 4]]); // 重複點已去除
  assert.equal(r.steps.length, 3);
  assert.equal(m.routes[1].restriction, true);
  assert.equal(m.routes[1].tolls, 0);
  assert.equal(m.routes[1].tollDistance, null);
  assert.deepEqual(mapRouteResponse({}, 'x').routes, []);
});
