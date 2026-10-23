// World Map v1 — 前端主程式
// 座標約定：畫面上所有點（地圖、搜尋結果、路線）都是 GCJ-02；只有瀏覽器定位是 WGS-84，取得後立刻轉換。
import { wgs84ToGcj02 } from './lib/coords.js';
import { api } from './lib/api.js';
import { layerPlan, SUBDOMAINS, ATTRIBUTION } from './lib/layers.js';
import { formatDistance, formatDuration, formatYuan } from './lib/format.js';
import { amapIosUri, amapWebUrl, appleMapsUrl, detectPlatform } from './lib/navlinks.js';

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
  routes: [],
  routeIdx: 0,
  picking: null, // 'start' | 'dest' | { via: index }
  view: 'search',
  routeOpen: false,
};

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
};
layers.standard.addTo(map);

function applyLayers() {
  const sat = state.baseLayer === 'satellite';
  if (sat) {
    map.removeLayer(layers.standard);
    layers.satellite.addTo(map);
    state.satLabels ? layers.satLabels.addTo(map) : map.removeLayer(layers.satLabels);
  } else {
    map.removeLayer(layers.satellite);
    map.removeLayer(layers.satLabels);
    layers.standard.addTo(map);
  }
  $('layer-label').textContent = sat ? '標準' : '衛星';
  $('btn-layer').setAttribute('aria-label', sat ? '切換標準地圖' : '切換衛星圖');
  $('btn-labels').classList.toggle('hidden', !sat);
  $('btn-labels').setAttribute('aria-pressed', String(state.satLabels));
}
$('btn-layer').addEventListener('click', () => {
  state.baseLayer = state.baseLayer === 'standard' ? 'satellite' : 'standard';
  applyLayers();
});
$('btn-labels').addEventListener('click', () => {
  state.satLabels = !state.satLabels;
  applyLayers();
});

const resultLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);

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
  $('place-name').textContent = stop.name;
  $('place-addr').textContent = addr || `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`;
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
  for (const name of ['search', 'place', 'route']) $(`view-${name}`).classList.toggle('hidden', name !== v);
  const picking = !!state.picking && v === 'search';
  $('pick-hint').classList.toggle('hidden', !picking);
  $('route-shortcut').classList.toggle('hidden', picking);
  if (picking) {
    const p = state.picking;
    $('pick-hint-text').textContent = p === 'start' ? '選擇起點（搜尋或長按地圖）' : p === 'dest' ? '選擇終點（搜尋或長按地圖）' : '選擇途經點（搜尋或長按地圖）';
  }
}
$('place-close').addEventListener('click', () => showView(state.routeOpen ? 'route' : 'search'));
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
for (const s of STRATEGIES) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.setAttribute('role', 'radio');
  b.dataset.id = s.id;
  b.textContent = s.label;
  b.setAttribute('aria-checked', String(s.id === state.strategy));
  b.addEventListener('click', () => {
    state.strategy = s.id;
    chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.id === s.id)));
    planRoute();
  });
  chips.appendChild(b);
}

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
  const start = await resolveStart();
  if (!start) return setStatus('route-status', '無法取得目前位置：請允許定位，或手動選擇起點', true);
  setStatus('route-status', '規劃路線中…');
  routeCtrl?.abort();
  routeCtrl = new AbortController();
  try {
    const data = await api.route({ start, dest: state.dest, via: state.via.filter(Boolean), strategy: state.strategy }, { signal: routeCtrl.signal });
    state.routes = data.routes;
    state.routeIdx = 0;
    state.resolvedStart = start;
    if (!data.routes.length) return setStatus('route-status', '找不到路線', true);
    setStatus('route-status', data.routes.length > 1 ? `共 ${data.routes.length} 條路線，點選可切換` : '');
    renderRoutes(true);
  } catch (e) {
    if (e.name === 'AbortError') return;
    setStatus('route-status', e.message || '路線規劃失敗', true);
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
    const meta = [];
    if (r.roads.length) meta.push('經 ' + r.roads.slice(0, 4).join('、'));
    if (r.tollDistance) meta.push(`收費路段 ${formatDistance(r.tollDistance)}`);
    if (r.trafficLights) meta.push(`紅綠燈 ${r.trafficLights} 個`);
    li.innerHTML = `<div class="top"><span class="dur">${formatDuration(r.duration)}</span><span class="dist">${formatDistance(r.distance)}</span>
      <span class="toll">過路費 ${formatYuan(r.tolls)}</span></div>
      <div class="meta">${escapeHtml(meta.join(' · '))}</div>
      ${r.restriction ? '<div class="warn">⚠ 此路線有無法避開的限行路段</div>' : ''}`;
    li.addEventListener('click', () => {
      state.routeIdx = i;
      renderRoutes();
    });
    ul.appendChild(li);
  });
  // 先畫未選中的（灰），再畫選中的（藍，含白色外框）
  const order = state.routes.map((_, i) => i).sort((a, b) => (a === state.routeIdx) - (b === state.routeIdx));
  for (const i of order) {
    const latlngs = state.routes[i].polyline.map(([lng, lat]) => [lat, lng]);
    const sel = i === state.routeIdx;
    if (sel) L.polyline(latlngs, { color: '#ffffff', weight: 11, opacity: 0.95, interactive: false }).addTo(routeLayer);
    L.polyline(latlngs, { color: sel ? '#1f6feb' : '#8a99ad', weight: sel ? 7 : 6, opacity: sel ? 1 : 0.75 })
      .on('click', () => {
        state.routeIdx = i;
        renderRoutes();
      })
      .addTo(routeLayer);
  }
  $('nav-buttons').classList.remove('hidden');
  const notes = [];
  if (state.via.length && state.via.length > 1) notes.push('高德網頁版只帶第 1 個途經點；高德 App 帶全部途經點。');
  if (state.via.length) notes.push('Apple 地圖不支援途經點，只會導航到終點。');
  notes.push('導航 App 會自行重新規劃路線，結果可能和這裡略有不同。');
  $('nav-note').textContent = notes.join(' ');
  $('nav-note').classList.remove('hidden');
  if (fit) {
    const all = state.routes[state.routeIdx].polyline.map(([lng, lat]) => [lat, lng]);
    fitTo(all);
  }
}

/* ---------------- 交給導航 App ---------------- */
function navArgs() {
  return { start: state.start, dest: state.dest, via: state.via.filter(Boolean), strategy: state.strategy };
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

/* ---------------- 啟動 ---------------- */
applyLayers();
setSnap('peek');
showView('search');
// 若之前已授權定位，直接定位（不跳錯誤提示）
if (navigator.permissions?.query) {
  navigator.permissions
    .query({ name: 'geolocation' })
    .then((p) => p.state === 'granted' && locate({ quiet: true }))
    .catch(() => {});
}
window.addEventListener('resize', () => setSnap(sheet.dataset.snap));

// 給自動化測試／截圖用的小掛勾（不含任何機密）
window.__worldMap = { state, map, assignStop, planRoute, doSearch, setSnap, openRoute };
