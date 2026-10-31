// 主地圖：高德地圖 JS API 2.0 的薄包裝（一個 viewMode:'3D' 的向量地圖，俯仰角 0° = 平面 2D、>0° = 3D）。
//
// 為什麼用 JS API 2.0 而不是 Leaflet + 另一份 3D 頁：
//  - 官方唯一支援 GCJ-02、中國大陸穩定、含 3D 建築／旋轉／俯仰的地圖。
//  - 標準／衛星／天地圖／大眾運輸都在同一張地圖上切換，2D⇄3D 只是改俯仰角，不必換引擎。
//  - 自訂圖磚用官方 AMap.TileLayer.Flexible（canvas，3D 模式不受 CORS 限制）。
// 所有 Web 服務請求都走同源 /_AMapService 代理（安全密鑰只在伺服器端）。

let loading;

/** 載入 JS API（只載一次）。key 與 serviceHost 來自 /api/config。 */
export function loadAMap({ key, serviceHost }, doc = document, win = window) {
  if (win.AMap?.Map) return Promise.resolve(win.AMap);
  if (loading) return loading;
  win._AMapSecurityConfig = { serviceHost: `${win.location.origin}${serviceHost}` };
  loading = new Promise((resolve, reject) => {
    const s = doc.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`;
    s.async = true;
    s.onload = () => (win.AMap?.Map ? resolve(win.AMap) : reject(new Error('AMap missing')));
    s.onerror = () => {
      loading = null;
      reject(new Error('AMap script failed'));
    };
    doc.head.appendChild(s);
  });
  return loading;
}

const ll = (p) => [p.lng, p.lat];
const fromLngLat = (x) => ({ lng: x.getLng(), lat: x.getLat() });

export const LAYER_MODES = ['standard', 'satellite', 'tianditu', 'transit'];

/**
 * @param AMap  window.AMap
 * @param el    地圖容器
 * @param opts  { center:{lng,lat}, zoom, dark, tianditu:{tk}|null }
 */
export function createMapView(AMap, el, opts = {}) {
  const map = new AMap.Map(el, {
    viewMode: '3D',
    zoom: opts.zoom ?? 11,
    zooms: [3, 20],
    center: ll(opts.center ?? { lng: 119.2216, lat: 34.5967 }),
    pitch: 0,
    rotation: 0,
    resizeEnable: true,
    showBuildingBlock: true,
    showLabel: true,
    rotateEnable: true,
    pitchEnable: true,
    jogEnable: true,
    animateEnable: true,
    mapStyle: opts.dark ? 'amap://styles/dark' : 'amap://styles/normal',
  });

  const state = { mode: 'standard', labels: true, satSource: 'amap', dark: !!opts.dark, overlay: [] };
  const layers = {};
  const make = (name, fn) => (layers[name] ??= fn());

  const listeners = new Map();
  const emit = (name, ev) => (listeners.get(name) || []).forEach((fn) => fn(ev));

  // ── 長按／點擊（自己用 pointer 事件實作長按；AMap 沒有 longpress 事件）
  const LONG_MS = 550;
  const MOVE_TOL = 10;
  let press = null;
  let suppressUntil = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (press) {
      clearTimeout(press.timer);
      press = null; // 第二指（縮放）→ 取消
      return;
    }
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    press = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        if (!press) return;
        press = null;
        suppressUntil = Date.now() + 900;
        const p = map.containerToLngLat(new AMap.Pixel(x, y));
        emit('longpress', { ...fromLngLat(p), px: { x, y } });
      }, LONG_MS),
    };
  });
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  el.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOL) cancelPress();
  });
  el.addEventListener('pointerup', cancelPress);
  el.addEventListener('pointercancel', cancelPress);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  map.on('click', (e) => {
    if (Date.now() < suppressUntil) return;
    emit('tap', { ...fromLngLat(e.lnglat), px: { x: e.pixel?.x, y: e.pixel?.y } });
  });
  for (const ev of ['moveend', 'zoomend', 'dragstart']) map.on(ev, () => emit(ev === 'dragstart' ? 'dragstart' : 'viewchange', {}));

  // ── 圖層
  const tdt = (kind) => make(kind === 'imagery' ? 'tdtImg' : 'tdtLabels', () => opts.createTianditu(AMap, kind));
  function layerSet() {
    const { mode, labels, satSource } = state;
    const set = [];
    if (mode === 'satellite' || mode === 'tianditu') {
      const useTdt = (mode === 'tianditu' || satSource === 'tianditu') && opts.tianditu?.tk && opts.createTianditu;
      if (useTdt) {
        set.push(tdt('imagery'));
        if (labels) set.push(tdt('labels'));
      } else {
        set.push(make('sat', () => new AMap.TileLayer.Satellite({ zIndex: 2 })));
        if (labels) set.push(make('roadnet', () => new AMap.TileLayer.RoadNet({ zIndex: 3 })));
      }
    }
    return set;
  }
  function setLayerMode(mode, extra = {}) {
    if (!LAYER_MODES.includes(mode)) throw new Error(`unknown layer mode ${mode}`);
    Object.assign(state, { mode }, extra);
    const want = new Set(layerSet());
    for (const l of state.overlay) if (!want.has(l)) map.remove(l);
    for (const l of want) if (!state.overlay.includes(l)) map.add(l);
    state.overlay = [...want];
    const sat = mode === 'satellite' || mode === 'tianditu';
    // 衛星時底圖向量圖層被圖磚蓋住；標準用預設樣式，大眾運輸用低彩度樣式讓鐵路線更醒目
    map.setMapStyle(state.dark ? 'amap://styles/dark' : mode === 'transit' ? 'amap://styles/light' : 'amap://styles/normal');
    el.dataset.layer = sat ? 'satellite' : mode;
  }
  function setDark(dark) {
    state.dark = !!dark;
    setLayerMode(state.mode);
  }

  // ── 疊加物
  const addAll = (o) => {
    map.add(o);
    return o;
  };
  const group = () => {
    const items = [];
    return {
      add(h) {
        items.push(h);
        return h;
      },
      clear() {
        items.splice(0).forEach((h) => h.remove());
      },
      get size() {
        return items.length;
      },
    };
  };

  function marker({ lng, lat, html, anchor = 'center', zIndex = 100, onClick, title }) {
    const m = new AMap.Marker({ position: [lng, lat], content: html, anchor, zIndex, bubble: false, title, offset: new AMap.Pixel(0, 0) });
    if (onClick) m.on('click', onClick);
    addAll(m);
    return {
      raw: m,
      remove: () => map.remove(m),
      setPosition: (p) => m.setPosition([p.lng, p.lat]),
      setHtml: (h) => m.setContent(h),
    };
  }
  function polyline({ path, color = '#0a84ff', weight = 6, opacity = 0.9, dash = false, zIndex = 50, onClick }) {
    const l = new AMap.Polyline({
      path,
      strokeColor: color,
      strokeWeight: weight,
      strokeOpacity: opacity,
      strokeStyle: dash ? 'dashed' : 'solid',
      strokeDasharray: dash ? [6, 10] : undefined,
      lineJoin: 'round',
      lineCap: 'round',
      zIndex,
      bubble: !onClick,
    });
    if (onClick) l.on('click', onClick);
    addAll(l);
    return { raw: l, remove: () => map.remove(l), setPath: (p) => l.setPath(p) };
  }
  function circle({ lng, lat, radius, color = '#0a84ff', fill = '#0a84ff', fillOpacity = 0.12, zIndex = 10 }) {
    const c = new AMap.Circle({ center: [lng, lat], radius, strokeColor: color, strokeWeight: 1, strokeOpacity: 0.5, fillColor: fill, fillOpacity, zIndex, bubble: true });
    addAll(c);
    return { raw: c, remove: () => map.remove(c), set: (p) => (c.setCenter([p.lng, p.lat]), c.setRadius(p.radius)) };
  }

  function dot({ lng, lat, radius = 4, color = '#8e1a2b', fill = '#ffffff', zIndex = 60, title }) {
    const c = new AMap.CircleMarker({ center: [lng, lat], radius, strokeColor: color, strokeWeight: 1.5, fillColor: fill, fillOpacity: 1, zIndex, bubble: true, title });
    addAll(c);
    return { raw: c, remove: () => map.remove(c) };
  }
  function text({ lng, lat, text: t, zIndex = 70 }) {
    const m = new AMap.Text({ text: t, position: [lng, lat], anchor: 'left-center', offset: new AMap.Pixel(10, 0), style: { background: 'transparent', border: 0, padding: 0, 'font-size': '11px', 'font-weight': 600, color: '#1c1c1e', 'text-shadow': '0 0 3px #fff, 0 0 3px #fff, 0 0 3px #fff' }, zIndex, bubble: true });
    addAll(m);
    return { raw: m, remove: () => map.remove(m) };
  }
  function getBounds() {
    const b = map.getBounds();
    const sw = b.getSouthWest();
    const ne = b.getNorthEast();
    return { west: sw.getLng(), south: sw.getLat(), east: ne.getLng(), north: ne.getLat() };
  }

  /** padding：被底部面板遮住的高度等（像素） */
  function fit(points, pad = {}) {
    const pts = points.filter((p) => p && Number.isFinite(p.lng) && Number.isFinite(p.lat));
    if (!pts.length) return;
    const { top = 90, right = 40, bottom = 40, left = 40 } = pad;
    if (pts.length === 1) return flyTo(pts[0], Math.max(map.getZoom(), 15), pad);
    // 自己算縮放層級（AMap.setBounds 帶 padding 時在手機上會縮得過頭）
    const lngs = pts.map((p) => p.lng);
    const lats = pts.map((p) => p.lat);
    const w = Math.max(60, el.clientWidth - left - right);
    const h = Math.max(60, el.clientHeight - top - bottom);
    const merc = (lat) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
    const lngSpan = Math.max(1e-6, Math.max(...lngs) - Math.min(...lngs)) / 360; // 佔世界寬度的比例
    const latSpan = Math.max(1e-6, merc(Math.max(...lats)) - merc(Math.min(...lats))) / (2 * Math.PI);
    const zx = Math.log2(w / (256 * lngSpan));
    const zy = Math.log2(h / (256 * latSpan));
    const z = Math.max(3, Math.min(18, Math.floor(Math.min(zx, zy) * 10) / 10 - 0.15));
    flyTo({ lng: (Math.min(...lngs) + Math.max(...lngs)) / 2, lat: (Math.min(...lats) + Math.max(...lats)) / 2 }, z, pad, false);
  }
  /** 讓 p 出現在「可見區域」（扣掉頂部與底部面板）的正中央 */
  function flyTo(p, zoom, pad = {}, animate = true) {
    const z = zoom ?? map.getZoom();
    map.setZoomAndCenter(z, ll(p), animate);
    const { top = 0, bottom = 0 } = pad;
    if (top || bottom) {
      const h = el.clientHeight;
      const w = el.clientWidth;
      const vy = (top + (h - bottom)) / 2;
      map.setCenter(map.containerToLngLat(new AMap.Pixel(w / 2, h - vy)), animate);
    }
  }
  /** 點若被面板蓋住或在畫面外，才移動地圖 */
  function ensureVisible(p, pad = {}) {
    const px = map.lngLatToContainer(ll(p));
    const { top = 0, bottom = 0 } = pad;
    const y = px.getY();
    const x = px.getX();
    if (y < top || y > el.clientHeight - bottom || x < 20 || x > el.clientWidth - 20) flyTo(p, map.getZoom(), pad);
  }

  return {
    map,
    AMap,
    state,
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(fn);
    },
    getCenter: () => fromLngLat(map.getCenter()),
    getZoom: () => map.getZoom(),
    getPitch: () => map.getPitch?.() ?? 0,
    getRotation: () => map.getRotation?.() ?? 0,
    setPitch: (deg) => map.setPitch?.(deg, false),
    resetNorth: () => map.setRotation?.(0, false),
    setLayerMode,
    setDark,
    fit,
    flyTo,
    ensureVisible,
    zoomBy: (d) => map.setZoom(map.getZoom() + d),
    resize: () => map.resize?.(),
    group,
    marker,
    polyline,
    circle,
    dot,
    text,
    getBounds,
    lngLatToContainer: (p) => {
      const px = map.lngLatToContainer(ll(p));
      return { x: px.getX(), y: px.getY() };
    },
    isVector3D: () => {
      const t = map.getView?.()?.type;
      return t === '3D' || (!!map.getPitch && map.getView?.() == null);
    },
  };
}
