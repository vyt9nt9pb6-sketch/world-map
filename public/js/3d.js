// 3D 地圖頁：高德 JS API 2.0（viewMode '3D'、傾斜、立體建築）。
// 安全密鑰 jscode 不在前端：_AMapSecurityConfig.serviceHost 指向本站的 /_AMapService 代理，由伺服器補上 jscode。
// JS key 是「Web 端（JS API）」型金鑰，本來就會出現在前端，靠高德後台的網域白名單保護。
import { wgs84ToGcj02 } from './lib/coords.js';

const $ = (id) => document.getElementById(id);
const msg = (t) => {
  $('msg').textContent = t;
  $('msg').classList.toggle('hidden', !t);
};
const q = new URLSearchParams(location.search);
const num = (v, d) => (Number.isFinite(Number(v)) && v != null && v !== '' ? Number(v) : d);

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('無法載入高德 JS API（可能被網路擋住）'));
    document.head.appendChild(s);
  });
}

async function main() {
  let cfg;
  try {
    cfg = await (await fetch('/api/config')).json();
  } catch {
    return msg('無法取得設定，請稍後再試');
  }
  if (!cfg?.features?.amap3d) return msg('3D 地圖尚未啟用（網站管理者還沒有設定高德 JS API 金鑰）。');
  window._AMapSecurityConfig = { serviceHost: location.origin + cfg.amap3d.serviceHost };
  msg('載入 3D 地圖…');
  try {
    await loadScript(`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(cfg.amap3d.key)}`);
  } catch (e) {
    return msg(e.message);
  }
  const AMap = window.AMap;
  const center = [num(q.get('lng'), 119.3389), num(q.get('lat'), 34.7603)];
  const map = new AMap.Map('map3d', {
    viewMode: '3D',
    pitch: 55,
    rotation: 0,
    zoom: Math.min(19, Math.max(3, num(q.get('z'), 16))),
    center,
    showBuildingBlock: true,
    buildingAnimation: true,
    showLabel: true,
  });
  map.on('complete', () => msg(''));
  AMap.plugin(['AMap.ControlBar', 'AMap.Scale'], () => {
    map.addControl(new AMap.ControlBar({ position: { right: '12px', top: '70px' } }));
    map.addControl(new AMap.Scale());
  });
  let me;
  $('locate3d').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        const c = wgs84ToGcj02(p.coords.longitude, p.coords.latitude); // WGS-84 → GCJ-02
        map.setZoomAndCenter(17, c);
        if (me) me.setPosition(c);
        else map.add((me = new AMap.CircleMarker({ center: c, radius: 8, fillColor: '#1f6feb', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 })));
      },
      () => msg('無法取得定位'),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  });
  setTimeout(() => msg(''), 6000);
}
main();
