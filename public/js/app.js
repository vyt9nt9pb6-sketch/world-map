// World Map v2 — 前端主程式
// 座標約定：畫面上所有點（地圖、搜尋結果、路線）都是 GCJ-02；只有瀏覽器定位是 WGS-84，取得後立刻轉換。
import { wgs84ToGcj02, haversine } from './lib/coords.js';
import { api } from './lib/api.js';
import { layerPlan, SUBDOMAINS, ATTRIBUTION } from './lib/layers.js';
import { formatDistance, formatDuration, formatYuan } from './lib/format.js';
import { amapIosUri, amapWebUrl, appleMapsUrl, detectPlatform } from './lib/navlinks.js';
import { amapMarkerUrl, shareMessage, smsHref, copyText } from './lib/share.js';
import { createTiandituLayer } from './lib/tianditu.js';
import { createStore, findSamePlace } from './lib/favstore.js';
import { transitSummary, transitDetail, esc } from './lib/transit-view.js';

const L = window.L;
const $ = (id) => document.getElementById(id);
const platform = detectPlatform();
const isDesktop = () => window.matchMedia('(min-width: 900px)').matches;

const STRATEGIES = [
  { id: 'recommend', label: '推薦' },
  { id: 'fastest', label: '速度優先' },
  { id: 'avoid_tolls', label: '避免收費' },
  { id: 'highway', label: '高速優先' },
  { id: 'no_highway', label: '不走高速' },
];

const TRANSIT_STRATEGIES = [
  { id: 'recommend', label: '推薦' },
  { id: 'fastest', label: '最快' },
  { id: 'least_transfer', label: '少換乘' },
  { id: 'least_walk', label: '少步行' },
  { id: 'subway_first', label: '地鐵優先' },
  { id: 'cheapest', label: '最省錢' },
];
const MODES = {
  driving: { label: '駕車路線', color: '#1f6feb' },
  transit: { label: '公交／火車路線', color: '#1f6feb' },
  walking: { label: '步行路線', color: '#0e9f6e' },
  bicycling: { label: '騎行路線', color: '#d97706' },
  electrobike: { label: '電動車路線', color: '#7c3aed' },
};
const SEG_STYLE = {
  walk: { color: '#64748b', weight: 5, dashArray: '2 9', opacity: 1 },
  bus: { color: '#1f6feb', weight: 7, opacity: 1 },
  subway: { color: '#7c3aed', weight: 7, opacity: 1 },
  train: { color: '#b91c1c', weight: 7, opacity: 1 },
};
const NEARBY = {
  toilet: { label: '廁所', emoji: '🚻' },
  gas: { label: '加油站', emoji: '⛽' },
  ev: { label: '充電站', emoji: '🔌' },
};

const DEFAULT_CENTER = { lng: 119.3389, lat: 34.7603 }; // 連雲港市連雲區（GCJ-02）
const MY_LOCATION = Object.freeze({ isCurrentLocation: true, name: '我的位置' });

const state = {
  baseLayer: 'standard',
  satLabels: true,
  me: null, // { lng, lat, accuracy } GCJ-02
  results: [],
  selectedIdx: -1,
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
  routeOpen: false,
};
const store = createStore();

/* ---------------- 地圖 ---------------- */
const map = L.map('map', {
  center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
  zoom: 12,
  minZoom: 3,
  maxZoom: 19,
  zoomControl: false,
  attributionControl: true,
  tap: false,
});
map.attributionControl.setPrefix(false);
if (isDesktop()) L.control.zoom({ position: 'bottomright', zoomInTitle: '放大', zoomOutTitle: '縮小' }).addTo(map);

const plan = layerPlan(window.devicePixelRatio || 1);
function makeTile(def) {
  const opts = {
    subdomains: SUBDOMAINS,
    maxZoom: 19,
    maxNativeZoom: def.maxNativeZoom,
    zIndex: def.zIndex,
    attribution: def.overlay ? undefined : ATTRIBUTION,
    detectRetina: !!def.retinaTrick,
    crossOrigin: false,
  };
  return L.tileLayer(def.url, opts);
}
const layers = {
  standard: L.layerGroup(plan.standard.map(makeTile)),
  satellite: L.layerGroup(plan.satellite.map(makeTile)),
  satLabels: makeTile(plan.satelliteLabels),
  tianditu: null, // 取得 /api/config 且有 tk 之後才建立
  tdtLabels: null,
};
layers.standard.addTo(map);

