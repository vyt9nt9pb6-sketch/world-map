// World Map v3 — 前端主程式（Apple 地圖風格）
// 座標約定：畫面上所有點（地圖、搜尋結果、路線）都是 GCJ-02；只有瀏覽器定位是 WGS-84，取得後立刻轉換。
import { wgs84ToGcj02, gcj02ToWgs84, haversine } from './lib/coords.js';
import { api } from './lib/api.js';
import { formatDistance, formatDuration, formatYuan } from './lib/format.js';
import { amapIosUri, amapWebUrl, appleMapsUrl, detectPlatform } from './lib/navlinks.js';
import { amapMarkerUrl, shareMessage, smsHref, copyText } from './lib/share.js';
import { createTiandituFlexible, TIANDITU_ATTRIBUTION } from './lib/tianditu.js';
import { createMapboxSatFlexible, createGoogleSatFlexible, createGoogleTerrainFlexible, MAPBOX_ATTRIBUTION, GOOGLE_ATTRIBUTION } from './lib/ext-sat.js';
import { createReachProbe } from './lib/reach.js';
import { splitTels, telHref, categoryOf, subLine, badgesHtml, photosHtml, infoRows, viewportRadius, movedEnough } from './lib/place-view.js';
import { drivingCardHtml, routeLabelHtml, midPoint, quickPicks } from './lib/route-view.js';
import { weatherCardHtml, arrivalWeatherHtml } from './lib/weather.js';
import { loadFuelPrefs, saveFuelPrefs, energyCost, totalTripCost, fuelSummary, FUEL_DEFAULTS, EV_DEFAULTS } from './lib/fuel.js';
import { createWorldCoverFlexible, WORLDCOVER_LEGEND, legendColor, WORLDCOVER_ATTRIBUTION } from './lib/landcover.js';
import { createPopulationStore, createPopulationLayer, populationLegendHtml, populationNote, boundsToWgs, DENSITY_STOPS } from './lib/population.js';
import { createTrafficLayer, trafficLegendHtml, TRAFFIC_LEGEND } from './lib/traffic-layer.js';
import { filterPoints, shouldRecord, toHeatData, footprintGradient, footprintRadiusPx, footprintHeatOpacity, FOOT_PRIVACY, FOOT_BACKGROUND, FOOT_RANGES } from './lib/footprint.js';
import { createMetroLoader, collectStations } from './lib/metro-layer.js';
import { createStore, findSamePlace } from './lib/favstore.js';
import { transitSummary, transitDetail, esc } from './lib/transit-view.js';
import { loadAMap, createMapView } from './lib/amap-map.js';
import { createSheet } from './lib/sheet.js';
import { createHistory } from './lib/history.js';
import { scaleBar } from './lib/scale.js';
import { createEnvService, gpsProvider, createApiProvider, SOURCE_NAMES } from './lib/env-provider.js';

const $ = (id) => document.getElementById(id);
const platform = detectPlatform();
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;
const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

const TRANSIT_STRATEGIES = [
  { id: 'recommend', label: '推薦' },
  { id: 'rail_first', label: '鐵路優先' },
  { id: 'fastest', label: '最快' },
  { id: 'least_transfer', label: '少換乘' },
  { id: 'least_walk', label: '少步行' },
  { id: 'subway_first', label: '地鐵優先' },
  { id: 'cheapest', label: '最省錢' },
];
const MODES = {
  driving: { label: '駕車路線', color: '#007aff' },
  transit: { label: '公交／火車路線', color: '#007aff' },
  walking: { label: '步行路線', color: '#34c759' },
  bicycling: { label: '騎行路線', color: '#ff9500' },
  electrobike: { label: '電動車路線', color: '#af52de' },
};
const SEG_STYLE = {
  walk: { color: '#6c6c70', weight: 5, dash: true },
  bus: { color: '#007aff', weight: 7 },
  subway: { color: '#af52de', weight: 7 },
  train: { color: '#d70015', weight: 7 },
};
const NEARBY = {
  toilet: { label: '廁所', emoji: '🚻' },
  gas: { label: '加油站', emoji: '⛽' },
  ev: { label: '充電站', emoji: '🔌' },
};
const DEFAULT_CENTER = { lng: 119.3389, lat: 34.7603 }; // 連雲港市連雲區（GCJ-02）
const MY_LOCATION = Object.freeze({ isCurrentLocation: true, name: '我的位置' });
const LAYER_KEY = 'wm.layer.v3';
const HEAT_KEY = 'wm.heat.v5';

const state = {
  layer: { mode: 'standard', source: 'amap', labels: true },
  me: null, // { lng, lat, accuracy } GCJ-02
  meRaw: null, // { lat, lng, altitude, altitudeAccuracy } WGS-84（給海拔／氣壓用）
  results: [],
  selectedIdx: -1,
  searchMode: 'home', // 'home' | 'results'
  start: MY_LOCATION,
  dest: null,
  via: [],
  strategy: 'recommend',
  mode: 'driving',
  transitStrategy: 'recommend',
  config: null,
  user: null,
  routes: [],
  routeIdx: 0,
  picking: null, // 'start' | 'dest' | { via: index }
  view: 'search',
  placeFrom: 'search',
  pitch3d: false,
  heat: { pop: false, popOpacity: 70, traffic: false, foot: false, footRec: false, footRange: '7d' },
  areaMode: false, // 搜尋結果是否跟著地圖範圍自動更新
  lastQuery: '',
  avoidHighway: false,
  avoidToll: false,
  depart: null, // epoch 秒；null＝現在出發
};
const ROUTE_OPTS_KEY = 'wm.routeopts.v4';
try {
  const o = JSON.parse(localStorage.getItem(ROUTE_OPTS_KEY) || '{}');
  state.avoidHighway = !!o.avoidHighway;
  state.avoidToll = !!o.avoidToll;
} catch {
  /* 沒有儲存的偏好 */
}
const saveRouteOpts = () => {
  try {
    localStorage.setItem(ROUTE_OPTS_KEY, JSON.stringify({ avoidHighway: state.avoidHighway, avoidToll: state.avoidToll }));
  } catch {
    /* 無痕模式 */
  }
};

/* ---- 油費／電費估算偏好（v4.2）---- */
let fuelPrefs = loadFuelPrefs();
function syncFuelOpts() {
  const ev = fuelPrefs.type === 'ev';
  document.querySelectorAll('#fuel-type [data-t]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.t === fuelPrefs.type)));
  $('fuel-cons').value = fuelPrefs.consumption;
  $('fuel-price').value = fuelPrefs.price;
  $('fuel-cons-lbl').textContent = ev ? '電耗' : '油耗';
  $('fuel-cons-unit').textContent = ev ? 'kWh/100km' : 'L/100km';
  $('fuel-price-lbl').textContent = ev ? '電價' : '油價';
  $('fuel-price-unit').textContent = ev ? '¥/kWh' : '¥/L';
}
$('fuel-type').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]');
  if (!b || b.dataset.t === fuelPrefs.type) return;
  fuelPrefs.type = b.dataset.t;
  // 切換車種時把數值帶成該車種的參考預設（使用者之後可再改，改過就存偏好）
  fuelPrefs = { ...fuelPrefs, ...(fuelPrefs.type === 'ev' ? EV_DEFAULTS : FUEL_DEFAULTS) };
  saveFuelPrefs(fuelPrefs);
  syncFuelOpts();
  if (state.mode === 'driving' && state.routes.length) renderRoutes();
});
for (const [id, field] of [
  ['fuel-cons', 'consumption'],
  ['fuel-price', 'price'],
]) {
  $(id).addEventListener('change', (e) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n > 0) fuelPrefs[field] = Math.round(n * 100) / 100;
    saveFuelPrefs(fuelPrefs);
    syncFuelOpts();
    if (state.mode === 'driving' && state.routes.length) renderRoutes();
  });
}
syncFuelOpts();
/** 駕車卡片的能耗資訊：null＝偏好不完整（不顯示）。 */
function fuelForRoute(r) {
  const cost = energyCost(r.distance, fuelPrefs);
  if (cost == null) return null;
  return { cost, type: fuelPrefs.type, total: totalTripCost(cost, r.tolls) };
}
const store = createStore();
const history_ = createHistory();
let view = null; // 地圖（AMap 載入後才有）

/* ---------------- 小工具 ---------------- */
let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
function setStatus(id, msg, isError = false) {
  const el = $(id);
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}
const safeProbe = (() => {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;visibility:hidden;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)';
  document.body.appendChild(d);
  return () => {
    const cs = getComputedStyle(d);
    return { top: parseFloat(cs.paddingTop) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
  };
})();
const centerOf = () => (view ? view.getCenter() : DEFAULT_CENTER);
const pinHtml = (cls, text) => `<div class="pin ${cls}"><span></span><b>${esc(text)}</b></div>`;
const emojiHtml = (emoji, cls = '') => `<div class="emo-pin ${cls}">${emoji}</div>`;

/* ---------------- 底部面板 ---------------- */
const sheetEl = $('sheet');
function currentViewEl() {
  return $(`view-${state.view}`);
}
/* iOS Safari 開鍵盤時：版面視口（innerHeight）不縮，只有「視覺視口」縮小並被捲動，
   固定定位的面板就會被推出螢幕上緣。所以面板的位置與高度改用 visualViewport 計算：
   --vv-bottom＝版面視口底邊到視覺視口底邊的距離（鍵盤高度），鍵盤開啟時面板貼在鍵盤上方、高度不超過可見區。 */
const vvState = { kb: false, h: window.innerHeight, bottom: 0 };
function syncViewport() {
  const vv = window.visualViewport;
  const H = window.innerHeight;
  const h = vv ? vv.height : H;
  const top = vv ? vv.offsetTop : 0;
  const kb = H - h > 120 && document.activeElement?.matches?.('input, textarea');
  Object.assign(vvState, { kb: !!kb, h: kb ? h : H, bottom: kb ? Math.max(0, H - h - top) : 0 });
  document.documentElement.style.setProperty('--vv-bottom', `${vvState.bottom}px`);
  document.body.classList.toggle('kb-open', vvState.kb);
}
function detents() {
  const H = window.innerHeight;
  const sf = safeProbe();
  const zone = currentViewEl()?.querySelector('.peek-block');
  const peek = 20 + (zone ? zone.offsetHeight : 50) + 8;
  const full = vvState.kb ? vvState.h - 16 : H - sf.top - 60;
  return { peek, half: Math.round(H * 0.5), full: Math.round(full) };
}
const sheet = createSheet({
  el: sheetEl,
  getDetents: detents,
  onChange: (snap, h) => {
    document.body.dataset.snap = snap;
    const half = detents().half;
    document.documentElement.style.setProperty('--sheet-h', `${Math.min(h, half)}px`);
  },
});
const setSnap = (s) => sheet.set(s);
const mapPad = () => {
  const sf = safeProbe();
  const h = Math.min(sheet.height, detents().half);
  return isDesktop()
    ? { top: sf.top + 70, bottom: 60, left: 440, right: 80 }
    : { top: sf.top + 80, bottom: h + 36 + sf.bottom, left: 30, right: 70 };
};

/* ---------------- 畫面切換 ---------------- */
function showView(v) {
  state.view = v;
  for (const name of ['search', 'place', 'route', 'nearby', 'account']) $(`view-${name}`).classList.toggle('hidden', name !== v);
  const picking = !!state.picking && v === 'search';
  $('pick-hint').classList.toggle('hidden', !picking);
  if (picking) {
    const p = state.picking;
    $('pick-hint-text').textContent = p === 'start' ? '選擇起點（搜尋或點地圖）' : p === 'dest' ? '選擇終點（搜尋或點地圖）' : '選擇途經點（搜尋或點地圖）';
  }
  syncAreaUi(false);
  requestAnimationFrame(() => sheet.refresh());
}
function showSearchHome() {
  state.searchMode = 'home';
  $('search-home').classList.remove('hidden');
  $('search-results').classList.add('hidden');
  renderHistory();
  showView('search');
}
function showSearchResults() {
  state.searchMode = 'results';
  $('search-home').classList.add('hidden');
  $('search-results').classList.remove('hidden');
  showView('search');
}

