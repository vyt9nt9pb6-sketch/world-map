import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapView, isImageryMode, LAYER_MODES } from '../public/js/lib/amap-map.js';
import { readFileSync } from 'node:fs';

/**
 * 假的高德 JS API：照真實行為建模——
 *  - showBuildingBlock:true（建構時）會自動放一個預設的 AMap.Buildings；setStatus/setFeatures 關不掉它（這就是衛星白樓的根因）
 *  - AMap.Buildings 圖層可以 map.add／map.remove
 */
function makeFakeAMap() {
  const made = { mapOpts: null, maps: [] };
  class Layer { constructor(o) { this.opts = o; } }
  class Buildings extends Layer { get CLASS_NAME() { return 'AMap.Buildings'; } }
  class Sat extends Layer { get CLASS_NAME() { return 'AMap.TileLayer.Satellite'; } }
  class RoadNet extends Layer { get CLASS_NAME() { return 'AMap.TileLayer.RoadNet'; } }
  class Flexible extends Layer { get CLASS_NAME() { return 'AMap.TileLayer.Flexible'; } }
  class Map {
    constructor(el, o) {
      made.mapOpts = o;
      this.o = o;
      this.layers = [{ CLASS_NAME: 'AMap.VectorLayer' }];
      if (o.showBuildingBlock !== false) this.layers.push(new Buildings());
      this.handlers = {};
      made.maps.push(this);
    }
    on(n, f) { (this.handlers[n] ||= []).push(f); }
    add(l) { for (const x of [].concat(l)) if (!this.layers.includes(x)) this.layers.push(x); }
    remove(l) { this.layers = this.layers.filter((x) => ![].concat(l).includes(x)); }
    getLayers() { return this.layers; }
    setFeatures(f) { this.features = f; }
    setStatus() {} // 真實 API：沒有 showBuildingBlock
    setMapStyle() {}
    getZoom() { return 15; }
  }
  return { Map, Buildings, TileLayer: { Satellite: Sat, RoadNet, Flexible }, Pixel: class {}, made };
}
const fakeEl = () => ({ dataset: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }), clientWidth: 390, clientHeight: 844 });

test('衛星傾斜根因：建構地圖時 showBuildingBlock 必須是 false（setStatus/setFeatures 關不掉預設樓塊）', () => {
  const A = makeFakeAMap();
  createMapView(A, fakeEl(), {});
  assert.equal(A.made.mapOpts.showBuildingBlock, false);
});

test('衛星類模式：地圖上沒有任何 Buildings 圖層（含預設樓塊）；標準模式有', () => {
  const A = makeFakeAMap();
  const el = fakeEl();
  const v = createMapView(A, el, { createTianditu: () => new A.TileLayer.Flexible(), tianditu: { tk: 'x' } });
  const count = () => v.map.getLayers().filter((l) => l.CLASS_NAME === 'AMap.Buildings').length;
  assert.equal(count(), 1, '標準模式保留 3D 樓塊');
  for (const mode of LAYER_MODES) {
    v.setLayerMode(mode);
    if (isImageryMode(mode)) {
      assert.equal(count(), 0, `${mode} 不得有白色樓塊`);
      assert.equal(v.buildingLayerCount(), 0);
      assert.equal(el.dataset.buildings, 'off');
      assert.deepEqual(v.map.features, ['bg']);
    } else {
      assert.equal(count(), 1, `${mode} 保留 3D 樓塊（且只有一個）`);
      assert.equal(el.dataset.buildings, 'on');
    }
  }
  v.setLayerMode('satellite');
  v.setLayerMode('standard');
  v.setLayerMode('satellite');
  assert.equal(count(), 0, '來回切換後衛星仍無樓塊');
});

test('保險：事件（縮放／載入完成）時若樓塊被別處加回來，衛星模式會再次移除', () => {
  const A = makeFakeAMap();
  const v = createMapView(A, fakeEl(), {});
  v.setLayerMode('satellite');
  v.map.add(new A.Buildings());
  assert.equal(v.buildingLayerCount(), 1);
  for (const f of v.map.handlers.zoomend) f({});
  assert.equal(v.buildingLayerCount(), 0);
});

test('app.js 有 import 它用到的 ext-sat 符號（避免啟用 Mapbox 時 ReferenceError）', () => {
  const src = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  for (const name of ['createMapboxSatFlexible', 'MAPBOX_ATTRIBUTION', 'createGoogleSatFlexible', 'GOOGLE_ATTRIBUTION']) {
    if (new RegExp(`\\b${name}\\b`).test(src)) {
      assert.match(src, new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\./lib/ext-sat\\.js'`), `${name} 沒有 import`);
    }
  }
});
