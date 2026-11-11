import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLngLat, validateSearch, validateGeocode, validateRoute, ValidationError } from '../core/validate.js';

const P = (o) => new URLSearchParams(o);

test('parseLngLat：正常值會四捨五入到 6 位小數', () => {
  assert.equal(parseLngLat('119.12345678,34.5'), '119.123457,34.5');
  assert.equal(parseLngLat(' -73.1 , 40.2 '), '-73.1,40.2');
});

test('parseLngLat：拒絕格式錯誤／超出範圍／注入', () => {
  for (const bad of ['abc', '119', '119,34,1', '200,30', '119,95', '119,34&key=x', '119;34', '1e3,30', '', '0x10,20']) {
    assert.throws(() => parseLngLat(bad), ValidationError, bad);
  }
});

test('validateSearch：必填 q、長度限制、去除控制字元', () => {
  assert.throws(() => validateSearch(P({})), /缺少參數 q/);
  assert.throws(() => validateSearch(P({ q: '   ' })), ValidationError);
  assert.throws(() => validateSearch(P({ q: '加'.repeat(81) })), /太長/);
  const v = validateSearch(P({ q: ' 加油站\n\t ', location: '119.3,34.7', page: '2' }));
  assert.deepEqual(v, { keywords: '加油站', location: '119.3,34.7', city: undefined, page: 2, area: false, radius: 50000 });
  assert.throws(() => validateSearch(P({ q: 'a', page: '0' })), ValidationError);
  assert.throws(() => validateSearch(P({ q: 'a', page: '11' })), ValidationError);
  assert.throws(() => validateSearch(P({ q: 'a', page: '-1' })), ValidationError);
});

test('validateSearch：不在白名單的參數不會被帶出去', () => {
  const v = validateSearch(P({ q: 'a', key: 'evil', output: 'xml', callback: 'x' }));
  assert.deepEqual(Object.keys(v).sort(), ['area', 'city', 'keywords', 'location', 'page', 'radius']);
});

test('validateGeocode', () => {
  assert.throws(() => validateGeocode(P({})), ValidationError);
  assert.equal(validateGeocode(P({ address: '江蘇省連雲港市連雲區' })).address, '江蘇省連雲港市連雲區');
});

test('validateRoute：起終點、途經點、策略', () => {
  const v = validateRoute(P({ origin: '119.22,34.59', destination: '118.79,32.06', waypoints: '119,33;118.9,32.5', strategy: 'avoid_tolls', destination_id: 'B0FFM4MUB6' }));
  assert.deepEqual(v.waypoints, ['119,33', '118.9,32.5']);
  assert.equal(v.strategy, 'avoid_tolls');
  assert.equal(v.destinationId, 'B0FFM4MUB6');
  assert.equal(validateRoute(P({ origin: '1,1', destination: '2,2' })).strategy, 'recommend');
  assert.throws(() => validateRoute(P({ destination: '2,2' })), /origin/);
  assert.throws(() => validateRoute(P({ origin: '1,1', destination: '1,1' })), /相同/);
  assert.throws(() => validateRoute(P({ origin: '1,1', destination: '2,2', strategy: '32' })), /strategy/);
  assert.throws(() => validateRoute(P({ origin: '1,1', destination: '2,2', strategy: '__proto__' })), /strategy/);
  assert.throws(() => validateRoute(P({ origin: '1,1', destination: '2,2', waypoints: Array(17).fill('1,2').join(';') })), /最多/);
  assert.throws(() => validateRoute(P({ origin: '1,1', destination: '2,2', origin_id: 'B0&key=1' })), /origin_id/);
});