/* ---------------- 地圖：載入與圖層 ---------------- */
const noopGroup = () => ({ add() {}, clear() {}, size: 0 });
let groups = Object.fromEntries(['results', 'route', 'stops', 'me', 'nearby', 'mark', 'drop', 'rail', 'railDots'].map((k) => [k, noopGroup()]));
async function initMap() {
  $('map-error').classList.add('hidden');
  const f = state.config?.features || {};
  if (!f.amap3d || !state.config?.amap3d?.key) {
    showMapError('尚未設定高德地圖的瀏覽器金鑰（網站管理者需要設定 AMAP_JS_KEY 與安全密鑰）。搜尋、路線與收藏仍可使用。');
    return;
  }
  let AMap;
  try {
    AMap = await loadAMap(state.config.amap3d);
  } catch {
    showMapError('無法連線到高德地圖。請檢查網路後重試。');
    return;
  }
  const qs = new URLSearchParams(location.search);
  const startC = qs.get('lng') && qs.get('lat') ? { lng: +qs.get('lng'), lat: +qs.get('lat') } : DEFAULT_CENTER;
  // Google Map Tiles session（瀏覽器快取；過期前重用）。衛星與地形是兩種 session。
  const gSessions = { satellite: { token: '', expiry: 0 }, terrain: { token: '', expiry: 0 } };
  const ensureGoogleSession = async (type = 'satellite') => {
    const now = Date.now() / 1000;
    const cur = gSessions[type];
    if (cur.token && cur.expiry - 60 > now) return cur.token;
    const r = await fetch('/api/google-tiles/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
    });
    if (!r.ok) throw new Error('google_session');
    const j = await r.json();
    gSessions[type] = { token: j.session, expiry: Number(j.expiry) || now + 86400 };
    return gSessions[type].token;
  };
  window.__wmGoogleSession = () => gSessions.satellite.token; // Flexible createTile 同步讀取
  window.__wmGoogleTerrainSession = () => gSessions.terrain.token;

  view = createMapView(AMap, $('map'), {
    center: startC,
    zoom: qs.get('z') ? Math.min(19, Math.max(3, +qs.get('z'))) : 12,
    dark: prefersDark(),
    tianditu: state.config.tianditu?.tk ? { tk: state.config.tianditu.tk } : null,
    mapbox: state.config.mapbox?.token ? { token: state.config.mapbox.token } : null,
    google: state.config.googleTiles?.key ? { key: state.config.googleTiles.key } : null,
    createTianditu: (A, kind) => createTiandituFlexible(A, { tk: state.config.tianditu.tk, kind }),
    createLandcover: (A) => createWorldCoverFlexible(A),
    createMapboxSat: (A) => createMapboxSatFlexible(A, { token: state.config.mapbox.token }),
    createGoogleSat: (A) => createGoogleSatFlexible(A, { key: state.config.googleTiles.key, getSession: () => window.__wmGoogleSession() }),
    createGoogleTerrain: (A) => createGoogleTerrainFlexible(A, { key: state.config.googleTiles.key, getSession: () => window.__wmGoogleTerrainSession() }),
  });
  view._ensureGoogleSession = ensureGoogleSession;
  groups = {
    results: view.group(),
    route: view.group(),
    stops: view.group(),
    me: view.group(),
    nearby: view.group(),
    mark: view.group(),
    drop: view.group(),
    rail: view.group(),
    railDots: view.group(),
  };
  view.on('tap', (p) => onMapTap(p));
  view.on('longpress', (p) => onMapLongPress(p));
  view.on('viewchange', () => {
    syncHud();
    if (state.layer.mode === 'transit') {
      drawMetroStations();
      scheduleMetro();
    }
    schedulePop();
    tuneFootHeat();
    scheduleViewSettled();
  });
  view.on('dragstart', () => {
    if (document.activeElement === $('search-input')) $('search-input').blur();
  });
  setInterval(syncHud, 250); // 旋轉／俯仰沒有穩定的事件，輕量輪詢
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', (e) => view.setDark(e.matches));
  applyLayer();
  drawMe();
  if (qs.get('view') === '3d') setTimeout(() => set3D(true), 600);
  window.__worldMap.view = view;
}
function showMapError(msg) {
  $('map-error-text').textContent = msg;
  $('map-error').classList.remove('hidden');
}
$('map-retry').addEventListener('click', async () => {
  try {
    state.config = await api.config();
  } catch {
    /* 沿用舊設定 */
  }
  initMap();
});

function loadLayerPref() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYER_KEY) || 'null');
    const modes = ['standard', 'satellite', 'transit', 'landcover', 'terrain'];
    const sources = ['amap', 'tianditu', 'mapbox', 'google'];
    if (v && modes.includes(v.mode)) Object.assign(state.layer, { mode: v.mode, source: sources.includes(v.source) ? v.source : 'amap', labels: v.labels !== false });
  } catch {
    /* 略過 */
  }
}
function loadHeatPref() {
  try {
    const v = JSON.parse(localStorage.getItem(HEAT_KEY) || 'null');
    if (!v) return;
    state.heat.pop = !!v.pop;
    state.heat.traffic = !!v.traffic;
    state.heat.foot = !!v.foot;
    state.heat.footRec = !!v.footRec;
    if (FOOT_RANGES.some((r) => r.id === v.footRange)) state.heat.footRange = v.footRange;
    const opacity = Number(v.popOpacity);
    if (opacity >= 20 && opacity <= 90) state.heat.popOpacity = opacity;
  } catch {
    /* 略過 */
  }
}
function saveHeatPref() {
  try {
    localStorage.setItem(HEAT_KEY, JSON.stringify(state.heat));
  } catch {
    /* 無痕模式 */
  }
}
const googleReachable = createReachProbe();
let layerSeq = 0;
async function applyLayer() {
  const seq = ++layerSeq;
  const L = state.layer;
  const f = state.config?.features || {};
  const tdtOk = !!f.tianditu && !!state.config?.tianditu?.tk;
  const mapboxOk = !!f.mapbox && !!state.config?.mapbox?.token;
  const googleOk = !!f.googleTiles && !!state.config?.googleTiles?.key;
  if (L.source === 'tianditu' && !tdtOk) L.source = 'amap';
  if (L.source === 'mapbox' && !mapboxOk) L.source = 'amap';
  if (L.source === 'google' && !googleOk) L.source = 'amap';
  if (L.mode === 'satellite' && L.source === 'google' && view?._ensureGoogleSession) {
    try { await view._ensureGoogleSession('satellite'); } catch { toast('Google 衛星 session 建立失敗（大陸常需 VPN）'); L.source = 'amap'; }
  }
  // 地形來源：有 Google 金鑰且「現在連得到 Google」（通常代表 VPN 開著）→ Google 地形；否則天地圖 ter_w
  let terrainSrc = 'tianditu';
  if (L.mode === 'terrain') {
    if (googleOk && view?._ensureGoogleSession && (await googleReachable())) {
      try {
        await view._ensureGoogleSession('terrain');
        terrainSrc = 'google';
      } catch {
        terrainSrc = 'tianditu';
      }
    }
    if (terrainSrc === 'tianditu' && !tdtOk) {
      toast(googleOk ? '連不到 Google 地形（請開 VPN），也沒有天地圖地形可用' : '地形圖需要 TIANDITU_TK 或 GOOGLE_MAPS_TILE_KEY');
      L.mode = 'standard';
    }
  }
  if (seq !== layerSeq) return; // 期間使用者又換了圖層
  state.terrainSource = terrainSrc;
  view?.setLayerMode(L.mode, { labels: L.labels, satSource: L.source, terrainSource: terrainSrc });
  document.body.classList.toggle('sat', L.mode === 'satellite');
  document.querySelectorAll('#layer-cards [data-layer]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layer === L.mode)));
  document.querySelectorAll('#opt-source [data-source]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.source === L.source)));
  $('src-tianditu').disabled = !tdtOk;
  $('src-tianditu').title = tdtOk ? '' : '尚未啟用天地圖';
  $('src-mapbox').disabled = !mapboxOk;
  $('src-mapbox').title = mapboxOk ? '大陸常需 VPN' : '請在 Cloudflare 設定 secret：MAPBOX_TOKEN';
  $('src-google').disabled = !googleOk;
  $('src-google').title = googleOk ? '大陸常需 VPN' : '請在 Cloudflare 設定 secret：GOOGLE_MAPS_TILE_KEY';
  $('opt-labels').setAttribute('aria-checked', String(L.labels));
  const satUi = L.mode === 'satellite';
  $('opt-source').classList.toggle('hidden', !satUi);
  // Google 地形本身含道路地名，不提供標註開關
  $('opt-labels').closest('.opt-row').classList.toggle('hidden', !(satUi || (L.mode === 'terrain' && terrainSrc !== 'google')));
  $('opt-transit-note').classList.toggle('hidden', L.mode !== 'transit');
  const terNote = $('opt-terrain-note');
  if (terNote) {
    terNote.classList.toggle('hidden', L.mode !== 'terrain');
    $('terrain-note-text').textContent =
      terrainSrc === 'google'
        ? '地形來源：Google 地形（偵測到你連得到 Google，應該是 VPN 開著）。'
        : googleOk
          ? '地形來源：天地圖 ter_w。開 VPN 後重新點一次「地形」會自動換成 Google 地形。'
          : '地形來源：天地圖 ter_w（暈渲）＋ cta_w（注記），中國境內自動平移對齊高德。';
  }
  $('opt-sat-vpn-note')?.classList.toggle('hidden', !(satUi && (L.source === 'mapbox' || L.source === 'google')));
  const globalSat = L.mode === 'satellite' && L.source === 'tianditu';
  $('opt-global-sat').setAttribute('aria-checked', String(globalSat));
  $('opt-global-sat').disabled = !tdtOk;
  $('opt-landcover').setAttribute('aria-checked', String(L.mode === 'landcover'));
  const terBtn = document.querySelector('#layer-cards [data-layer="terrain"]');
  if (terBtn) {
    terBtn.disabled = !(tdtOk || googleOk);
    terBtn.title = tdtOk || googleOk ? '' : '需要 TIANDITU_TK 或 GOOGLE_MAPS_TILE_KEY';
  }

  $('landcover-legend').classList.toggle('hidden', L.mode !== 'landcover');
  updateAttrib();
  if (L.mode === 'transit') showMetro();
  else hideMetro();
  try {
    localStorage.setItem(LAYER_KEY, JSON.stringify(L));
  } catch {
    /* 略過 */
  }
}
$('btn-layer').addEventListener('click', () => {
  applyLayer();
  $('layer-modal').classList.remove('hidden');
});
const closeLayers = () => $('layer-modal').classList.add('hidden');
$('layer-close').addEventListener('click', closeLayers);
$('layer-modal').addEventListener('click', (e) => e.target === $('layer-modal') && closeLayers());
$('layer-cards').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]');
  if (!b) return;
  state.layer.mode = b.dataset.layer;
  void applyLayer();
});
$('opt-source').addEventListener('click', (e) => {
  const b = e.target.closest('[data-source]');
  if (!b || b.disabled) return;
  state.layer.source = b.dataset.source;
  void applyLayer();
});
$('opt-global-sat').addEventListener('click', () => {
  const on = $('opt-global-sat').getAttribute('aria-checked') === 'true';
  if (on) state.layer.source = 'amap';
  else Object.assign(state.layer, { mode: 'satellite', source: 'tianditu' });
  applyLayer();
});
$('opt-landcover').addEventListener('click', () => {
  state.layer.mode = state.layer.mode === 'landcover' ? 'standard' : 'landcover';
  applyLayer();
});
$('lc-legend-list').innerHTML = WORLDCOVER_LEGEND.map((c) => `<li><i style="background:${legendColor(c)}"></i><span>${c.name}</span></li>`).join('');
$('lc-attrib').textContent = `${WORLDCOVER_ATTRIBUTION}。圖磚由 Terrascope 提供；座標已在中國境內平移對齊高德。`;
$('opt-labels').addEventListener('click', () => {
  state.layer.labels = !state.layer.labels;
  applyLayer();
});

function updateAttrib() {
  const L = state.layer;
  const f = state.config?.features || {};
  const tdtOk = !!f.tianditu && !!state.config?.tianditu?.tk;
  const globalSat = L.mode === 'satellite' && L.source === 'tianditu';
  const terrainSrc = state.terrainSource;
  const base =
    L.mode === 'landcover' ? '© ESA WorldCover 2021 · CC BY 4.0'
    : L.mode === 'terrain' && terrainSrc === 'google' ? GOOGLE_ATTRIBUTION
    : L.mode === 'terrain' && tdtOk ? TIANDITU_ATTRIBUTION
    : globalSat && tdtOk ? TIANDITU_ATTRIBUTION
    : L.mode === 'satellite' && L.source === 'mapbox' ? MAPBOX_ATTRIBUTION
    : L.mode === 'satellite' && L.source === 'google' ? GOOGLE_ATTRIBUTION
    : '';
  const parts = [];
  if (base) parts.push(base);
  if (state.heat.pop) parts.push('人口 Chen et al. 2024 · CC BY 4.0 · 2020 靜態估計');
  if (state.heat.traffic) parts.push('路況 © 高德地圖');
  const attrib = $('map-attrib');
  attrib.textContent = parts.join(' · ');
  attrib.classList.toggle('on', !!attrib.textContent);
}