function applyLayers() {
  for (const l of [layers.standard, layers.satellite, layers.satLabels, layers.tianditu, layers.tdtLabels]) l && map.hasLayer(l) && map.removeLayer(l);
  const b = state.baseLayer;
  if (b === 'satellite') {
    layers.satellite.addTo(map);
    if (state.satLabels) layers.satLabels.addTo(map);
  } else if (b === 'tianditu' && layers.tianditu) {
    layers.tianditu.addTo(map);
    if (state.satLabels) layers.tdtLabels.addTo(map);
  } else {
    state.baseLayer = 'standard';
    layers.standard.addTo(map);
  }
  const sat = state.baseLayer !== 'standard';
  $('layer-label').textContent = state.baseLayer === 'tianditu' ? '天地圖' : sat ? '衛星' : '標準';
  $('btn-labels').classList.toggle('hidden', !sat);
  $('btn-labels').setAttribute('aria-pressed', String(state.satLabels));
  document.querySelectorAll('#layer-menu [data-layer]').forEach((el) => el.setAttribute('aria-checked', String(el.dataset.layer === state.baseLayer)));
}
$('btn-layer').addEventListener('click', () => $('layer-menu').classList.toggle('hidden'));
$('layer-menu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-layer]');
  if (!b || b.disabled) return;
  if (b.dataset.layer === '3d') {
    const c = map.getCenter();
    location.href = `/3d.html?lng=${c.lng.toFixed(6)}&lat=${c.lat.toFixed(6)}&z=${Math.min(19, Math.max(3, map.getZoom()))}`;
    return;
  }
  state.baseLayer = b.dataset.layer;
  applyLayers();
  $('layer-menu').classList.add('hidden');
});
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#layer-menu, #btn-layer')) $('layer-menu').classList.add('hidden');
});
$('btn-labels').addEventListener('click', () => {
  state.satLabels = !state.satLabels;
  applyLayers();
});

/** 依 /api/config 啟用或停用需要金鑰的功能；沒設定就優雅地關閉 */
function applyConfig(cfg) {
  state.config = cfg;
  const f = cfg?.features || {};
  if (f.tianditu && cfg.tianditu?.tk && !layers.tianditu) {
    layers.tianditu = createTiandituLayer(L, { tk: cfg.tianditu.tk, kind: 'imagery' });
    layers.tdtLabels = createTiandituLayer(L, { tk: cfg.tianditu.tk, kind: 'labels' });
  }
  const tdt = $('layer-tianditu');
  tdt.disabled = !layers.tianditu;
  $('tianditu-note').textContent = layers.tianditu ? '天地圖' : '尚未啟用';
  const d3 = $('layer-3d');
  d3.disabled = !f.amap3d;
  $('amap3d-note').textContent = f.amap3d ? '高德' : '尚未啟用';
  applyLayers();
  renderAccount();
}
map.attributionControl.addAttribution('鐵路線 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> (ODbL)');

const resultLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);
const favLayer = L.layerGroup().addTo(map);
const markLayer = L.layerGroup().addTo(map);
const clusterLayer = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 48, disableClusteringAtZoom: 18 }).addTo(map);

