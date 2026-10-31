// 一鍵交給導航 App 的連結產生器。
// 所有輸入點都是 GCJ-02（與高德底圖、高德 API 相同），格式：
//   { lng, lat, name?, poiId?, isCurrentLocation? }
// 起點若為「我的位置」，一律「不傳」起點座標，讓導航 App 用自己的 GPS 定位，
// 這是最不容易出錯的做法（避免瀏覽器定位誤差與座標系問題）。

const fmt = (n) => Number(n).toFixed(6);

function isUsablePoint(p) {
  return p && Number.isFinite(p.lng) && Number.isFinite(p.lat);
}

// 路線模式 → 各導航 App 的參數
const IOS_T = { driving: '0', transit: '1', walking: '2', bicycling: '3', electrobike: '3' };
const WEB_MODE = { driving: 'car', transit: 'bus', walking: 'walk', bicycling: 'ride', electrobike: 'ride' };
const APPLE_FLAG = { driving: 'd', transit: 'r', walking: 'w', bicycling: 'w', electrobike: 'd' };

/** 高德地圖 iOS App：iosamap://path（dev=0 表示座標已是 GCJ-02，不再加密）。 */
export function amapIosUri({ start, dest, via = [], mode = 'driving' }) {
  if (!isUsablePoint(dest)) throw new Error('destination required');
  const q = new URLSearchParams();
  q.set('sourceApplication', 'WorldMap');
  if (isUsablePoint(start) && !start.isCurrentLocation) {
    if (start.poiId) q.set('sid', start.poiId);
    q.set('slat', fmt(start.lat));
    q.set('slon', fmt(start.lng));
    q.set('sname', start.name || '起點');
  }
  if (dest.poiId) q.set('did', dest.poiId);
  q.set('dlat', fmt(dest.lat));
  q.set('dlon', fmt(dest.lng));
  q.set('dname', dest.name || '終點');
  const vias = via.filter(isUsablePoint).slice(0, 16);
  if (vias.length) {
    q.set('vian', String(vias.length));
    q.set('vialons', vias.map((p) => fmt(p.lng)).join('|'));
    q.set('vialats', vias.map((p) => fmt(p.lat)).join('|'));
    q.set('vianames', vias.map((p, i) => (p.name || `途經點${i + 1}`).replace(/\|/g, ' ')).join('|'));
  }
  q.set('dev', '0');
  q.set('t', IOS_T[mode] ?? '0');
  return `iosamap://path?${q.toString()}`;
}

/** 高德地圖 Android App：amapuri://route/plan/（參數同 iOS；目前 UI 未使用，留給日後包成 App）。 */
export function amapAndroidUri(args) {
  return `amapuri://route/plan/?${amapIosUri(args).split('?')[1]}`;
}

// 本 App 的路線策略 → uri.amap.com 的 policy（0 推薦、1 避免擁堵、2 避免收費、3 不走高速）
const WEB_POLICY = { recommend: '0', fastest: '0', avoid_tolls: '2', highway: '0', no_highway: '3' };

/** 高德網頁版導航（桌機或沒裝 App 時使用；手機上 callnative=1 會嘗試喚起 App）。 */
export function amapWebUrl({ start, dest, via = [], strategy = 'recommend', mode = 'driving' }) {
  if (!isUsablePoint(dest)) throw new Error('destination required');
  const pt = (p, fallback) => `${fmt(p.lng)},${fmt(p.lat)},${(p.name || fallback).replace(/,/g, ' ')}`;
  const q = new URLSearchParams();
  if (isUsablePoint(start) && !start.isCurrentLocation) q.set('from', pt(start, '起點'));
  q.set('to', pt(dest, '終點'));
  const v = mode === 'driving' ? via.filter(isUsablePoint) : [];
  if (v.length) q.set('via', pt(v[0], '途經點')); // 網頁版只支援 1 個途經點
  q.set('mode', WEB_MODE[mode] ?? 'car');
  if (mode === 'driving') q.set('policy', WEB_POLICY[strategy] ?? '0');
  q.set('coordinate', 'gaode');
  q.set('src', 'WorldMap');
  q.set('callnative', '1');
  return `https://uri.amap.com/navigation?${q.toString()}`;
}

/**
 * Apple 地圖：https://maps.apple.com/?saddr=lat,lng&daddr=lat,lng&dirflg=d
 * 中國大陸的 Apple 地圖底圖由高德提供，座標系同為 GCJ-02，因此直接傳 GCJ-02（不轉回 WGS-84）。
 * 起點是「我的位置」時省略 saddr，Apple 地圖會自動用目前位置。
 * Apple 地圖網址不支援途經點，途經點會被忽略（UI 會提示）。
 */
export function appleMapsUrl({ start, dest, mode = 'driving' }) {
  if (!isUsablePoint(dest)) throw new Error('destination required');
  const q = new URLSearchParams();
  if (isUsablePoint(start) && !start.isCurrentLocation) q.set('saddr', `${fmt(start.lat)},${fmt(start.lng)}`);
  q.set('daddr', `${fmt(dest.lat)},${fmt(dest.lng)}`);
  q.set('dirflg', APPLE_FLAG[mode] ?? 'd');
  return `https://maps.apple.com/?${q.toString()}`;
}

export function detectPlatform(ua = (typeof navigator !== 'undefined' ? navigator.userAgent : ''), maxTouchPoints = (typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0)) {
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1); // iPadOS 會偽裝成 Mac
  const isAndroid = /Android/i.test(ua);
  return { isIOS, isAndroid, isMobile: isIOS || isAndroid };
}