/* ---- 大眾運輸圖層：城市地鐵／輕軌／磁浮（OpenStreetMap，依各線顏色；資料分格子按需載入） ---- */
const metro = createMetroLoader();
let metroOn = false;
let metroLines = []; // 目前已載入的線路（已是 GCJ-02）
const metroDrawn = new Set();
let metroSeq = 0;
let metroTimer = null;
const METRO_MIN_ZOOM = 8.5;
const METRO_STATION_ZOOM = 11.5;
const METRO_WEIGHT = { subway: 4, light_rail: 3.5, monorail: 3.5, maglev: 4.5 };
function showMetro() {
  metroOn = true;
  scheduleMetro(0);
}
function hideMetro() {
  metroOn = false;
  metroSeq++;
  clearTimeout(metroTimer);
  metroDrawn.clear();
  groups?.rail.clear();
  groups?.railDots.clear();
}
function scheduleMetro(delay = 250) {
  clearTimeout(metroTimer);
  metroTimer = setTimeout(refreshMetro, delay);
}
async function refreshMetro() {
  if (!metroOn || !view) return;
  if (view.getZoom() < METRO_MIN_ZOOM) {
    groups.rail.clear();
    groups.railDots.clear();
    metroDrawn.clear();
    return;
  }
  const seq = ++metroSeq;
  try {
    const { lines } = await metro.load(view.getBounds());
    if (!metroOn || seq !== metroSeq || !view) return;
    metroLines = lines;
    drawMetroLines();
    drawMetroStations();
  } catch (e) {
    if (seq === metroSeq) toast(`地鐵線路資料載入失敗：${e.message || e}`);
  }
}
function drawMetroLines() {
  const b = view.getBounds();
  for (const l of metroLines) {
    if (metroDrawn.has(l)) continue;
    metroDrawn.add(l);
    const w = METRO_WEIGHT[l.kind] || 4;
    for (const path of l.paths) {
      groups.rail.add(view.polyline({ path, color: '#ffffff', weight: w + 3, opacity: 0.9, zIndex: 18 }));
      groups.rail.add(view.polyline({ path, color: l.color, weight: w, opacity: 0.95, zIndex: 20 }));
    }
  }
  void b;
}
function drawMetroStations() {
  if (!view || !metroOn) return;
  groups.railDots.clear();
  const z = view.getZoom();
  if (z < METRO_STATION_ZOOM) return;
  const b = view.getBounds();
  const st = collectStations(metroLines, b);
  let n = 0;
  for (const s of st) {
    if (++n > 400) break;
    const r = z >= 14 ? 5 : z >= 12.5 ? 4 : 3;
    groups.railDots.add(
      view.dot(s.transfer ? { lng: s.lng, lat: s.lat, radius: r + 1.5, color: '#1c1c1e', fill: '#ffffff', title: s.name, zIndex: 60 } : { lng: s.lng, lat: s.lat, radius: r, color: s.colors[0], fill: '#ffffff', title: s.name, zIndex: 58 }),
    );
    if (z >= 13 && n <= 110) groups.railDots.add(view.text({ lng: s.lng, lat: s.lat, text: s.name }));
  }
}

/* ---- 2D／3D、指北針、比例尺 ---- */
function set3D(on) {
  if (!view) return toast('地圖尚未載入');
  state.pitch3d = on;
  view.setPitch(on ? 55 : 0);
  if (on && view.getZoom() < 14) toast('放大到街道層級（約 15 級以上）可以看到 3D 建築', 3800);
  setTimeout(() => {
    if (on && view.getPitch() < 1) {
      state.pitch3d = false;
      toast('這台裝置或瀏覽器無法使用 3D（需要 WebGL）');
    }
    syncHud();
  }, 500);
  syncHud();
}
$('btn-3d').addEventListener('click', () => set3D(!(view && view.getPitch() > 1)));
$('btn-compass').addEventListener('click', () => {
  view?.resetNorth();
  setTimeout(syncHud, 400);
});
let lastHud = '';
function syncHud() {
  if (!view) return;
  const rot = view.getRotation();
  const pitch = view.getPitch();
  const zoom = view.getZoom();
  const c = view.getCenter();
  const key = `${rot.toFixed(0)}|${pitch.toFixed(0)}|${zoom.toFixed(2)}|${c.lat.toFixed(3)}`;
  if (key === lastHud) return;
  lastHud = key;
  const is3D = pitch > 1;
  $('btn-3d').setAttribute('aria-pressed', String(is3D));
  $('btn-3d-label').textContent = is3D ? '2D' : '3D';
  $('btn-compass').classList.toggle('hidden', Math.abs(rot) < 1 && !is3D);
  $('compass-needle').style.transform = `rotate(${-rot}deg)`;
  $('scale').classList.add('on');
  const s = scaleBar(zoom, c.lat);
  $('scale-bar').style.width = `${s.px}px`;
  $('scale-label').textContent = s.label;
}