function emojiIcon(emoji, cls = '') {
  return L.divIcon({ className: '', html: `<div class="emo-pin ${cls}">${emoji}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] });
}
function pinIcon(cls, text) {
  return L.divIcon({
    className: '',
    html: `<div class="pin ${cls}"><span></span><b>${escapeHtml(text)}</b></div>`,
    iconSize: [30, 38],
    iconAnchor: [15, 38],
  });
}

/* ---------------- 工具 ---------------- */
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
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
const centerOf = () => {
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat };
};

/* ---------------- 底部面板 ---------------- */
const sheet = $('sheet');
const SNAPS = ['peek', 'half', 'full'];
function setSnap(s) {
  if (isDesktop()) return;
  sheet.dataset.snap = s;
  const visible = s === 'peek' ? 'var(--peek)' : s === 'half' ? '52dvh' : '92dvh';
  document.documentElement.style.setProperty('--sheet-visible', visible);
  $('fab-bottom').classList.toggle('hidden', s === 'full');
}
(function setupDrag() {
  let startY = 0;
  let startT = 0;
  let dragging = false;
  let baseOffset = 0;
  const handle = $('sheet-handle');
  const currentOffset = () => new DOMMatrixReadOnly(getComputedStyle(sheet).transform).m42;
  const onDown = (e) => {
    if (isDesktop()) return;
    // 只在把手或面板頂部的空白處拖曳；按鈕／輸入框／清單照常操作
    if (e.target !== handle && !handle.contains(e.target) && e.target.closest('button,input,a,li,.chips')) return;
    dragging = true;
    startY = e.clientY;
    startT = performance.now();
    baseOffset = currentOffset();
    sheet.classList.add('dragging');
    sheet.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const max = sheet.offsetHeight - 60;
    sheet.style.transform = `translateY(${Math.min(max, Math.max(0, baseOffset + dy))}px)`;
  };
  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    const dy = e.clientY - startY;
    const v = dy / Math.max(1, performance.now() - startT);
    sheet.style.transform = '';
    const idx = SNAPS.indexOf(sheet.dataset.snap);
    if (Math.abs(dy) < 6) {
      // 點一下把手：在 peek 與 half 間切換
      if (e.target === handle || handle.contains(e.target)) setSnap(idx === 0 ? 'half' : 'peek');
      return;
    }
    if (v < -0.5 || dy < -80) setSnap(SNAPS[Math.min(2, idx + (dy < -260 ? 2 : 1))]);
    else if (v > 0.5 || dy > 80) setSnap(SNAPS[Math.max(0, idx - (dy > 260 ? 2 : 1))]);
    else setSnap(SNAPS[idx]);
  };
  sheet.addEventListener('pointerdown', onDown);
  sheet.addEventListener('pointermove', onMove);
  sheet.addEventListener('pointerup', onUp);
  sheet.addEventListener('pointercancel', onUp);
})();

function fitTo(latlngs) {
  if (!latlngs.length) return;
  const bounds = L.latLngBounds(latlngs);
  const opts = { maxZoom: 16, animate: true };
  if (isDesktop()) {
    opts.paddingTopLeft = [440, 40];
    opts.paddingBottomRight = [80, 40];
  } else {
    const snap = sheet.dataset.snap;
    const sheetPx = snap === 'peek' ? 150 : snap === 'half' ? window.innerHeight * 0.52 : window.innerHeight * 0.6;
    opts.paddingTopLeft = [30, 70];
    opts.paddingBottomRight = [30, sheetPx + 20];
  }
  map.fitBounds(bounds, opts);
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
        const [lng, lat] = wgs84ToGcj02(pos.coords.longitude, pos.coords.latitude); // WGS-84 → GCJ-02
        state.me = { lng, lat, accuracy: pos.coords.accuracy };
        drawMe();
        if (pan) map.setView([lat, lng], Math.max(map.getZoom(), 15));
        resolve(state.me);
      },
      (err) => {
        locating = false;
        $('btn-locate').classList.remove('active');
        if (!quiet) {
          const msg = err.code === 1 ? '沒有定位權限：請在瀏覽器設定中允許取得位置' : err.code === 3 ? '定位逾時，請再試一次' : '無法取得目前位置';
          toast(msg);
        }
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  });
}
function drawMe() {
  meLayer.clearLayers();
  if (!state.me) return;
  const ll = [state.me.lat, state.me.lng];
  if (state.me.accuracy && state.me.accuracy < 2000) {
    L.circle(ll, { radius: state.me.accuracy, color: '#1f6feb', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(meLayer);
  }
  L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), keyboard: false, interactive: false }).addTo(meLayer);
}
$('btn-locate').addEventListener('click', () => {
  if (!locating) locate();
});

/* ---------------- 搜尋 ---------------- */
let searchCtrl;
async function doSearch(q) {
  q = q.trim();
  if (!q) return;
  searchCtrl?.abort();
  searchCtrl = new AbortController();
  const { signal } = searchCtrl;
  setStatus('search-status', '搜尋中…');
  $('results').innerHTML = '';
  resultLayer.clearLayers();
  const center = centerOf();
  const [poi, geo] = await Promise.allSettled([api.search(q, center, { signal }), api.geocode(q, { signal })]);
  if (signal.aborted) return;
  const list = [];
  const pois = poi.status === 'fulfilled' ? poi.value.results : [];
  if (geo.status === 'fulfilled') {
    // 地址解析結果放最前面；若高德只把它當成「興趣點」且已有地點結果，就不重複顯示
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
  setSnap('half');
  fitTo(list.map((r) => [r.lat, r.lng]));
}

function renderResults() {
  const ul = $('results');
  ul.innerHTML = '';
  resultLayer.clearLayers();
  let n = 0;
  state.results.forEach((r, i) => {
    const isAddr = r.kind === 'address';
    const label = isAddr ? '址' : String(++n);
    const li = document.createElement('li');
    li.className = 'result' + (i === state.selectedIdx ? ' selected' : '');
    const sub = isAddr ? `地址 · ${r.level || ''}` : [r.address, [r.city, r.district].filter(Boolean).join('')].filter(Boolean).join(' · ');
    li.innerHTML = `<div class="badge ${isAddr ? 'addr' : ''}">${label}</div>
      <div class="body"><div class="name">${escapeHtml(r.name)}</div><div class="sub">${escapeHtml(sub)}</div></div>
      ${r.distance != null ? `<div class="dist">${formatDistance(r.distance)}</div>` : ''}`;
    li.addEventListener('click', () => selectResult(i));
    ul.appendChild(li);
    L.marker([r.lat, r.lng], { icon: pinIcon((isAddr ? 'addr ' : '') + (i === state.selectedIdx ? 'selected' : ''), label), title: r.name })
      .on('click', () => selectResult(i))
      .addTo(resultLayer);
  });
}

function toStop(r) {
  return { lng: r.lng, lat: r.lat, name: r.name, poiId: r.kind === 'poi' ? r.id : undefined };
}

function selectResult(i) {
  const r = state.results[i];
  if (!r) return;
  state.selectedIdx = i;
  if (state.picking) {
    assignStop(state.picking, toStop(r));
    return;
  }
  renderResults();
  showPlace(toStop(r), r.kind === 'address' ? r.address : [r.address, r.city + r.district].filter(Boolean).join(' · '));
  map.setView([r.lat, r.lng], Math.max(map.getZoom(), 15));
}

let placeStop = null;
function showPlace(stop, addr) {
  placeStop = stop;
  if (state.view !== 'place') state.placeFrom = state.view;
  $('place-name').textContent = stop.name;
  $('place-addr').textContent = addr || `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`;
  renderPlaceFav();
  showView('place');
  setSnap('half');
}

$('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('search-input').blur();
  doSearch($('search-input').value);
});
$('search-input').addEventListener('input', () => $('search-clear').classList.toggle('hidden', !$('search-input').value));
$('search-input').addEventListener('focus', () => setSnap('full'));
$('search-clear').addEventListener('click', () => {
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  state.results = [];
  resultLayer.clearLayers();
  $('results').innerHTML = '';
  setStatus('search-status', '');
  $('search-input').focus();
});

// 長按（手機）或右鍵（桌機）地圖：選擇該點
map.on('contextmenu', (e) => {
  const stop = { lng: e.latlng.lng, lat: e.latlng.lat, name: '地圖上的點' };
  if (state.picking) return assignStop(state.picking, stop);
  showPlace(stop, `${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}`);
});

/* ---------------- 畫面切換 ---------------- */
function showView(v) {
  state.view = v;
  for (const name of ['search', 'place', 'route', 'nearby', 'favs', 'account']) $(`view-${name}`).classList.toggle('hidden', name !== v);
  const picking = !!state.picking && v === 'search';
  $('pick-hint').classList.toggle('hidden', !picking);
  $('route-shortcut').classList.toggle('hidden', picking);
  if (picking) {
    const p = state.picking;
    $('pick-hint-text').textContent = p === 'start' ? '選擇起點（搜尋或長按地圖）' : p === 'dest' ? '選擇終點（搜尋或長按地圖）' : '選擇途經點（搜尋或長按地圖）';
  }
}
$('place-close').addEventListener('click', () => showView(state.routeOpen ? 'route' : state.placeFrom || 'search'));
$('place-as-dest').addEventListener('click', () => assignStop('dest', placeStop));
$('place-as-start').addEventListener('click', () => assignStop('start', placeStop));
$('place-as-via').addEventListener('click', () => assignStop({ via: state.via.length }, placeStop));
$('btn-open-route').addEventListener('click', () => openRoute());
$('pick-cancel').addEventListener('click', () => {
  state.picking = null;
  openRoute();
});

/* ---------------- 路線 ---------------- */
function assignStop(target, stop) {
  if (!stop) return;
  if (target === 'start') state.start = stop;
  else if (target === 'dest') state.dest = stop;
  else if (typeof target === 'object' && 'via' in target) {
    if (state.via.length >= 16 && target.via >= state.via.length) return toast('最多 16 個途經點');
    state.via[target.via] = stop;
  }
  state.picking = null;
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
  showView('search');
  setSnap('full');
  $('search-input').value = '';
  $('search-clear').classList.add('hidden');
  $('results').innerHTML = '';
  setStatus('search-status', '');
  resultLayer.clearLayers();
  // 起點可直接選「我的位置」
  if (target === 'start' && !state.start.isCurrentLocation) {
    const li = document.createElement('li');
    li.className = 'result';
    li.innerHTML = '<div class="badge">◎</div><div class="body"><div class="name">我的位置</div><div class="sub">使用目前 GPS 位置</div></div>';
    li.addEventListener('click', () => assignStop('start', MY_LOCATION));
    $('results').appendChild(li);
  }
  setTimeout(() => $('search-input').focus(), 50);
}

function stopRow(cls, dotText, stop, placeholder, onPick, onRemove) {
  const row = document.createElement('div');
  row.className = 'stop';
  const name = stop ? stop.name : '';
  row.innerHTML = `<div class="dot ${cls}">${dotText}</div>
    <button type="button" class="field ${name ? '' : 'empty'}">${escapeHtml(name || placeholder)}</button>
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
  stopLayer.clearLayers();
  const add = (s, cls, t) => s && !s.isCurrentLocation && L.marker([s.lat, s.lng], { icon: pinIcon(cls, t), zIndexOffset: 1000 }).addTo(stopLayer);
  add(state.start, 'start', '起');
  state.via.forEach((v, i) => add(v, 'via', String(i + 1)));
  add(state.dest, 'dest', '終');
}

const chips = $('strategy-chips');
function renderStrategyChips() {
  chips.innerHTML = '';
  const list = state.mode === 'driving' ? STRATEGIES : state.mode === 'transit' ? TRANSIT_STRATEGIES : [];
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
$('route-close').addEventListener('click', () => {
  state.routeOpen = false;
  state.routes = [];
  routeLayer.clearLayers();
  stopLayer.clearLayers();
  $('route-options').innerHTML = '';
  $('nav-buttons').classList.add('hidden');
  $('nav-note').classList.add('hidden');
  setStatus('route-status', '');
  showView('search');
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
  routeLayer.clearLayers();
  $('route-options').innerHTML = '';
  $('nav-buttons').classList.add('hidden');
  $('nav-note').classList.add('hidden');
  if (!state.dest) return setStatus('route-status', '請選擇終點');
  setStatus('route-status', state.start.isCurrentLocation && !state.me ? '正在取得目前位置…' : '規劃路線中…');
  if (state.mode !== 'driving' && state.via.length) toast('此交通方式不支援途經點，已忽略');
  const start = await resolveStart();
  if (!start) return setStatus('route-status', '無法取得目前位置：請允許定位，或手動選擇起點', true);
  setStatus('route-status', '規劃路線中…');
  routeCtrl?.abort();
  routeCtrl = new AbortController();
  try {
    const mode = state.mode;
    const strategy = mode === 'driving' ? state.strategy : mode === 'transit' ? state.transitStrategy : undefined;
    const via = mode === 'driving' ? state.via.filter(Boolean) : [];
    const data = await api.route({ start, dest: state.dest, via, strategy, mode }, { signal: routeCtrl.signal });
    if (mode !== state.mode) return; // 規劃途中使用者已切換交通方式
    state.routes = data.routes;
    state.routeIdx = 0;
    state.resolvedStart = start;
    if (!data.routes.length) return setStatus('route-status', mode === 'transit' ? '找不到公交／火車方案（距離太遠或沒有班次）' : '找不到路線', true);
    setStatus('route-status', data.routes.length > 1 ? `共 ${data.routes.length} 條路線，點選可切換` : '');
    renderRoutes(true);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('route-status', e.message || '路線規劃失敗', true);
  }
}

function stepsHtml(r) {
  if (!r.steps?.length) return '';
  return `<details class="passed"><summary>逐步指引（${r.steps.length} 步）</summary><ol class="steps">${r.steps
    .map((st) => `<li>${esc(st.instruction || st.road || '')}${st.distance ? ` <span>${formatDistance(st.distance)}</span>` : ''}</li>`)
    .join('')}</ol></details>`;
}

function routeCard(r, sel) {
  const mode = state.mode;
  if (mode === 'driving') {
    const meta = [];
    if (r.roads.length) meta.push('經 ' + r.roads.slice(0, 4).join('、'));
    if (r.tollDistance) meta.push(`收費路段 ${formatDistance(r.tollDistance)}`);
    if (r.trafficLights) meta.push(`紅綠燈 ${r.trafficLights} 個`);
    return `<div class="top"><span class="dur">${formatDuration(r.duration)}</span><span class="dist">${formatDistance(r.distance)}</span>
      <span class="toll">過路費 ${formatYuan(r.tolls)}</span></div>
      <div class="meta">${escapeHtml(meta.join(' · '))}</div>
      ${r.restriction ? '<div class="warn">⚠ 此路線有無法避開的限行路段</div>' : ''}`;
  }
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
    const ll = (seg.polyline || []).map(([lng, lat]) => [lat, lng]);
    if (ll.length < 2) continue;
    const style = { ...(SEG_STYLE[seg.type] || SEG_STYLE.bus) };
    if (seg.type === 'train' && seg.lineMatch?.unmatched?.length && !seg.lineMatch.sections.length) style.dashArray = '10 8'; // 沒有線路資料時只畫站間直線
    if (seg.type !== 'walk') L.polyline(ll, { color: '#ffffff', weight: style.weight + 4, opacity: 0.95, interactive: false }).addTo(routeLayer);
    L.polyline(ll, { ...style, lineCap: seg.type === 'walk' ? 'round' : undefined, interactive: false }).addTo(routeLayer);
    if (seg.type === 'train') {
      for (const p of seg.stops) {
        if (p.lng == null) continue;
        L.circleMarker([p.lat, p.lng], { radius: p.role === 'via' ? 5 : 7, color: '#b91c1c', weight: 2, fillColor: p.role === 'via' ? '#fff' : '#b91c1c', fillOpacity: 1 })
          .bindTooltip(`${p.name}${p.time ? ' ' + p.time : ''}`, { className: 'stop-tip', direction: 'top' })
          .addTo(routeLayer);
      }
    }
  }
}

function renderRoutes(fit = false) {
  routeLayer.clearLayers();
  const ul = $('route-options');
  ul.innerHTML = '';
  state.routes.forEach((r, i) => {
    const sel = i === state.routeIdx;
    const li = document.createElement('li');
    li.className = 'route-option' + (sel ? ' selected' : '');
    li.innerHTML = routeCard(r, sel);
    li.addEventListener('click', (e) => {
      if (e.target.closest('.detail, details')) return; // 展開／收合明細時不要重繪
      state.routeIdx = i;
      renderRoutes();
    });
    ul.appendChild(li);
  });
  const color = MODES[state.mode].color;
  // 先畫未選中的（灰），再畫選中的（含白色外框）
  const order = state.routes.map((_, i) => i).sort((a, b) => (a === state.routeIdx) - (b === state.routeIdx));
  for (const i of order) {
    const r = state.routes[i];
    const sel = i === state.routeIdx;
    if (sel && state.mode === 'transit') {
      drawSelectedTransit(r);
      continue;
    }
    const latlngs = r.polyline.map(([lng, lat]) => [lat, lng]);
    if (latlngs.length < 2) continue;
    if (sel) L.polyline(latlngs, { color: '#ffffff', weight: 11, opacity: 0.95, interactive: false }).addTo(routeLayer);
    L.polyline(latlngs, { color: sel ? color : '#8a99ad', weight: sel ? 7 : 6, opacity: sel ? 1 : 0.75 })
      .on('click', () => {
        state.routeIdx = i;
        renderRoutes();
      })
      .addTo(routeLayer);
  }
  $('nav-buttons').classList.remove('hidden');
  const notes = [];
  if (state.mode === 'driving') {
    if (state.via.length > 1) notes.push('高德網頁版只帶第 1 個途經點；高德 App 帶全部途經點。');
    if (state.via.length) notes.push('Apple 地圖不支援途經點，只會導航到終點。');
  }
  if (state.mode === 'transit') notes.push('火車的「鐵路線」是依停靠站推測的，可能與實際線路略有出入；停靠站與時刻由高德提供。');
  if (state.mode === 'electrobike') notes.push('Apple 地圖沒有電動車模式，會以駕車導航代替。');
  notes.push('導航 App 會自行重新規劃路線，結果可能和這裡略有不同。');
  $('nav-note').textContent = notes.join(' ');
  $('nav-note').classList.remove('hidden');
  if (fit) {
    const r = state.routes[state.routeIdx];
    fitTo(r.polyline.map(([lng, lat]) => [lat, lng]));
  }
}

/* ---------------- 交給導航 App ---------------- */
function navArgs() {
  return { start: state.start, dest: state.dest, via: state.mode === 'driving' ? state.via.filter(Boolean) : [], strategy: state.strategy, mode: state.mode };
}
$('nav-amap').addEventListener('click', () => {
  if (!state.dest) return;
  const web = amapWebUrl(navArgs());
  if (platform.isIOS) {
    // 先嘗試打開高德 App；1.6 秒後頁面仍在前景，代表沒裝 App → 改開網頁版
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') window.location.href = web;
    }, 1600);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && clearTimeout(t), { once: true });
    window.location.href = amapIosUri(navArgs());
  } else if (platform.isMobile) {
    window.location.href = web; // Android：網頁版 callnative=1 會嘗試喚起 App
  } else {
    window.open(web, '_blank', 'noopener');
  }
});
$('nav-apple').addEventListener('click', () => {
  if (!state.dest) return;
  const url = appleMapsUrl(navArgs());
  if (platform.isMobile) window.location.href = url;
  else window.open(url, '_blank', 'noopener');
});

