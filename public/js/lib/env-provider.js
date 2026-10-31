// 海拔／氣壓的「提供者」介面。
//
// 為什麼這樣設計：網頁（iPhone Safari）讀不到手機的氣壓計；目前的值來自 GPS 或氣象 API 的「估計」。
// 之後做原生 App（CMAltimeter / Android Sensor.TYPE_PRESSURE）時，只要在 WebView 或原生層註冊一個
// source:'sensor' 的提供者，介面、UI 與其他程式碼都不用改。
//
// Provider 形狀：
//   { source: 'sensor' | 'gps' | 'api',
//     getAltitude?(ctx) → Promise<{ value, accuracy?, label?, time? } | null>,   // 公尺
//     getPressure?(ctx) → Promise<{ value, seaLevel?, accuracy?, label?, time? } | null> } // hPa（站點氣壓）
// ctx = { position?: { lat, lng, altitude, altitudeAccuracy }, signal? }（lat/lng 為 WGS-84）
//
// 回傳（統一格式）：
//   { kind: 'altitude' | 'pressure', value, unit: 'm' | 'hPa', source, estimate: boolean, label, accuracy?, seaLevel?, time }
// 優先順序：sensor > gps > api。前一個沒有值或丟錯，就用下一個。只有 sensor 的 estimate 為 false。

export const SOURCE_ORDER = ['sensor', 'gps', 'api'];

export const SOURCE_NAMES = {
  sensor: '裝置氣壓計',
  gps: 'GPS 定位',
  api: '氣象資料（Open-Meteo）',
};

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

export function createEnvService({ now = Date.now } = {}) {
  const providers = new Map();

  function registerProvider(p) {
    if (!p || !SOURCE_ORDER.includes(p.source)) throw new Error(`provider.source 必須是 ${SOURCE_ORDER.join(' | ')}`);
    providers.set(p.source, p);
    return () => {
      if (providers.get(p.source) === p) providers.delete(p.source);
    };
  }

  async function resolve(kind, method, unit, ctx) {
    for (const source of SOURCE_ORDER) {
      const p = providers.get(source);
      if (!p || typeof p[method] !== 'function') continue;
      let r;
      try {
        r = await p[method](ctx);
      } catch {
        continue;
      }
      if (!r || !finite(r.value)) continue;
      return {
        kind,
        value: r.value,
        unit,
        source,
        estimate: source !== 'sensor',
        label: r.label || SOURCE_NAMES[source],
        ...(finite(r.accuracy) ? { accuracy: r.accuracy } : {}),
        ...(finite(r.seaLevel) ? { seaLevel: r.seaLevel } : {}),
        time: r.time ?? new Date(now()).toISOString(),
      };
    }
    return null;
  }

  return {
    registerProvider,
    sources: () => SOURCE_ORDER.filter((s) => providers.has(s)),
    getAltitude: (ctx = {}) => resolve('altitude', 'getAltitude', 'm', ctx),
    getPressure: (ctx = {}) => resolve('pressure', 'getPressure', 'hPa', ctx),
  };
}

/** 內建：GPS 海拔（瀏覽器 coords.altitude；iPhone 通常有，但不保證，也不一定是海平面高度）。 */
export const gpsProvider = {
  source: 'gps',
  async getAltitude(ctx) {
    const p = ctx?.position;
    if (!p || !finite(p.altitude)) return null;
    return { value: p.altitude, accuracy: finite(p.altitudeAccuracy) ? p.altitudeAccuracy : undefined, label: 'GPS 定位海拔（手機回報）' };
  },
};

/**
 * 內建：後端 /api/environment（Open-Meteo 氣象模型的地面氣壓、Copernicus 90 m 地形高程）。
 * 同一個位置的兩次呼叫共用一次請求（避免海拔與氣壓各打一次）。
 */
export function createApiProvider(fetchEnvironment) {
  let last = null; // { key, promise }
  const load = (ctx) => {
    const p = ctx?.position;
    if (!p || !finite(p.lat) || !finite(p.lng)) return Promise.resolve(null);
    const key = `${p.lat.toFixed(2)},${p.lng.toFixed(2)}`;
    if (!last || last.key !== key || Date.now() - last.at > 60000) {
      last = { key, at: Date.now(), promise: fetchEnvironment(p.lat, p.lng, ctx?.signal).catch(() => null) };
    }
    return last.promise;
  };
  return {
    source: 'api',
    async getAltitude(ctx) {
      const b = await load(ctx);
      if (!b?.elevation) return null;
      return { value: b.elevation.value, label: b.elevation.label };
    },
    async getPressure(ctx) {
      const b = await load(ctx);
      if (!b?.pressure) return null;
      return { value: b.pressure.surface, seaLevel: b.pressure.seaLevel, label: b.pressure.label, time: b.pressure.time };
    },
  };
}