/* ---------------- 定位 ---------------- */
let locating = false;
function locate({ pan = true, quiet = false } = {}) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      if (!quiet) toast('這個瀏覽器不支援定位');
      return resolve(null);
    }
    if (!window.isSecureContext && !quiet) toast('定位需要 https 連線');
    locating = true;
    $('btn-locate').classList.add('active');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        locating = false;
        $('btn-locate').classList.remove('active');
        const c = pos.coords;
        const [lng, lat] = wgs84ToGcj02(c.longitude, c.latitude);
        state.me = { lng, lat, accuracy: c.accuracy };
        state.meRaw = { lat: c.latitude, lng: c.longitude, altitude: c.altitude, altitudeAccuracy: c.altitudeAccuracy };
        drawMe();
        if (pan && view) view.flyTo(state.me, Math.max(view.getZoom(), 15), mapPad());
        refreshEnv();
        resolve(state.me);
      },
      (err) => {
        locating = false;
        $('btn-locate').classList.remove('active');
        if (!quiet) toast(err.code === 1 ? '沒有定位權限：請在瀏覽器設定中允許取得位置' : err.code === 3 ? '定位逾時，請再試一次' : '無法取得目前位置');
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
function drawMe() {
  if (!view) return;
  groups.me.clear();
  if (!state.me) return;
  if (state.me.accuracy && state.me.accuracy < 2000) groups.me.add(view?.circle({ lng: state.me.lng, lat: state.me.lat, radius: state.me.accuracy }));
  groups.me.add(view?.marker({ lng: state.me.lng, lat: state.me.lat, html: '<div class="me-dot"></div>', zIndex: 300, onClick: () => showMyLocationCard() }));
}
$('btn-locate').addEventListener('click', () => {
  if (!locating) locate();
});

/* ---------------- 海拔／氣壓（估計）：提供者介面見 lib/env-provider.js ---------------- */
const env = createEnvService();
env.registerProvider(gpsProvider);
env.registerProvider(createApiProvider((lat, lng, signal) => api.environment(lat, lng, signal)));
const ENV_NOTE_EST = '估計值：網頁讀不到手機的氣壓計。海拔優先用 GPS（手機有回報時），否則用地形資料；氣壓是氣象模型估計，與實際常差數 hPa。';
const ENV_NOTE_SENSOR = '氣壓來自裝置感測器。';
const envHtml = `<div class="env-card"><div class="env-grid">
  <div class="env-item"><div class="k">海拔</div><b data-env="alt">—</b><div class="src" data-env="alt-src"></div></div>
  <div class="env-item"><div class="k">氣壓</div><b data-env="pr">—</b><div class="src" data-env="pr-src"></div></div>
  </div><p class="env-note" data-env="note"></p>
  <div class="env-actions"><span class="muted small" data-env="time"></span><button type="button" class="link-btn" data-env-refresh>更新</button></div></div>`;
document.querySelectorAll('[data-env-slot]').forEach((s) => (s.innerHTML = envHtml));
const envState = { alt: null, pr: null, busy: false, msg: '' };
function renderEnv() {
  const fmtSrc = (r) => (r ? `${r.estimate ? '<span class="est">估計</span>' : ''}${esc(r.label)}${r.accuracy != null ? `（±${Math.round(r.accuracy)} m）` : ''}` : '');
  document.querySelectorAll('.env-card').forEach((c) => {
    const q = (k) => c.querySelector(`[data-env="${k}"]`);
    q('alt').innerHTML = envState.alt ? `${Math.round(envState.alt.value)}<small>公尺</small>` : '—';
    q('alt-src').innerHTML = envState.alt ? fmtSrc(envState.alt) : envState.msg;
    q('pr').innerHTML = envState.pr ? `${envState.pr.value.toFixed(1)}<small>hPa</small>` : '—';
    q('pr-src').innerHTML = envState.pr ? `${fmtSrc(envState.pr)}${envState.pr.seaLevel != null ? `<br>換算海平面 ${envState.pr.seaLevel.toFixed(1)} hPa` : ''}` : envState.msg ? '' : '';
    q('note').textContent = envState.pr?.source === 'sensor' || envState.alt?.source === 'sensor' ? ENV_NOTE_SENSOR : ENV_NOTE_EST;
    const t = envState.pr?.time || envState.alt?.time;
    q('time').textContent = t ? `更新於 ${new Date(t).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}` : '';
    const b = c.querySelector('[data-env-refresh]');
    b.textContent = envState.busy ? '更新中…' : state.meRaw ? '更新' : '取得位置';
    b.disabled = envState.busy;
  });
}
async function refreshEnv() {
  if (!state.meRaw || envState.busy) return;
  envState.busy = true;
  envState.msg = '';
  renderEnv();
  const ctx = { position: state.meRaw };
  const [alt, pr] = await Promise.all([env.getAltitude(ctx), env.getPressure(ctx)]);
  envState.alt = alt;
  envState.pr = pr;
  envState.msg = !alt && !pr ? '暫時取不到資料' : '';
  envState.busy = false;
  renderEnv();
}
document.addEventListener('click', async (e) => {
  if (!e.target.closest('[data-env-refresh]')) return;
  if (!state.meRaw) {
    const me = await locate({ pan: false });
    if (!me) return;
  }
  refreshEnv();
});
renderEnv();
// 給原生 App 外殼（WebView）用：window.WorldMapEnv.registerProvider({source:'sensor', getPressure, getAltitude})
window.WorldMapEnv = { registerProvider: (p) => { const off = env.registerProvider(p); refreshEnv(); return off; }, refresh: refreshEnv };

/* ---------------- 搜尋＋搜尋記錄 ---------------- */
let searchCtrl;
function renderHistory(filter = '') {
  const items = history_.suggest(filter, 8);
  const all = history_.list();
  $('history-block').classList.toggle('hidden', !all.length);
  $('h-history').textContent = filter && items.length ? '符合的記錄' : '最近搜尋';
  const shown = filter ? items : all.slice(0, 8);
  $('history-block').classList.toggle('hidden', !shown.length);
  const ul = $('history-list');
  ul.innerHTML = '';
  for (const item of shown) {
    const q = item.q;
    const li = document.createElement('li');
    li.innerHTML = `<span class="ico"><svg><use href="#i-clock" /></svg></span><div class="body"><div class="name">${esc(q)}</div></div><button type="button" class="del" aria-label="刪除這筆記錄"><svg><use href="#i-close" /></svg></button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) {
        history_.remove(q);
        renderHistory($('search-input').value.trim());
        return;
      }
      $('search-input').value = q;
      $('search-clear').classList.remove('hidden');
      $('search-input').blur();
      doSearch(q);
    });
    ul.appendChild(li);
  }
}
$('history-clear').addEventListener('click', () => {
  history_.clear();
  renderHistory();
});

async function doSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  history_.add(q);
  state.areaMode = false;
  state.lastQuery = q;
  areaCtrl?.abort();
  $('search-input').value = q;
  $('search-clear').classList.remove('hidden');
  $('search-cancel').classList.remove('hidden');
  $('area-suggest').classList.add('hidden');
  syncAreaUi();
  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const { signal } = searchCtrl;
  showSearchResults();
  setSnap('half');
  setStatus('search-status', '搜尋中…');
  $('results').innerHTML = '';
  groups?.results.clear();
  const center = centerOf();
  const [poi, geo] = await Promise.allSettled([api.search(q, center, { signal }), api.geocode(q, { signal })]);
  if (signal.aborted) return;
  const list = [];
  const pois = poi.status === 'fulfilled' ? poi.value.results : [];
  if (geo.status === 'fulfilled') {
    for (const g of geo.value.results.slice(0, 2)) if (!(pois.length && g.level === '兴趣点')) list.push(g);
  }
  list.push(...pois);
  state.results = list;
  state.selectedIdx = -1;
  if (!list.length) {
    const err = poi.status === 'rejected' ? poi.reason : geo.status === 'rejected' ? geo.reason : null;
    setStatus('search-status', err ? err.message : '找不到結果，換個關鍵字試試', !!err);
    return;
  }
  setStatus('search-status', `找到 ${list.length} 筆結果`);
  renderResults();
  suppressArea();
  view?.fit(list.map((r) => ({ lng: r.lng, lat: r.lat })), mapPad());
}

/* ---- 搜尋附近：結果跟著地圖範圍更新（拖曳／縮放後 600 ms 自動重查，並有快取與最短間隔保護高德額度） ---- */
let areaCtrl;
let areaTimer;
let areaBase = null; // 上次搜尋時的 { center, zoom, radius }
let suppressUntil = 0;
let lastAreaAt = 0;
const areaCache = new Map();
const AREA_DEBOUNCE_MS = 600;
const AREA_MIN_GAP_MS = 1500;
const suppressArea = (ms = 2200) => {
  suppressUntil = Date.now() + ms;
};
function viewSnapshot() {
  if (!view) return null;
  const el = $('map');
  const center = view.getCenter();
  const zoom = view.getZoom();
  const width = el.clientWidth - (isDesktop() ? 440 : 0);
  const height = el.clientHeight - (isDesktop() ? 0 : Math.min(sheet.height, detents().half));
  return { center, zoom, radius: viewportRadius({ zoom, lat: center.lat, width: Math.max(160, width), height: Math.max(160, height) }) };
}
const distLL = (a, b) => haversine(a.lng, a.lat, b.lng, b.lat);
function syncAreaUi(showBtn = false) {
  $('btn-area-mode').setAttribute('aria-pressed', String(state.areaMode));
  $('area-btn').classList.toggle('hidden', !(showBtn && !state.areaMode && state.view === 'search' && state.searchMode === 'results'));
}
async function runAreaSearch(q) {
  const snap = viewSnapshot();
  if (!snap || !q) return;
  areaBase = snap;
  lastAreaAt = Date.now();
  syncAreaUi(false);
  areaCtrl?.abort();
  areaCtrl = new AbortController();
  const { signal } = areaCtrl;
  const key = `${q}|${snap.center.lng.toFixed(3)},${snap.center.lat.toFixed(3)}|${Math.round(snap.radius / 150)}`;
  setStatus('search-status', '搜尋此區域…');
  try {
    let data = areaCache.get(key);
    if (!data) {
      data = await api.search(q, snap.center, { area: true, radius: snap.radius, signal });
      areaCache.set(key, data);
      if (areaCache.size > 40) areaCache.delete(areaCache.keys().next().value);
    }
    if (signal.aborted) return;
    state.results = data.results;
    state.selectedIdx = -1;
    renderResults();
    setStatus('search-status', data.results.length ? `這個範圍（半徑約 ${formatDistance(snap.radius)}）找到 ${data.results.length} 筆「${q}」，拖曳或縮放地圖會自動更新` : `這個範圍內沒有「${q}」，試著拖曳或縮放地圖`);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('search-status', e.message || '搜尋失敗', true);
  }
}
function startAreaSearch(q) {
  q = (q || '').trim();
  if (!q) return;
  history_.add(q);
  state.areaMode = true;
  state.lastQuery = q;
  searchCtrl?.abort();
  $('search-input').value = q;
  $('search-input').blur();
  $('search-clear').classList.remove('hidden');
  $('search-cancel').classList.remove('hidden');
  $('area-suggest').classList.add('hidden');
  showSearchResults();
  setSnap('half');
  groups?.results.clear();
  $('results').innerHTML = '';
  runAreaSearch(q);
}
function onViewSettled() {
  if (!view) return;
  if (Date.now() < suppressUntil) {
    areaBase = viewSnapshot();
    nearbyBase = areaBase;
    return;
  }
  const snap = viewSnapshot();
  if (state.view === 'search' && state.searchMode === 'results' && state.lastQuery) {
    if (!movedEnough(areaBase, snap, distLL)) return;
    if (!state.areaMode) return syncAreaUi(true);
    const wait = AREA_MIN_GAP_MS - (Date.now() - lastAreaAt);
    if (wait > 0) return scheduleViewSettled(wait);
    runAreaSearch(state.lastQuery);
  } else if (state.view === 'nearby' && nearbyKind && nearbyAuto) {
    if (!movedEnough(nearbyBase, snap, distLL)) return;
    const wait = AREA_MIN_GAP_MS - (Date.now() - lastAreaAt);
    if (wait > 0) return scheduleViewSettled(wait);
    lastAreaAt = Date.now();
    runNearby(nearbyKind, { forceMap: true, auto: true });
  }
}
function scheduleViewSettled(ms = AREA_DEBOUNCE_MS) {
  clearTimeout(areaTimer);
  areaTimer = setTimeout(onViewSettled, ms);
}
$('area-btn').addEventListener('click', () => {
  if (state.lastQuery) runAreaSearch(state.lastQuery);
});
$('btn-area-mode').addEventListener('click', () => {
  state.areaMode = !state.areaMode;
  syncAreaUi(false);
  if (state.areaMode && state.lastQuery) runAreaSearch(state.lastQuery);
});
$('area-suggest').addEventListener('click', () => startAreaSearch($('search-input').value));
function renderResults() {
  const ul = $('results');
  ul.innerHTML = '';
  groups?.results.clear();
  let n = 0;
  state.results.forEach((r, i) => {
    const isAddr = r.kind === 'address';
    const label = isAddr ? '址' : String(++n);
    const li = document.createElement('li');
    const sub = isAddr ? `地址 · ${r.level || ''}` : [r.address, [r.city, r.district].filter(Boolean).join('')].filter(Boolean).join(' · ');
    li.innerHTML = `<span class="ico ${isAddr ? 'addr' : 'blue'}">${label}</span><div class="body"><div class="name">${esc(r.name)}</div><div class="sub">${esc(sub)}</div></div>${r.distance != null ? `<div class="dist">${formatDistance(r.distance)}</div>` : ''}`;
    li.addEventListener('click', () => selectResult(i));
    ul.appendChild(li);
    groups?.results.add(
      view?.marker({ lng: r.lng, lat: r.lat, html: pinHtml(isAddr ? 'addr' : '', label), anchor: 'bottom-center', zIndex: 120, title: r.name, onClick: () => selectResult(i) }),
    );
  });
}
const toStop = (r) => ({ lng: r.lng, lat: r.lat, name: r.name, poiId: r.kind === 'poi' ? r.id : undefined });
function selectResult(i) {
  const r = state.results[i];
  if (!r) return;
  state.selectedIdx = i;
  if (state.picking) return assignStop(state.picking, toStop(r));
  suppressArea();
  showPlace(toStop(r), { addr: r.kind === 'address' ? r.address : [r.address, (r.city || '') + (r.district || '')].filter(Boolean).join(' · '), zoom: 16, data: r.kind === 'poi' ? r : null });
}
$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('search-input').blur();
  doSearch($('search-input').value);
});
$('search-input').addEventListener('input', () => {
  const v = $('search-input').value.trim();
  $('search-clear').classList.toggle('hidden', !v);
  if (state.searchMode === 'results') showSearchHome();
  renderHistory(v);
  $('area-suggest').classList.toggle('hidden', !v || state.picking);
  $('area-suggest-name').textContent = v ? `搜尋附近「${v}」` : '';
  sheet.refresh();
});
$('search-input').addEventListener('focus', () => {
  $('search-cancel').classList.remove('hidden');
  if (state.searchMode === 'results' && state.view === 'search') {
    /* 在結果頁點輸入框：保留結果，只展開 */
  } else if (state.view === 'search') {
    renderHistory($('search-input').value.trim());
  }
  setSnap('full');
});
function resetSearch() {
  searchCtrl?.abort();
  areaCtrl?.abort();
  state.areaMode = false;
  state.lastQuery = '';
  $('area-suggest').classList.add('hidden');
  syncAreaUi();
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  $('search-cancel').classList.add('hidden');
  state.results = [];
  groups?.results.clear();
  $('results').innerHTML = '';
  setStatus('search-status', '');
}
$('search-clear').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  resetSearchResultsOnly();
  $('search-input').focus();
});
function resetSearchResultsOnly() {
  searchCtrl?.abort();
  areaCtrl?.abort();
  state.areaMode = false;
  state.lastQuery = '';
  $('area-suggest').classList.add('hidden');
  syncAreaUi();
  state.results = [];
  groups?.results.clear();
  $('results').innerHTML = '';
  showSearchHome();
}
$('search-cancel').addEventListener('click', () => {
  resetSearch();
  $('search-input').blur();
  showSearchHome();
  setSnap('peek');
});
$('pick-cancel').addEventListener('click', () => {
  state.picking = null;
  openRoute();
});

/* ---------------- 地點卡（點地圖／長按／搜尋結果） ---------------- */
let placeStop = null;
let placeSeq = 0;
let placeData = null; // 目前地點的資料（搜尋結果摘要＋/api/place 詳細資料）
let placeRows = null; // 自訂資訊列（我的位置、等待查詢中）；null＝由 placeData 產生
let placeWeather = null; // 目前地點的天氣（/api/weather；null＝還沒有或失敗）
let weatherCtrl = null;
let weatherSeq = 0; // 獨立計數器：不動 placeSeq（selectPoint 依賴它判斷 regeo 是否過期）
const weatherCache = new Map(); // 「lat,lng」→ { w, at }（10 分鐘）

/** 地點的天氣（GCJ-02 → WGS-84 再查；快取 10 分鐘）。失敗時靜默不顯示（天氣是加分項）。 */
async function loadWeather(lng, lat, { signal } = {}) {
  const [wlng, wlat] = gcj02ToWgs84(lng, lat);
  const key = `${wlat.toFixed(2)},${wlng.toFixed(2)}`;
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 600000) return hit.w;
  const w = await api.weather(wlat, wlng, { signal });
  weatherCache.set(key, { w, at: Date.now() });
  if (weatherCache.size > 40) weatherCache.delete(weatherCache.keys().next().value);
  return w;
}
async function loadPlaceWeather(stop) {
  const seq = ++weatherSeq;
  const box = $('place-weather');
  if (!stop || stop.isCurrentLocation || !Number.isFinite(stop.lng) || !Number.isFinite(stop.lat)) {
    box.classList.add('hidden');
    box.innerHTML = '';
    placeWeather = null;
    return;
  }
  weatherCtrl?.abort();
  weatherCtrl = new AbortController();
  try {
    const w = await loadWeather(stop.lng, stop.lat, { signal: weatherCtrl.signal });
    if (seq !== weatherSeq) return; // 已切到別的地點
    placeWeather = w;
    box.innerHTML = weatherCardHtml(w);
    box.classList.toggle('hidden', !box.innerHTML);
  } catch (e) {
    if (e.name !== 'AbortError' && seq === weatherSeq) {
      placeWeather = null;
      box.classList.add('hidden');
    }
  }
}
function placeInfoRows(rows) {
  $('place-info').innerHTML = rows.filter(Boolean).map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${v}</span></div>`).join('');
  $('place-info').classList.toggle('hidden', !rows.filter(Boolean).length);
}
function dropPin(stop) {
  if (!view) return;
  groups.drop.clear();
  if (stop && !stop.isCurrentLocation) groups.drop.add(view?.marker({ lng: stop.lng, lat: stop.lat, html: pinHtml('drop', ''), anchor: 'bottom-center', zIndex: 200 }));
}
// Apple 地圖風格的地點頁：名稱、類別、距離、評分／人均／營業時間、照片、電話、按鈕。沒有的欄位就不顯示。
function renderPlaceRich() {
  const stop = placeStop;
  if (!stop) return;
  const d = placeData;
  const dist = state.me && !stop.isCurrentLocation ? haversine(state.me.lng, state.me.lat, stop.lng, stop.lat) : null;
  const sub = d ? subLine(d, dist) : '';
  $('place-sub').textContent = sub;
  $('place-sub').classList.toggle('hidden', !sub);
  const badges = d ? badgesHtml(d) : '';
  $('place-badges').innerHTML = badges;
  $('place-badges').classList.toggle('hidden', !badges);
  const photos = d?.photos?.length ? d.photos : d?.photo ? [{ url: d.photo }] : [];
  const ph = photosHtml(photos);
  $('place-photos').innerHTML = ph;
  $('place-photos').classList.toggle('hidden', !ph);
  placeInfoRows(placeRows ?? infoRows(d, { distance: dist, lat: stop.lat, lng: stop.lng }));
  const tels = d ? splitTels(d.tels?.length ? d.tels : d.tel) : [];
  $('place-call').classList.toggle('hidden', !tels.length || !!stop.isCurrentLocation);
  $('place-call').dataset.tel = tels[0] ? telHref(tels[0]) : '';
}
$('place-photos').addEventListener(
  'error',
  (e) => {
    if (e.target.tagName !== 'IMG') return;
    e.target.closest('a')?.remove();
    if (!$('place-photos').children.length) $('place-photos').classList.add('hidden');
  },
  true,
);
$('place-call').addEventListener('click', () => {
  const href = $('place-call').dataset.tel;
  if (href) window.location.href = href;
});
const detailCache = new Map();
let detailCtrl;
async function loadPlaceDetail(stop) {
  const id = stop.poiId;
  if (!id) return;
  detailCtrl?.abort();
  try {
    let d = detailCache.get(id);
    if (!d) {
      detailCtrl = new AbortController();
      d = (await api.place(id, { signal: detailCtrl.signal })).place;
      detailCache.set(id, d);
      if (detailCache.size > 60) detailCache.delete(detailCache.keys().next().value);
    }
    if (placeStop !== stop) return;
    const clean = Object.fromEntries(Object.entries(d).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length) && v !== ''));
    placeData = { ...(placeData || {}), ...clean };
    renderPlaceRich();
  } catch {
    /* 詳細資料是加分項：失敗就維持已顯示的內容 */
  }
}
function showPlace(stop, { addr, rows, zoom, keepView = false, data = null } = {}) {
  placeStop = stop;
  placeData = data ? { ...data } : null;
  placeRows = rows ?? null;
  if (state.view !== 'place') state.placeFrom = state.view === 'route' ? 'route' : state.view;
  $('place-name').textContent = stop.name;
  $('place-addr').textContent = addr ?? `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`;
  renderPlaceRich();
  $('place-route').classList.toggle('hidden', !!stop.isCurrentLocation);
  $('place-fav').classList.toggle('hidden', !!stop.isCurrentLocation);
  $('place-share').classList.remove('hidden');
  $('place-env').classList.toggle('hidden', !stop.isCurrentLocation);
  renderPlaceFav();
  dropPin(stop);
  showView('place');
  setSnap('half');
  $('view-place').querySelector('.scroll')?.scrollTo?.(0, 0);
  if (stop.poiId && !stop.isCurrentLocation) loadPlaceDetail(stop);
  loadPlaceWeather(stop);
  if (view && !keepView) {
    if (zoom) view.flyTo(stop, Math.max(view.getZoom(), zoom), mapPad());
    else setTimeout(() => view.ensureVisible(stop, mapPad()), 60);
  }
}
function showMyLocationCard() {
  if (!state.me) return;
  showPlace({ ...state.me, name: '我的位置', isCurrentLocation: true }, { addr: state.me.accuracy ? `定位精度約 ${Math.round(state.me.accuracy)} 公尺` : '', rows: [['座標', `${state.me.lat.toFixed(5)}, ${state.me.lng.toFixed(5)}`]], keepView: true });
  refreshEnv();
}
// 點地圖：就像 Apple 地圖，選中該點附近的地點（POI／建築），沒有就顯示地址
let selectCtrl;
async function selectPoint(p, { radius = 60, long = false } = {}) {
  if (state.picking) return assignStop(state.picking, { lng: p.lng, lat: p.lat, name: '地圖上的點' }, true);
  const seq = ++placeSeq;
  selectCtrl?.abort();
  selectCtrl = new AbortController();
  // 先立刻顯示（不用等網路）
  const pending = { lng: p.lng, lat: p.lat, name: long ? '已標記的位置' : '選取的位置' };
  showPlace(pending, { addr: '正在查詢地點資訊…', rows: [['座標', `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`]] });
  try {
    const r = await api.regeo(p, radius, { signal: selectCtrl.signal });
    if (seq !== placeSeq) return;
    const isPlace = r.kind === 'poi' || r.kind === 'aoi';
    const stop = { lng: isPlace ? r.lng : p.lng, lat: isPlace ? r.lat : p.lat, name: long && !isPlace ? '已標記的位置' : r.name, poiId: r.kind === 'poi' ? r.id : undefined };
    const region = [r.province, r.city, r.district].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join('');
    showPlace(stop, { addr: r.address || region || '', keepView: true, data: isPlace ? r : null });
  } catch (e) {
    if (e.name === 'AbortError' || seq !== placeSeq) return;
    showPlace(pending, { addr: `${e.message || '查不到地點資訊'}（仍可使用座標）`, keepView: true });
  }
}
function onMapTap(p) {
  if (document.activeElement === $('search-input')) {
    $('search-input').blur();
    if (state.view === 'search' && state.searchMode === 'home') return setSnap('peek');
  }
  if (state.view === 'route' || state.view === 'account') return;
  if (state.view === 'nearby' && !state.picking) return;
  selectPoint(p, { radius: 60 });
}
function onMapLongPress(p) {
  if (state.view === 'account') return;
  if (navigator.vibrate) navigator.vibrate(12);
  selectPoint(p, { radius: 30, long: true });
}
function closePlace() {
  placeSeq++;
  selectCtrl?.abort();
  groups?.drop.clear();
  const from = state.placeFrom;
  placeStop = null;
  if (from === 'route' && state.dest) {
    state.placeFrom = 'search';
    return openRoute();
  }
  if (from === 'nearby' && nearbyKind) {
    showView('nearby');
    return setSnap('half');
  }
  if (from === 'search' && state.searchMode === 'results' && state.results.length) {
    showSearchResults();
    return setSnap('half');
  }
  if (from === 'account') return openAccount();
  showSearchHome();
  setSnap('peek');
}
$('place-close').addEventListener('click', closePlace);
$('place-route').addEventListener('click', () => {
  if (!placeStop || placeStop.isCurrentLocation) return;
  state.dest = placeStop;
  state.start = MY_LOCATION;
  state.via = [];
  openRoute();
  planRoute();
});
$('place-share').addEventListener('click', () => {
  if (!placeStop) return;
  if (placeStop.isCurrentLocation) return markMyLocation();
  openShare(placeStop);
});