/* ---------------- 附近：廁所／加油站／充電站 ---------------- */
let nearbyKind = null;
let nearbyItems = [];
let nearbyCtrl;
function nearbyCenter(forceMap) {
  const c = centerOf();
  if (!forceMap && state.me && haversine(state.me.lng, state.me.lat, c.lng, c.lat) < 5000) return { lng: state.me.lng, lat: state.me.lat };
  return c;
}
function clearNearby() {
  nearbyKind = null;
  nearbyItems = [];
  nearbyCtrl?.abort();
  clusterLayer.clearLayers();
  document.querySelectorAll('#nearby-bar .chip').forEach((c) => c.classList.remove('active'));
}
async function runNearby(kind, { forceMap = false } = {}) {
  nearbyKind = kind;
  document.querySelectorAll('#nearby-bar .chip').forEach((c) => c.classList.toggle('active', c.dataset.kind === kind));
  const info = NEARBY[kind];
  $('nearby-title').textContent = `附近的${info.label}`;
  $('nearby-list').innerHTML = '';
  clusterLayer.clearLayers();
  setStatus('nearby-status', '搜尋中…');
  showView('nearby');
  setSnap('half');
  nearbyCtrl?.abort();
  nearbyCtrl = new AbortController();
  const { signal } = nearbyCtrl;
  const center = nearbyCenter(forceMap);
  try {
    let radius = 3000;
    let data = await api.nearby({ kind, center, radius }, { signal });
    if (!data.results.length) {
      radius = 10000;
      data = await api.nearby({ kind, center, radius }, { signal });
    }
    if (signal.aborted) return;
    nearbyItems = data.results;
    if (!nearbyItems.length) return setStatus('nearby-status', `${radius / 1000} 公里內找不到${info.label}`);
    setStatus('nearby-status', `${radius / 1000} 公里內找到 ${nearbyItems.length} 個${info.label}，依距離排序`);
    renderNearby(center);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('nearby-status', e.message || '搜尋失敗', true);
  }
}
function renderNearby(center) {
  const ul = $('nearby-list');
  ul.innerHTML = '';
  const info = NEARBY[nearbyKind];
  nearbyItems.forEach((r, i) => {
    const li = document.createElement('li');
    li.className = 'result';
    li.innerHTML = `<div class="badge">${info.emoji}</div><div class="body"><div class="name">${escapeHtml(r.name)}</div><div class="sub">${escapeHtml([r.address, r.openTime].filter(Boolean).join(' · '))}</div></div>${r.distance != null ? `<div class="dist">${formatDistance(r.distance)}</div>` : ''}`;
    li.addEventListener('click', () => pickNearby(i));
    ul.appendChild(li);
    L.marker([r.lat, r.lng], { icon: emojiIcon(info.emoji), title: r.name }).on('click', () => pickNearby(i)).addTo(clusterLayer);
  });
  fitTo([[center.lat, center.lng], ...nearbyItems.slice(0, 8).map((r) => [r.lat, r.lng])]);
}
function pickNearby(i) {
  const r = nearbyItems[i];
  if (!r) return;
  if (state.picking) return assignStop(state.picking, toStop({ ...r, kind: 'poi' }));
  showPlace(toStop({ ...r, kind: 'poi' }), [r.address, r.openTime].filter(Boolean).join(' · '));
  map.setView([r.lat, r.lng], Math.max(map.getZoom(), 16));
}
$('nearby-bar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  if (nearbyKind === b.dataset.kind && state.view === 'nearby') {
    clearNearby();
    showView(state.routeOpen ? 'route' : 'search');
    return;
  }
  runNearby(b.dataset.kind);
});
$('nearby-close').addEventListener('click', () => {
  clearNearby();
  showView(state.routeOpen ? 'route' : 'search');
  setSnap('peek');
});
$('nearby-here').addEventListener('click', () => nearbyKind && runNearby(nearbyKind, { forceMap: true }));

