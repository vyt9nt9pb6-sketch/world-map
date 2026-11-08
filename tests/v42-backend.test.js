// v4.2 後端測試：/api/weather（Open-Meteo 代理）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApiRequest, mapWeatherResponse } from '../core/handlers.js';

const req = (path) => new Request(`https://x.test${path}`, { headers: { origin: 'https://x.test' } });

/** 模擬 Open-Meteo 的 forecast 回應 */
function openMeteoBody() {
  return {
    latitude: 34.6,
    longitude: 119.2,
    timezone: 'Asia/Shanghai',
    current: {
      time: '2026-11-07T11:00',
      temperature_2m: 12.3,
      apparent_temperature: 10.1,
      relative_humidity_2m: 62,
      precipitation: 0,
      weather_code: 2,
      wind_speed_10m: 12.4,
    },
    hourly: {
      time: ['2026-11-07T11:00', '2026-11-07T12:00', '2026-11-07T13:00'],
      temperature_2m: [12, 13, 14],
      weather_code: [2, 61, 3],
      precipitation_probability: [10, 40, 65],
    },
    daily: {
      time: ['2026-11-07', '2026-11-08', '2026-11-09'],
      weather_code: [2, 61, 0],
      temperature_2m_max: [15, 12, 16],
      temperature_2m_min: [4, 2, 3],
      precipitation_probability_max: [10, 80, 0],
      precipitation_sum: [0, 6.2, 0],
    },
  };
}

test('handleWeather：精簡回應（current＋daily＋hourly）、10 分鐘公開快取', async () => {
  const res = await handleApiRequest(req('/api/weather?lat=34.60&lng=119.22'), {}, {
    fetchImpl: async (url) => {
      const u = new URL(url);
      assert.equal(u.hostname, 'api.open-meteo.com');
      assert.equal(u.searchParams.get('forecast_days'), '7');
      assert.equal(u.searchParams.get('forecast_hours'), '48');
      assert.ok(u.searchParams.get('hourly').includes('precipitation_probability'));
      return new Response(JSON.stringify(openMeteoBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=600');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  const b = await res.json();
  assert.equal(b.attribution, 'Weather data by Open-Meteo.com (CC BY 4.0)');
  assert.equal(b.timezone, 'Asia/Shanghai');
  assert.equal(b.current.temperature, 12.3);
  assert.equal(b.current.code, 2);
  assert.equal(b.current.wind, 12.4);
  assert.equal(b.daily.length, 3);
  assert.equal(b.daily[1].tMax, 12);
  assert.equal(b.daily[1].tMin, 2);
  assert.equal(b.daily[1].precipProb, 80);
  assert.equal(b.hourly.length, 3);
  assert.equal(b.hourly[1].code, 61);
  assert.equal(b.hourly[2].precipProb, 65);
});

test('handleWeather：不需要 AMAP_KEY（Open-Meteo 免金鑰）；回應不含金鑰字樣', async () => {
  const res = await handleApiRequest(req('/api/weather?lat=0&lng=0'), {}, {
    fetchImpl: async () => new Response(JSON.stringify(openMeteoBody()), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes('TESTKEY') && !text.toLowerCase().includes('amap_key'));
});

test('handleWeather：座標四捨五入到 0.01°（提高上游快取命中）；無效參數 → 400', async () => {
  let seen;
  const res = await handleApiRequest(req('/api/weather?lat=34.599999&lng=119.221111'), {}, {
    fetchImpl: async (url) => {
      seen = new URL(url);
      return new Response(JSON.stringify(openMeteoBody()), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(res.status, 200);
  assert.equal(seen.searchParams.get('latitude'), '34.6');
  assert.equal(seen.searchParams.get('longitude'), '119.22');

  for (const bad of ['/api/weather', '/api/weather?lat=999&lng=0', '/api/weather?lat=x&lng=0', '/api/weather?lat=34&lng=181']) {
    const r = await handleApiRequest(req(bad), {}, { fetchImpl: async () => { throw new Error('不應呼叫上游'); } });
    assert.equal(r.status, 400, bad);
    const b = await r.json();
    assert.ok(b.error.field, '回應標示出錯的欄位');
  }
});

test('handleWeather：上游逾時 → 504；429 → 429；格式錯誤 → 502；空資料 → 502', async () => {
  const timeout = async () => Promise.reject(new Error('timeout'));
  let r = await handleApiRequest(req('/api/weather?lat=1&lng=1'), {}, { fetchImpl: timeout });
  assert.equal(r.status, 504);
  r = await handleApiRequest(req('/api/weather?lat=1&lng=1'), {}, {
    fetchImpl: async () => new Response('rate limited', { status: 429 }),
  });
  assert.equal(r.status, 429);
  r = await handleApiRequest(req('/api/weather?lat=1&lng=1'), {}, {
    fetchImpl: async () => new Response('not json', { status: 200 }),
  });
  assert.equal(r.status, 502);
  r = await handleApiRequest(req('/api/weather?lat=1&lng=1'), {}, {
    fetchImpl: async () => new Response(JSON.stringify({ timezone: 'x' }), { status: 200 }),
  });
  assert.equal(r.status, 502, '沒有 current 也沒有 daily → 視為格式錯誤');
});

test('handleWeather：只接受 GET（POST → 405）', async () => {
  const r = await handleApiRequest(new Request('https://x.test/api/weather?lat=1&lng=1', { method: 'POST', headers: { origin: 'https://x.test' } }), {}, {});
  assert.equal(r.status, 405);
  assert.ok((r.headers.get('allow') || '').includes('GET'));
});

test('mapWeatherResponse：非有限數/null 欄位一律清成 null，不丟例外', () => {
  const out = mapWeatherResponse({
    current: { time: 't', temperature_2m: 'NaN-ish', weather_code: null, wind_speed_10m: 3 },
    daily: { time: ['2026-11-07'], weather_code: [null], temperature_2m_max: [NaN], temperature_2m_min: [1], precipitation_probability_max: [undefined], precipitation_sum: [0.5] },
    hourly: { time: 'not-array' },
  });
  assert.equal(out.current.temperature, null);
  assert.equal(out.current.code, null);
  assert.equal(out.current.wind, 3);
  assert.deepEqual(out.daily, [{ date: '2026-11-07', code: null, tMax: null, tMin: 1, precipProb: null, precipSum: 0.5 }]);
  assert.deepEqual(out.hourly, []);
});