/* ---------------- 路線（只能從地點卡的「路線」進入） ---------------- */
function assignStop(target, stop, fromMap = false) {
  if (!stop) return;
  if (target === 'start') state.start = stop;
  else if (target === 'dest') state.dest = stop;
  else if (typeof target === 'object' && 'via' in target) {
    if (state.via.length >= 16 && target.via >= state.via.length) return toast('最多 16 個途經點');
    state.via[target.via] = stop;
  }
  state.picking = null;
  if (fromMap) groups?.drop.clear();
  resetSearch();
  openRoute();
  planRoute();
}
function openRoute() {
  state.routeOpen = true;
  renderStops();
  showView('route');
  setSnap('half');
}
function startPicking(target) {
  state.picking = target;
  resetSearch();
  showSearchHome();
  showView('search');
  setSnap('full');
  setTimeout(() => $('search-input').focus(), 50);
}
function stopRow(cls, dotText, stop, placeholder, onPick, onRemove) {
  const row = document.createElement('div');
  row.className = 'stop';
  const name = stop ? stop.name : '';
  row.innerHTML = `<div class="dot ${cls}">${dotText}</div>
    <button type="button" class="field ${name ? '' : 'empty'}">${esc(name || placeholder)}</button>
    ${onRemove ? '<button type="button" class="icon-btn" aria-label="移除">✕</button>' : ''}`;
  row.querySelector('.field').addEventListener('click', onPick);
  if (onRemove) row.querySelector('.icon-btn').addEventListener('click', onRemove);
  return row;
}
function renderStops() {
  const box = $('stops');
  box.innerHTML = '';
  box.appendChild(stopRow('start', '起', state.start, '選擇起點', () => startPicking('start')));
  state.via.forEach((v, i) =>
    box.appendChild(
      stopRow('via', String(i + 1), v, '選擇途經點', () => startPicking({ via: i }), () => {
        state.via.splice(i, 1);
        renderStops();
        planRoute();
      }),
    ),
  );
  box.appendChild(stopRow('dest', '終', state.dest, '選擇終點', () => startPicking('dest')));
  drawStops();
}
function drawStops() {
  if (!view) return;
  groups.stops.clear();
  groups.drop.clear();
  const add = (s, cls, t) => s && !s.isCurrentLocation && groups.stops.add(view?.marker({ lng: s.lng, lat: s.lat, html: pinHtml(cls, t), anchor: 'bottom-center', zIndex: 250 }));
  add(state.start, 'start', '起');
  state.via.forEach((v, i) => add(v, 'via', String(i + 1)));
  add(state.dest, 'dest', '終');
}
const chips = $('strategy-chips');
/* ---- 出發時間、避開高速／收費 ---- */
const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function syncRouteOpts() {
  const drv = state.mode === 'driving';
  const withDepart = drv || state.mode === 'transit';
  $('route-opts').classList.toggle('hidden', !withDepart);
  $('row-avoid-hw').classList.toggle('hidden', !drv);
  $('row-avoid-toll').classList.toggle('hidden', !drv);
  $('row-fuel').classList.toggle('hidden', !drv);
  $('opt-avoid-hw').checked = state.avoidHighway;
  $('opt-avoid-toll').checked = state.avoidToll;
  const at = state.depart != null;
  document.querySelectorAll('#depart-seg [data-d]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.d === 'at') === at)));
  $('depart-input').classList.toggle('hidden', !at);
  const parts = [at ? `${new Date(state.depart * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} 出發` : '現在出發'];
  if (drv && state.avoidHighway) parts.push('避開高速');
  if (drv && state.avoidToll) parts.push('避開收費');
  if (drv) parts.push(fuelSummary(fuelPrefs));
  $('route-opts-sum').textContent = parts.join('・');
}
$('opt-avoid-hw').addEventListener('change', (e) => {
  state.avoidHighway = e.target.checked;
  saveRouteOpts();
  if (state.dest) planRoute();
});
$('opt-avoid-toll').addEventListener('change', (e) => {
  state.avoidToll = e.target.checked;
  saveRouteOpts();
  if (state.dest) planRoute();
});
$('depart-seg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-d]');
  if (!b) return;
  if (b.dataset.d === 'now') {
    state.depart = null;
  } else if (state.depart == null) {
    const d = new Date(Date.now() + 30 * 60000);
    d.setSeconds(0, 0);
    state.depart = Math.floor(d.getTime() / 1000);
    $('depart-input').min = toLocalInput(new Date());
    $('depart-input').max = toLocalInput(new Date(Date.now() + 29 * 86400000));
    $('depart-input').value = toLocalInput(d);
  }
  syncRouteOpts();
  if (state.dest) planRoute();
});
$('depart-input').addEventListener('change', (e) => {
  const t = new Date(e.target.value).getTime();
  if (!Number.isFinite(t)) return;
  if (t < Date.now() - 60000) {
    toast('出發時間不能早於現在');
    state.depart = null;
    syncRouteOpts();
  } else state.depart = Math.floor(t / 1000);
  if (state.dest) planRoute();
});
function renderStrategyChips() {
  chips.innerHTML = '';
  const list = state.mode === 'transit' ? TRANSIT_STRATEGIES : [];
  syncRouteOpts();
  chips.classList.toggle('hidden', !list.length);
  const key = state.mode === 'driving' ? 'strategy' : 'transitStrategy';
  for (const st of list) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('role', 'radio');
    b.dataset.id = st.id;
    b.textContent = st.label;
    b.setAttribute('aria-checked', String(st.id === state[key]));
    b.addEventListener('click', () => {
      state[key] = st.id;
      chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === st.id)));
      planRoute();
    });
    chips.appendChild(b);
  }
}
function setMode(mode, { plan = true } = {}) {
  state.mode = mode;
  document.querySelectorAll('#mode-tabs [data-mode]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === mode)));
  $('route-title').textContent = MODES[mode].label;
  $('btn-add-via').classList.toggle('hidden', mode !== 'driving');
  renderStrategyChips();
  if (plan && state.dest) planRoute();
}
$('mode-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b && b.dataset.mode !== state.mode) setMode(b.dataset.mode);
});
setMode('driving', { plan: false });
$('btn-add-via').addEventListener('click', () => {
  if (state.via.length >= 16) return toast('最多 16 個途經點');
  startPicking({ via: state.via.length });
});
$('btn-swap').addEventListener('click', () => {
  if (!state.dest) return;
  if (state.start.isCurrentLocation && !state.me) return toast('尚未取得目前位置，無法互換');
  const s = state.start.isCurrentLocation ? { ...state.me, name: '我的位置（出發時）' } : state.start;
  state.start = state.dest;
  state.dest = s;
  state.via.reverse();
  renderStops();
  planRoute();
});
function clearRoute() {
  state.routes = [];
  routeCtrl?.abort();
  arriveCtrl?.abort();
  groups?.route.clear();
  groups?.stops.clear();
  $('route-options').innerHTML = '';
  $('route-quick').classList.add('hidden');
  $('route-depart-note').classList.add('hidden');
  $('route-arrive').classList.add('hidden');
  $('route-arrive').innerHTML = '';
  $('nav-buttons').classList.add('hidden');
  $('nav-note').classList.add('hidden');
  setStatus('route-status', '');
}
$('route-back').addEventListener('click', () => {
  const d = state.dest;
  clearRoute();
  state.routeOpen = false;
  if (d) {
    state.placeFrom = 'search';
    showPlace(d, { addr: d.address });
  } else {
    showSearchHome();
    setSnap('peek');
  }
});
$('route-close').addEventListener('click', () => {
  state.routeOpen = false;
  clearRoute();
  state.dest = null;
  showSearchHome();
  setSnap('peek');
});