/* ---------------- 收藏 ---------------- */
let syncTimer;
function drawFavs() {
  favLayer.clearLayers();
  for (const f of store.live()) {
    L.marker([f.lat, f.lng], { icon: emojiIcon('⭐', 'fav'), title: f.name, zIndexOffset: 200 })
      .on('click', () => {
        showPlace({ lng: f.lng, lat: f.lat, name: f.name }, f.address || '');
      })
      .addTo(favLayer);
  }
}
function renderFavs() {
  const ul = $('fav-list');
  ul.innerHTML = '';
  const items = store.live();
  setStatus('favs-status', items.length ? `共 ${items.length} 個收藏` : '還沒有收藏。在地點頁面按「☆ 收藏」就會出現在這裡。');
  for (const f of items) {
    const li = document.createElement('li');
    li.className = 'result';
    li.innerHTML = `<div class="badge">⭐</div><div class="body"><div class="name">${escapeHtml(f.name)}</div><div class="sub">${escapeHtml(f.address || '')}</div></div><button type="button" class="del" aria-label="刪除收藏">🗑</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.closest('.del')) {
        store.remove(f.id);
        afterFavChange();
        return;
      }
      if (state.picking) return assignStop(state.picking, { lng: f.lng, lat: f.lat, name: f.name });
      showPlace({ lng: f.lng, lat: f.lat, name: f.name }, f.address || '');
      map.setView([f.lat, f.lng], Math.max(map.getZoom(), 15));
    });
    ul.appendChild(li);
  }
}
function renderPlaceFav() {
  if (!placeStop || placeStop.isCurrentLocation) return;
  const on = !!findSamePlace(store.all(), placeStop.lng, placeStop.lat);
  $('place-fav').textContent = on ? '★ 已收藏' : '☆ 收藏';
  $('place-fav').setAttribute('aria-pressed', String(on));
}
function afterFavChange() {
  drawFavs();
  renderFavs();
  renderPlaceFav();
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
    toast('已加入收藏');
    // 請瀏覽器盡量不要在儲存空間吃緊時清掉收藏資料
    navigator.storage?.persist?.().catch(() => {});
  }
  afterFavChange();
});
function openFavs() {
  renderFavs();
  showView('favs');
  setSnap('half');
}
$('btn-open-favs').addEventListener('click', openFavs);
$('favs-close').addEventListener('click', () => showView(state.routeOpen ? 'route' : 'search'));
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

/* ---------------- 信箱登入與同步 ---------------- */
let loginEmail = '';
function renderAccount() {
  const enabled = !!state.config?.features?.auth;
  const user = state.user;
  $('account-status').textContent = user ? `已登入：${user.email}（收藏會跨裝置同步）` : enabled ? '未登入：收藏只存在這台裝置' : '收藏只存在這台裝置（信箱登入尚未啟用）';
  $('btn-account').textContent = user ? '帳號' : enabled ? '登入同步' : '說明';
  $('account-disabled').classList.toggle('hidden', enabled || !!user);
  $('login-form').classList.toggle('hidden', !enabled || !!user || !$('code-form').classList.contains('hidden'));
  $('account-in').classList.toggle('hidden', !user);
  if (user) {
    $('account-email').textContent = user.email;
    $('code-form').classList.add('hidden');
  }
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
    }
    if (!quiet) setStatus('account-status2', e.message || '同步失敗', true);
  }
}
function afterFavChangeNoSync() {
  drawFavs();
  renderFavs();
  renderPlaceFav();
}
$('btn-account').addEventListener('click', () => {
  renderAccount();
  setStatus('account-status2', '');
  showView('account');
});
$('account-close').addEventListener('click', openFavs);
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
  } catch {}
  state.user = null;
  renderAccount();
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
  $('share-clear').classList.toggle('hidden', !markLayer.getLayers().length);
  $('share-modal').classList.remove('hidden');
}
function closeShare() {
  $('share-modal').classList.add('hidden');
}
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
  markLayer.clearLayers();
  closeShare();
});
$('place-share').addEventListener('click', () => placeStop && !placeStop.isCurrentLocation && openShare(placeStop));
$('btn-mark').addEventListener('click', async () => {
  const me = await locate({ pan: true });
  if (!me) return;
  markLayer.clearLayers();
  L.marker([me.lat, me.lng], { icon: pinIcon('dest', '我'), zIndexOffset: 1500, title: '我標記的位置' }).addTo(markLayer);
  openShare({ lng: me.lng, lat: me.lat, name: '我的位置' });
});

/* ---------------- 啟動 ---------------- */
applyLayers();
drawFavs();
setSnap('peek');
showView('search');
api.config().then(applyConfig).catch(() => applyConfig({ features: {} }));
loadAccount();
// 若之前已授權定位，直接定位（不跳錯誤提示）
if (navigator.permissions?.query) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((p) => p.state === 'granted' && locate({ quiet: true }))
    .catch(() => {});
}
window.addEventListener('resize', () => setSnap(sheet.dataset.snap));

// 給自動化測試／截圖用的小掛勾（不含任何機密）
window.__worldMap = { state, map, assignStop, planRoute, doSearch, setSnap, openRoute, setMode, runNearby, openShare, openFavs, store, showPlace };
