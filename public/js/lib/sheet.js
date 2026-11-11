// 底部面板（Apple 地圖那種三段式面板）：peek（只露出搜尋列）／half／full，手指拖曳、放開後吸附到最近的一段。
// 純數學在 pickDetent（有測試）；DOM 與 pointer 處理在 createSheet。
// 參考設計（只讀不抄）：MIT 授權的 vanilla 底部面板專案的 detent + 速度投射做法。

/**
 * @param {number} height   放開時的面板高度（px）
 * @param {number} velocity 高度變化速度，px/ms，往上拉為正
 * @param {number[]} detents 由小到大
 * @returns {number} 吸附到的 detent 索引
 */
export function pickDetent(height, velocity, detents) {
  // 以 180ms 的慣性投射最終位置，再吸附到最近的段；高速時至少跨一段
  const projected = height + velocity * 180;
  let best = 0;
  for (let i = 1; i < detents.length; i++) if (Math.abs(detents[i] - projected) < Math.abs(detents[best] - projected)) best = i;
  const cur = nearest(height, detents);
  if (Math.abs(velocity) > 0.6 && best === cur) best = Math.max(0, Math.min(detents.length - 1, cur + Math.sign(velocity)));
  return best;
}
function nearest(h, detents) {
  let b = 0;
  for (let i = 1; i < detents.length; i++) if (Math.abs(detents[i] - h) < Math.abs(detents[b] - h)) b = i;
  return b;
}

export const SNAPS = ['peek', 'half', 'full'];

/**
 * @param {object} o
 * @param {HTMLElement} o.el 面板
 * @param {() => {peek:number, half:number, full:number}} o.getDetents 目前三段高度（px）
 * @param {(snap:string, h:number) => void} [o.onChange]
 */
export function createSheet({ el, getDetents, onChange }) {
  let snap = 'peek';
  let drag = null;
  const apply = (h, animate = true) => {
    el.classList.toggle('dragging', !animate);
    el.style.height = `${Math.round(h)}px`;
    onChange?.(snap, h);
  };
  function set(next, animate = true) {
    snap = next;
    el.dataset.snap = next;
    apply(getDetents()[next], animate);
  }
  function refresh() {
    set(snap);
  }

  const isDragZone = (t) => t.closest('.sheet-grab, .drag-zone') && !t.closest('input, button, a, textarea, select, label');
  el.addEventListener('pointerdown', (e) => {
    if (!isDragZone(e.target)) return;
    const d = getDetents();
    drag = { y: e.clientY, h: el.getBoundingClientRect().height, t: performance.now(), last: [e.clientY, performance.now()], v: 0, d, moved: false, id: e.pointerId };
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = drag.y - e.clientY;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) {
      drag.moved = true;
      el.setPointerCapture?.(e.pointerId);
    }
    const now = performance.now();
    const dt = Math.max(1, now - drag.last[1]);
    drag.v = 0.7 * drag.v + 0.3 * ((drag.last[0] - e.clientY) / dt);
    drag.last = [e.clientY, now];
    const h = Math.max(drag.d.peek * 0.9, Math.min(drag.d.full, drag.h + dy));
    apply(h, false);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    if (!d.moved) {
      // 點一下把手：在 peek 與 half 之間切換
      if (e.target.closest?.('.sheet-grab')) set(snap === 'peek' ? 'half' : 'peek');
      return;
    }
    const h = el.getBoundingClientRect().height;
    const arr = [d.d.peek, d.d.half, d.d.full];
    set(SNAPS[pickDetent(h, d.v, arr)]);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  return { set, refresh, get snap() { return snap; }, get height() { return el.getBoundingClientRect().height; } };
}