let routeCtrl;
async function resolveStart() {
  if (!state.start.isCurrentLocation) return state.start;
  const me = state.me || (await locate({ pan: false }));
  return me ? { lng: me.lng, lat: me.lat, name: '我的位置', isCurrentLocation: true } : null;
}
async function planRoute() {
  drawStops();
  groups?.route.clear();
  $('route-options').innerHTML = '';
  $('nav-buttons').classList.add('hidden');
  $('nav-note').classList.add('hidden');
  if (!state.dest) return setStatus('route-status', '請選擇終點');
  setStatus('route-status', state.start.isCurrentLocation && !state.me ? '正在取得目前位置…' : '規劃路線中…');
  if (state.mode !== 'driving' && state.via.length) toast('此交通方式不支援途經點，已忽略');
  const start = await resolveStart();
  if (!start) return setStatus('route-status', '無法取得目前位置：請允許定位，或點「起點」手動選擇', true);
  setStatus('route-status', '規劃路線中…');
  routeCtrl?.abort();
  routeCtrl = new AbortController();
  try {
    const mode = state.mode;
    const strategy = mode === 'driving' ? undefined : mode === 'transit' ? state.transitStrategy : undefined;
    const depart = state.depart != null && (mode === 'driving' || mode === 'transit') ? Math.max(state.depart, Math.floor(Date.now() / 1000)) : undefined;
    const via = mode === 'driving' ? state.via.filter(Boolean) : [];
    const data = await api.route(
      { start, dest: state.dest, via, strategy, mode, avoidHighway: mode === 'driving' && state.avoidHighway, avoidToll: mode === 'driving' && state.avoidToll, depart },
      { signal: routeCtrl.signal },
    );
    if (mode !== state.mode) return;
    state.routes = data.routes;
    state.routeIdx = 0;
    state.resolvedStart = start;
    state.routeMeta = { railFirst: !!data.railFirst, hasTrain: data.hasTrain, depart: data.depart || null, tollNote: data.tollNote || null };
    if (!data.routes.length) return setStatus('route-status', mode === 'transit' ? '找不到公交／火車方案（距離太遠或沒有班次）' : '找不到路線', true);
    let msg = data.routes.length > 1 ? `共 ${data.routes.length} 條路線，點卡片或地圖上的路線可切換` : '';
    if (data.railFirst && data.hasTrain === false) msg = '這段距離找不到含火車的方案，下面是一般公交／地鐵方案。' + (msg ? ' ' + msg : '');
    setStatus('route-status', msg);
    renderRoutes(true);
    scrollRoutesIntoView();
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('route-status', e.message || '路線規劃失敗', true);
  }
}
/** 半高面板時，路線卡片會在起終點卡片下方；算好路線後把清單捲到「路線選項」，卡片一眼就看得到（往上滑仍可改起終點） */
function scrollRoutesIntoView() {
  requestAnimationFrame(() => {
    const sc = $('view-route').querySelector('.scroll');
    const t = $('route-opts').classList.contains('hidden') ? $('route-status') : $('route-opts');
    if (!sc || !t) return;
    const dy = t.getBoundingClientRect().top - sc.getBoundingClientRect().top - 4;
    if (dy > 0) sc.scrollTo({ top: sc.scrollTop + dy, behavior: 'smooth' });
  });
}
function stepsHtml(r) {
  if (!r.steps?.length) return '';
  return `<details class="passed"><summary>逐步指引（${r.steps.length} 步）</summary><ol class="steps">${r.steps
    .map((st) => `<li>${esc(st.instruction || st.road || '')}${st.distance ? ` <span>${formatDistance(st.distance)}</span>` : ''}</li>`)
    .join('')}</ol></details>`;
}
function routeCard(r, sel) {
  const mode = state.mode;
  if (mode === 'driving') return drivingCardHtml(r, { departSec: state.depart, fuel: fuelForRoute(r) });
  if (mode === 'transit') {
    const fee = r.fee != null ? `<span class="fee">車費 ${formatYuan(r.fee)}</span>` : '';
    return `<div class="top"><span class="dur">${formatDuration(r.duration)}</span><span class="dist">${formatDistance(r.distance)}</span>${fee}</div>
      <div class="summary">${transitSummary(r)}</div>
      <div class="meta">步行 ${formatDistance(r.walkingDistance)}</div>
      ${sel ? `<div class="detail">${transitDetail(r)}</div>` : ''}`;
  }
  return `<div class="top"><span class="dur">${formatDuration(r.duration)}</span><span class="dist">${formatDistance(r.distance)}</span></div>
    ${sel ? stepsHtml(r) : ''}`;
}
function drawSelectedTransit(r) {
  for (const seg of r.segments) {
    const path = (seg.polyline || []).map(([lng, lat]) => [lng, lat]);
    if (path.length < 2) continue;
    const style = SEG_STYLE[seg.type] || SEG_STYLE.bus;
    const dash = seg.type === 'walk' || (seg.type === 'train' && seg.lineMatch?.unmatched?.length && !seg.lineMatch.sections.length);
    if (seg.type !== 'walk') groups.route.add(view?.polyline({ path, color: '#ffffff', weight: style.weight + 4, opacity: 0.95, zIndex: 40 }));
    groups.route.add(view?.polyline({ path, color: style.color, weight: style.weight, dash: !!dash, zIndex: 45 }));
    if (seg.type === 'train') {
      for (const p of seg.stops) {
        if (p.lng == null) continue;
        groups.route.add(view?.dot({ lng: p.lng, lat: p.lat, radius: p.role === 'via' ? 5 : 7, color: '#b91c1c', fill: p.role === 'via' ? '#ffffff' : '#b91c1c', zIndex: 80, title: `${p.name}${p.time ? ' ' + p.time : ''}` }));
        groups.route.add(view?.text({ lng: p.lng, lat: p.lat, text: p.name, zIndex: 85 }));
      }
    }
  }
}
function renderRoutes(fit = false) {
  groups.route.clear();
  const ul = $('route-options');
  ul.innerHTML = '';
  state.routes.forEach((r, i) => {
    const sel = i === state.routeIdx;
    const li = document.createElement('li');
    li.className = 'route-option' + (sel ? ' selected' : '');
    li.innerHTML = routeCard(r, sel);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.detail, details')) return;
      state.routeIdx = i;
      renderRoutes();
    });
    ul.appendChild(li);
  });
  const color = MODES[state.mode].color;
  const order = state.routes.map((_, i) => i).sort((a, b) => (a === state.routeIdx) - (b === state.routeIdx));
  for (const i of order) {
    const r = state.routes[i];
    const sel = i === state.routeIdx;
    if (sel && state.mode === 'transit') {
      drawSelectedTransit(r);
      continue;
    }
    const path = r.polyline.map(([lng, lat]) => [lng, lat]);
    if (path.length < 2) continue;
    if (state.mode === 'driving' && state.routes.length > 1) {
      const mp = midPoint(path, [0.5, 0.36, 0.64, 0.28, 0.72][i % 5]);
      if (mp) groups.route.add(view?.marker({ lng: mp.lng, lat: mp.lat, html: routeLabelHtml(r, sel), zIndex: sel ? 90 : 60, onClick: () => { state.routeIdx = i; renderRoutes(); } }));
    }
    if (sel) groups.route.add(view?.polyline({ path, color: '#ffffff', weight: 11, opacity: 0.95, zIndex: 40 }));
    groups.route.add(
      view?.polyline({
        path,
        color: sel ? color : '#8a99ad',
        weight: sel ? 7 : 6,
        opacity: sel ? 1 : 0.75,
        zIndex: sel ? 45 : 35,
        onClick: () => {
          state.routeIdx = i;
          renderRoutes();
        },
      }),
    );
  }
  $('nav-buttons').classList.remove('hidden');
  renderQuickPicks();
  renderDepartNote();
  const notes = [];
  if (state.mode === 'driving') {
    if (state.via.length > 1) notes.push('高德網頁版只帶第 1 個途經點；高德 App 帶全部途經點。');
    if (state.via.length) notes.push('Apple 地圖不支援途經點，只會導航到終點。');
  }
  if (state.mode === 'transit') {
    notes.push('火車的「鐵路線」是依停靠站推測的，可能與實際線路略有出入；停靠站與時刻由高德提供。');
    if (state.transitStrategy === 'rail_first') notes.push('「鐵路優先」是本站自訂排序（高德沒有這個選項）：把含火車的方案排前面。');
  }
  if (state.mode === 'electrobike') notes.push('Apple 地圖沒有電動車模式，會以駕車導航代替。');
  notes.push('導航 App 會自行重新規劃路線，結果可能和這裡略有不同。');
  $('nav-note').textContent = notes.join(' ');
  $('nav-note').classList.remove('hidden');
  if (fit) {
    const r = state.routes[state.routeIdx];
    view?.fit(r.polyline.map(([lng, lat]) => ({ lng, lat })), mapPad());
  }
  loadArriveWeather();
}

/* ---- 抵達時天氣（v4.2）：駕車路線的終點、以預計抵達時刻對 hourly 預報取值 ---- */
let arriveCtrl = null;
async function loadArriveWeather() {
  const box = $('route-arrive');
  const dest = state.dest;
  const r = state.mode === 'driving' && state.routes.length ? state.routes[state.routeIdx] : null;
  if (!r || !dest || !Number.isFinite(r.duration) || dest.isCurrentLocation) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const idx = state.routeIdx;
  arriveCtrl?.abort();
  arriveCtrl = new AbortController();
  try {
    const w = await loadWeather(dest.lng, dest.lat, { signal: arriveCtrl.signal });
    if (state.mode !== 'driving' || state.routeIdx !== idx || !state.routes.length) return;
    const etaMs = (state.depart ?? Math.floor(Date.now() / 1000)) * 1000 + r.duration * 1000;
    box.innerHTML = arrivalWeatherHtml(w.hourly || [], etaMs);
    box.classList.toggle('hidden', !box.innerHTML);
  } catch (e) {
    if (e.name !== 'AbortError' && state.routeIdx === idx) {
      box.classList.add('hidden');
      box.innerHTML = '';
    }
  }
}

function renderQuickPicks() {
  const box = $('route-quick');
  const picks = state.mode === 'driving' ? quickPicks(state.routes) : [];
  box.classList.toggle('hidden', !picks.length);
  box.innerHTML = '';
  for (const p of picks) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-checked', String(p.index === state.routeIdx));
    b.textContent = p.label;
    b.addEventListener('click', () => {
      state.routeIdx = p.index;
      renderRoutes(true);
    });
    box.appendChild(b);
  }
}
function renderDepartNote() {
  const m = state.routeMeta || {};
  const notes = [];
  if (m.tollNote === 'no_toll_free') notes.push('找不到完全不收費的路線，下列路線仍有收費路段。');
  if (m.depart && state.mode === 'driving') {
    notes.push('你設定了出發時間，但高德個人金鑰不提供「預測出發時間」的路況（官方只開放企業帳號）。駕車時間是以現在的即時路況估算，「抵達」時刻＝出發時間＋行駛時間，實際可能不同。');
  } else if (m.depart && state.mode === 'transit') notes.push('公交／火車方案是以你設定的出發時間查詢的班次。');
  $('route-depart-note').textContent = notes.join(' ');
  $('route-depart-note').classList.toggle('hidden', !notes.length);
}

/* ---- 交給導航 App ---- */
function navArgs() {
  const strategy = state.avoidToll ? 'avoid_tolls' : state.avoidHighway ? 'no_highway' : 'recommend';
  return { start: state.start, dest: state.dest, via: state.mode === 'driving' ? state.via.filter(Boolean) : [], strategy, mode: state.mode };
}
$('nav-amap').addEventListener('click', () => {
  if (!state.dest) return;
  const web = amapWebUrl(navArgs());
  if (platform.isIOS) {
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') window.location.href = web;
    }, 1600);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && clearTimeout(t), { once: true });
    window.location.href = amapIosUri(navArgs());
  } else if (platform.isMobile) window.location.href = web;
  else window.open(web, '_blank', 'noopener');
});
$('nav-apple').addEventListener('click', () => {
  if (!state.dest) return;
  const url = appleMapsUrl(navArgs());
  if (platform.isMobile) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
});

/* ---------------- 搜尋附近：廁所／加油站／充電站 ---------------- */
let nearbyKind = null;
let nearbyItems = [];
let nearbyCtrl;
let nearbyAuto = false;
let nearbyBase = null;
function nearbyCenter(forceMap) {
  const c = centerOf();
  if (!forceMap && state.me && haversine(state.me.lng, state.me.lat, c.lng, c.lat) < 5000) return { lng: state.me.lng, lat: state.me.lat };
  return c;
}
function clearNearby() {
  nearbyKind = null;
  nearbyAuto = false;
  nearbyItems = [];
  nearbyCtrl?.abort();
  groups?.nearby.clear();
}
function renderNearbyKinds() {
  const box = $('nearby-kinds');
  if (!box.children.length) {
    for (const [k, v] of Object.entries(NEARBY)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.kind = k;
      b.textContent = `${v.emoji} ${v.label}`;
      b.addEventListener('click', () => runNearby(k));
      box.appendChild(b);
    }
  }
  box.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.kind === nearbyKind)));
}
async function runNearby(kind, { forceMap = false, auto = false } = {}) {
  nearbyKind = kind;
  const info = NEARBY[kind];
  $('nearby-title').textContent = `附近的${info.label}`;
  renderNearbyKinds();
  if (!auto) {
    $('nearby-list').innerHTML = '';
    groups?.nearby.clear();
    setStatus('nearby-status', '搜尋中…');
    showView('nearby');
    setSnap('half');
  } else setStatus('nearby-status', '更新此區域…');
  nearbyAuto = true;
  nearbyCtrl?.abort();
  nearbyCtrl = new AbortController();
  const { signal } = nearbyCtrl;
  const snap = viewSnapshot();
  // 自動更新：用目前地圖範圍（以地圖中心為準）；第一次：以我的位置或地圖中心，3 公里 → 10 公里
  const center = auto ? snap.center : nearbyCenter(forceMap);
  try {
    let radius = auto ? snap.radius : 3000;
    let data = await api.nearby({ kind, center, radius }, { signal });
    if (!data.results.length && !auto) {
      radius = 10000;
      data = await api.nearby({ kind, center, radius }, { signal });
    }
    if (signal.aborted) return;
    nearbyItems = data.results;
    nearbyBase = auto ? snap : { ...(snap || {}), center: snap?.center ?? center, radius: snap?.radius ?? radius };
    if (!auto) suppressArea();
    const rText = radius >= 1000 ? `${+(radius / 1000).toFixed(1)} 公里` : `${radius} 公尺`;
    if (!nearbyItems.length) {
      $('nearby-list').innerHTML = '';
      groups?.nearby.clear();
      return setStatus('nearby-status', `${rText}內找不到${info.label}${auto ? '，拖曳或縮放地圖再試' : ''}`);
    }
    setStatus('nearby-status', `${rText}內找到 ${nearbyItems.length} 個${info.label}，依距離排序${auto ? '' : '；拖曳或縮放地圖會自動更新'}`);
    renderNearby(center, { fit: !auto });
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('nearby-status', e.message || '搜尋失敗', true);
  }
}
function renderNearby(center, { fit = true } = {}) {
  const ul = $('nearby-list');
  ul.innerHTML = '';
  const info = NEARBY[nearbyKind];
  nearbyItems.forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ico">${info.emoji}</span><div class="body"><div class="name">${esc(r.name)}</div><div class="sub">${esc([r.address, r.openToday ? '今日 ' + r.openToday : ''].filter(Boolean).join(' · '))}</div></div>${r.distance != null ? `<div class="dist">${formatDistance(r.distance)}</div>` : ''}`;
    li.addEventListener('click', () => pickNearby(i));
    ul.appendChild(li);
    groups?.nearby.add(view?.marker({ lng: r.lng, lat: r.lat, html: emojiHtml(info.emoji), zIndex: 110, title: r.name, onClick: () => pickNearby(i) }));
  });
  if (fit) view?.fit([center, ...nearbyItems.slice(0, 8)].map((r) => ({ lng: r.lng, lat: r.lat })), mapPad());
}
function pickNearby(i) {
  const r = nearbyItems[i];
  if (!r) return;
  if (state.picking) return assignStop(state.picking, toStop({ ...r, kind: 'poi' }));
  suppressArea();
  showPlace(toStop({ ...r, kind: 'poi' }), { addr: r.address || '', zoom: 16, data: r });
}
document.querySelectorAll('#nearby-grid [data-kind]').forEach((b) => b.addEventListener('click', () => runNearby(b.dataset.kind)));
const closeNearby = () => {
  clearNearby();
  showSearchHome();
  setSnap(state.picking ? 'full' : 'half');
};
$('nearby-close').addEventListener('click', closeNearby);
$('nearby-back').addEventListener('click', closeNearby);
$('nearby-here').addEventListener('click', () => nearbyKind && runNearby(nearbyKind, { forceMap: true }));

/* ---------------- 收藏（只在「我的」裡，地圖上不放星號） ---------------- */
let syncTimer;
function renderFavs() {
  const ul = $('fav-list');
  ul.innerHTML = '';
  const items = store.live();
  $('favs-count').textContent = items.length ? `${items.length} 個` : '';
  setStatus('favs-status', items.length ? '' : '還沒有收藏。點地圖或搜尋地點，在地點卡按「收藏」就會出現在這裡。');
  for (const f of items) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="ico fav">★</span><div class="body"><div class="name">${esc(f.name)}</div><div class="sub">${esc(f.address || '')}</div></div><button type="button" class="del" aria-label="刪除收藏"><svg><use href="#i-trash" /></svg></button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) {
        store.remove(f.id);
        afterFavChange();
        return;
      }
      const stop = { lng: f.lng, lat: f.lat, name: f.name };
      if (state.picking) return assignStop(state.picking, stop);
      state.placeFrom = 'account';
      showPlace(stop, { addr: f.address || '', zoom: 15 });
    });
    ul.appendChild(li);
  }
}
function renderPlaceFav() {
  if (!placeStop || placeStop.isCurrentLocation) return;
  const on = !!findSamePlace(store.all(), placeStop.lng, placeStop.lat);
  $('place-fav').querySelector('span').textContent = on ? '已收藏' : '收藏';
  $('place-fav').querySelector('use').setAttribute('href', on ? '#i-star-fill' : '#i-star');
  $('place-fav').classList.toggle('on', on);
  $('place-fav').setAttribute('aria-pressed', String(on));
}
function afterFavChangeNoSync() {
  renderFavs();
  renderPlaceFav();
}
function afterFavChange() {
  afterFavChangeNoSync();
  if (state.user) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow({ quiet: true }), 1500);
  }
}
$('place-fav').addEventListener('click', () => {
  if (!placeStop) return;
  const hit = findSamePlace(store.all(), placeStop.lng, placeStop.lat);
  if (hit) {
    store.remove(hit.id);
    toast('已取消收藏');
  } else {
    store.add({ name: placeStop.name, lng: placeStop.lng, lat: placeStop.lat, address: $('place-addr').textContent });
    toast('已加入收藏（在右下方「我的」可以看到）');
    navigator.storage?.persist?.().catch(() => {});
  }
  afterFavChange();
});
$('fav-export').addEventListener('click', () => {
  const blob = new Blob([store.exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `world-map-favorites-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$('fav-import').addEventListener('click', () => $('fav-import-file').click());
$('fav-import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const n = store.importJson(await file.text());
    toast(`已匯入 ${n} 個收藏`);
    afterFavChange();
  } catch (err) {
    toast(err.message || '匯入失敗：檔案格式不正確');
  }
});

/* ---------------- 我的：帳號與收藏 ---------------- */
let loginEmail = '';
function openAccount() {
  state.placeFrom = 'search';
  renderAccount();
  renderFavs();
  setStatus('account-status2', '');
  showView('account');
  setSnap('half');
}
function renderAccount() {
  const enabled = !!state.config?.features?.auth;
  const user = state.user;
  $('profile-name').textContent = user ? user.email : '訪客';
  $('account-status').textContent = user ? '已登入，收藏會跨裝置同步' : enabled ? '未登入：收藏只存在這台裝置' : '收藏只存在這台裝置（信箱登入尚未啟用）';
  $('btn-avatar').classList.toggle('in', !!user);
  $('account-disabled').classList.toggle('hidden', enabled || !!user);
  $('login-form').classList.toggle('hidden', !enabled || !!user || !$('code-form').classList.contains('hidden'));
  $('account-in').classList.toggle('hidden', !user);
  if (user) $('code-form').classList.add('hidden');
}
async function syncNow({ quiet = false } = {}) {
  if (!state.user) return;
  try {
    const out = await api.syncFavorites(store.all());
    store.replaceAll(out.items);
    afterFavChangeNoSync();
    if (!quiet) setStatus('account-status2', `已同步（${store.live().length} 個收藏）`);
  } catch (e) {
    if (e.status === 401) {
      state.user = null;
      renderAccount();
      onHeatAuth();
    }
    if (!quiet) setStatus('account-status2', e.message || '同步失敗', true);
  }
}
$('btn-avatar').addEventListener('click', openAccount);
$('account-close').addEventListener('click', () => {
  showSearchHome();
  setSnap('peek');
});
$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('login-email').value.trim();
  if (!email) return;
  $('login-send').disabled = true;
  setStatus('account-status2', '寄送中…');
  try {
    await api.requestCode(email);
    loginEmail = email;
    $('code-hint').textContent = `驗證碼已寄到 ${email}（10 分鐘內有效）。沒收到請看垃圾郵件匣。`;
    $('login-form').classList.add('hidden');
    $('code-form').classList.remove('hidden');
    setStatus('account-status2', '');
    $('login-code').focus();
  } catch (err) {
    const wait = err.retryAfter ? `（請 ${err.retryAfter} 秒後再試）` : '';
    setStatus('account-status2', (err.message || '寄送失敗') + wait, true);
  } finally {
    $('login-send').disabled = false;
  }
});
$('code-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('code-verify').disabled = true;
  try {
    const out = await api.verifyCode(loginEmail, $('login-code').value.trim());
    state.user = out.user;
    $('login-code').value = '';
    $('code-form').classList.add('hidden');
    renderAccount();
    onHeatAuth();
    setStatus('account-status2', '登入成功，同步中…');
    await syncNow();
  } catch (err) {
    setStatus('account-status2', err.message || '驗證失敗', true);
  } finally {
    $('code-verify').disabled = false;
  }
});
$('code-back').addEventListener('click', () => {
  $('code-form').classList.add('hidden');
  $('login-form').classList.remove('hidden');
  setStatus('account-status2', '');
});
$('btn-sync').addEventListener('click', () => syncNow());
$('btn-logout').addEventListener('click', async () => {
  try {
    await api.logout();
  } catch {
    /* 略過 */
  }
  state.user = null;
  renderAccount();
  onHeatAuth();
  setStatus('account-status2', '已登出（這台裝置上的收藏仍保留）');
});
async function loadAccount() {
  try {
    const out = await api.authMe();
    state.user = out.user || null;
  } catch {
    state.user = null;
  }
  renderAccount();
  if (state.user) syncNow({ quiet: true });
  onHeatAuth();
}

/* ---------------- 分享位置／標記我的位置 ---------------- */
let shareCur = null;
function openShare({ lng, lat, name }) {
  const url = amapMarkerUrl({ lng, lat, name });
  shareCur = { name, url, text: shareMessage({ name, url }) };
  $('share-name').textContent = name;
  $('share-link').value = url;
  $('share-native').classList.toggle('hidden', typeof navigator.share !== 'function');
  $('share-sms').href = smsHref(shareCur.text, platform);
  $('share-sms').classList.toggle('hidden', !platform.isMobile);
  $('share-clear').classList.toggle('hidden', !(groups?.mark.size > 0));
  $('share-modal').classList.remove('hidden');
}
const closeShare = () => $('share-modal').classList.add('hidden');
$('share-close').addEventListener('click', closeShare);
$('share-modal').addEventListener('click', (e) => e.target === $('share-modal') && closeShare());
$('share-native').addEventListener('click', async () => {
  if (!shareCur) return;
  try {
    await navigator.share({ title: shareCur.name, text: shareCur.text, url: shareCur.url });
  } catch (e) {
    if (e?.name !== 'AbortError') toast('無法開啟系統分享，請改用「簡訊」或「複製連結」');
  }
});
$('share-copy').addEventListener('click', async () => {
  if (!shareCur) return;
  toast((await copyText(shareCur.url)) ? '已複製連結' : '無法自動複製，請長按連結欄位手動複製');
});
$('share-link').addEventListener('focus', (e) => e.target.select());
$('share-clear').addEventListener('click', () => {
  groups?.mark.clear();
  closeShare();
});
async function markMyLocation() {
  const me = state.me || (await locate({ pan: true }));
  if (!me) return;
  groups?.mark.clear();
  groups?.mark.add(view?.marker({ lng: me.lng, lat: me.lat, html: pinHtml('dest', '我'), anchor: 'bottom-center', zIndex: 260, title: '我標記的位置' }));
  openShare({ lng: me.lng, lat: me.lat, name: '我的位置' });
}

/* ---------------- 熱力圖：人口密度、即時路況、我的足跡 ---------------- */
let popLayer = null;
let popStore = null;
let popTimer = null;
let trafficLayer = null;
let footHeat = null;
let footWatch = null;
let footPoints = [];
let footLastSent = null;
let heatSeq = 0;
let footLoadedFor = null;

function mapHas(layer) {
  try {
    return (view?.map.getLayers?.() ?? []).includes(layer);
  } catch {
    return false;
  }
}
function addMapLayer(layer) {
  if (layer && view && !mapHas(layer)) view.map.add(layer);
}
function removeMapLayer(layer) {
  if (layer && view && mapHas(layer)) view.map.remove(layer);
}
function loadHeatPlugin(AMap) {
  if (AMap.HeatMap) return Promise.resolve(AMap.HeatMap);
  return new Promise((resolve, reject) => {
    AMap.plugin(['AMap.HeatMap'], () => (AMap.HeatMap ? resolve(AMap.HeatMap) : reject(new Error('熱力圖元件載入失敗'))));
  });
}
function renderHeat() {
  const h = state.heat;
  const logged = !!state.user;
  $('opt-pop').setAttribute('aria-checked', String(h.pop));
  $('opt-traffic').setAttribute('aria-checked', String(h.traffic));
  $('opt-foot').setAttribute('aria-checked', String(h.foot));
  $('opt-foot-rec').setAttribute('aria-checked', String(h.footRec && logged));
  $('pop-opacity').value = String(h.popOpacity);
  $('pop-extra').classList.toggle('hidden', !h.pop);
  $('traffic-legend').classList.toggle('hidden', !h.traffic);
  $('foot-extra').classList.toggle('hidden', !h.foot);
  $('foot-login').classList.toggle('hidden', !h.foot || logged);
  $('foot-tools').classList.toggle('hidden', !h.foot || !logged);
  document.querySelectorAll('#foot-range [data-range]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.range === h.footRange)));
  const hudOn = h.pop || h.traffic;
  $('heat-hud').classList.toggle('hidden', !hudOn);
  $('heat-hud-pop').classList.toggle('hidden', !h.pop);
  $('heat-hud-traffic').classList.toggle('hidden', !h.traffic);
  updateAttrib();
}
async function syncFootHeat() {
  if (!view || !state.heat.foot || !state.user) {
    footHeat?.hide?.();
    return;
  }
  const Heat = await loadHeatPlugin(view.AMap);
  if (!footHeat) {
    const z = view.getZoom();
    const lat = view.getCenter().lat;
    footHeat = new Heat(view.map, {
      radius: footprintRadiusPx(z, lat),
      opacity: footprintHeatOpacity(z),
      gradient: footprintGradient(),
      zooms: [3, 20],
      zIndex: 90,
    });
  }
  tuneFootHeat();
  const shown = filterPoints(footPoints, state.heat.footRange);
  const { data, max } = toHeatData(shown, wgs84ToGcj02);
  footHeat.setDataSet({ data, max });
  footHeat.show();
}
async function refreshFootprint() {
  if (!state.user) {
    footPoints = [];
    footLoadedFor = null;
    return;
  }
  const out = await api.footprint();
  footPoints = Array.isArray(out.points) ? out.points : [];
  footLoadedFor = state.user.email;
}
function syncRecorder() {
  const want = !!(state.heat.footRec && state.user && document.visibilityState !== 'hidden' && navigator.geolocation);
  if (!want) {
    if (footWatch != null) navigator.geolocation.clearWatch(footWatch);
    footWatch = null;
    return;
  }
  if (footWatch != null) return;
  footWatch = navigator.geolocation.watchPosition(
    (pos) => {
      const next = { lng: pos.coords.longitude, lat: pos.coords.latitude, t: Date.now() };
      if (!shouldRecord(footLastSent, next, next.t)) return;
      const pending = next;
      api.footprintAdd([pending]).then((out) => {
        footLastSent = pending;
        if (Array.isArray(out.points)) footPoints = out.points;
        if (state.heat.foot) syncFootHeat().catch(() => {});
      }).catch((e) => {
        if (e.status === 401 || e.code === 'login_required') {
          state.heat.footRec = false;
          state.user = null;
          saveHeatPref();
          syncRecorder();
          renderAccount();
          renderHeat();
          toast('登入已失效，已停止記錄足跡');
        }
      });
    },
    () => {
      state.heat.footRec = false;
      saveHeatPref();
      syncRecorder();
      renderHeat();
      toast('沒有取得定位權限，已關閉記錄');
    },
    { enableHighAccuracy: true, maximumAge: 15000, timeout: 25000 },
  );
}
async function applyHeat() {
  const seq = ++heatSeq;
  renderHeat();
  if (!view) {
    syncRecorder();
    return;
  }
  try {
    if (state.heat.pop) {
      popStore ??= createPopulationStore();
      if (!popLayer) popLayer = createPopulationLayer(view.AMap, popStore, { opacity: state.heat.popOpacity / 100 });
      popLayer.setOpacity?.(state.heat.popOpacity / 100);
      addMapLayer(popLayer);
      if (seq !== heatSeq) return;
      await refreshPop(true);
    } else if (popLayer) {
      removeMapLayer(popLayer);
    }
    if (state.heat.traffic) {
      if (!trafficLayer) trafficLayer = createTrafficLayer(view.AMap);
      addMapLayer(trafficLayer);
    } else if (trafficLayer) {
      removeMapLayer(trafficLayer);
    }
    if (state.heat.foot && state.user) {
      if (footLoadedFor !== state.user.email) await refreshFootprint();
      if (seq !== heatSeq) return;
      await syncFootHeat();
    } else {
      footHeat?.hide?.();
    }
  } catch (e) {
    if (seq === heatSeq) toast(e.message || '熱力圖載入失敗');
  }
  if (seq === heatSeq) syncRecorder();
}
function tuneFootHeat() {
  if (!footHeat || !view || !state.heat.foot) return;
  const z = view.getZoom();
  footHeat.setOptions?.({ radius: footprintRadiusPx(z, view.getCenter().lat), opacity: footprintHeatOpacity(z) });
}
function schedulePop() {
  if (!state.heat.pop || !view) return;
  clearTimeout(popTimer);
  popTimer = setTimeout(() => refreshPop(false), 180);
}
async function refreshPop(immediate) {
  if (!state.heat.pop || !view) return;
  popStore ??= createPopulationStore();
  try {
    const level = await popStore.loadView(boundsToWgs(view.getBounds()), view.getZoom());
    $('pop-note').textContent = populationNote(level);
    if (popLayer?.reload) popLayer.reload();
    else if (immediate && popLayer) {
      removeMapLayer(popLayer);
      addMapLayer(popLayer);
    }
  } catch (e) {
    toast(e.message || '人口密度載入失敗');
  }
}
function onHeatAuth() {
  if (!state.user) {
    footPoints = [];
    footLoadedFor = null;
    footLastSent = null;
  }
  applyHeat();
}
$('pop-legend').innerHTML = populationLegendHtml();
$('pop-note').textContent = populationNote(null);
$('traffic-legend').innerHTML = trafficLegendHtml();
$('heat-hud-traffic').innerHTML = TRAFFIC_LEGEND.map((s) => `<span class="tl"><i style="background:${s.color}"></i>${s.name}</span>`).join('');
$('heat-hud-pop-bar').style.background = `linear-gradient(90deg,${DENSITY_STOPS.map((s) => s.hex).join(',')})`;
$('foot-bg-note').textContent = FOOT_BACKGROUND;
$('foot-privacy').textContent = FOOT_PRIVACY;
// 整列都能點（名稱或開關）。只聽 click：再加 pointerup 會在 iOS 上連點兩次，看起來像沒反應。
$('layer-heat').addEventListener('click', (e) => {
  const row = e.target.closest('.opt-row');
  const sw = row ? [...row.children].find((el) => el.classList?.contains('switch')) : null;
  if (!row || !sw || !$('layer-heat').contains(row)) return;
  if (e.target.closest('input, a, .seg-ctl')) return;
  if (sw.id === 'opt-foot-rec') {
    if (!state.user) {
      toast('請先登入。足跡只會記在你自己的帳號');
      return;
    }
    state.heat.footRec = !state.heat.footRec;
    saveHeatPref();
    renderHeat();
    syncRecorder();
    if (state.heat.footRec) toast('開始記錄足跡。這個分頁在背景或關掉後就不會再記。');
    return;
  }
  if (sw.id === 'opt-pop') state.heat.pop = !state.heat.pop;
  else if (sw.id === 'opt-traffic') state.heat.traffic = !state.heat.traffic;
  else if (sw.id === 'opt-foot') state.heat.foot = !state.heat.foot;
  else return;
  saveHeatPref();
  applyHeat();
});
$('pop-opacity').addEventListener('input', () => {
  const n = Number($('pop-opacity').value);
  if (!Number.isFinite(n)) return;
  state.heat.popOpacity = n;
  popLayer?.setOpacity?.(n / 100);
  saveHeatPref();
});
$('foot-range').addEventListener('click', (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  state.heat.footRange = b.dataset.range;
  saveHeatPref();
  renderHeat();
  syncFootHeat().catch(() => {});
});
$('foot-login-btn').addEventListener('click', () => {
  $('layer-modal').classList.add('hidden');
  openAccount();
});
$('foot-clear').addEventListener('click', async () => {
  if (!state.user) return;
  if (!confirm('清除這個帳號上的全部足跡？清除後無法還原。')) return;
  try {
    await api.footprintClear();
    footPoints = [];
    footLastSent = null;
    await syncFootHeat();
    toast('已清除我的足跡');
  } catch (e) {
    toast(e.message || '清除失敗');
  }
});
document.addEventListener('visibilitychange', () => syncRecorder());

/* ---------------- 啟動 ---------------- */
window.__worldMap = { vvState, state, view: null, assignStop, planRoute, doSearch, setSnap, openRoute, setMode, runNearby, openShare, openAccount, store, showPlace, selectPoint, showMyLocationCard, set3D, applyLayer, applyHeat, refreshEnv, env, envState };
loadLayerPref();
loadHeatPref();
renderHeat();
showSearchHome();
setSnap('peek');
function onViewportChange() {
  syncViewport();
  if (vvState.kb && (window.scrollY || window.pageYOffset)) window.scrollTo(0, 0); // 阻止 Safari 為了露出輸入框而捲動整頁
  sheet.refresh();
}
window.addEventListener('resize', onViewportChange);
window.visualViewport?.addEventListener('resize', onViewportChange);
window.visualViewport?.addEventListener('scroll', onViewportChange);
document.addEventListener('focusin', () => setTimeout(onViewportChange, 60));
document.addEventListener('focusout', () => setTimeout(onViewportChange, 60));
renderFavs();
(async () => {
  try {
    state.config = await api.config();
  } catch {
    state.config = { features: {} };
  }
  renderAccount();
  loadAccount();
  await initMap();
  applyHeat();
  if (navigator.permissions?.query) {
    navigator.permissions
      .query({ name: 'geolocation' })
      .then((p) => p.state === 'granted' && locate({ quiet: true, pan: true }))
      .catch(() => {});
  }
})();
