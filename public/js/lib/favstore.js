// 收藏的本機儲存（localStorage）與合併邏輯。
// 規則和後端 core/favorites.js 一致：逐筆以 updatedAt 較新者為準；刪除用 deleted 墓碑（保留 30 天）。
const KEY = 'wm.favorites.v1';
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000;

export function newId(rand = () => Math.random().toString(36).slice(2, 10), now = Date.now) {
  return `f${now().toString(36)}${rand()}`.slice(0, 40);
}

export function mergeLists(a, b, nowMs = Date.now()) {
  const m = new Map();
  for (const it of [...a, ...b]) {
    const cur = m.get(it.id);
    if (!cur || it.updatedAt > cur.updatedAt) m.set(it.id, it);
  }
  return [...m.values()].filter((it) => !(it.deleted && nowMs - it.updatedAt > TOMBSTONE_MS));
}

export const liveItems = (items) => items.filter((i) => !i.deleted).sort((x, y) => y.updatedAt - x.updatedAt);

/** 兩個座標約 1 公尺內視為同一點（避免重複收藏） */
export function findSamePlace(items, lng, lat) {
  return liveItems(items).find((i) => Math.abs(i.lng - lng) < 1e-5 && Math.abs(i.lat - lat) < 1e-5) || null;
}

export function createStore(storage = globalThis.localStorage, now = Date.now) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  const write = (items) => {
    storage.setItem(KEY, JSON.stringify(items));
    return items;
  };
  return {
    all: read,
    live: () => liveItems(read()),
    add({ name, address = '', note = '', lng, lat, adcode = '' }) {
      const items = read();
      const dup = findSamePlace(items, lng, lat);
      if (dup) return { item: dup, existed: true };
      const t = now();
      const item = { id: newId(undefined, now), name: String(name || '未命名地點').slice(0, 100), address: String(address).slice(0, 200), note: String(note).slice(0, 300), lng, lat, adcode, createdAt: t, updatedAt: t };
      write([item, ...items]);
      return { item, existed: false };
    },
    update(id, patch) {
      const items = read().map((i) => (i.id === id && !i.deleted ? { ...i, ...patch, id, updatedAt: now() } : i));
      write(items);
    },
    remove(id) {
      write(read().map((i) => (i.id === id ? { id, deleted: true, updatedAt: now() } : i)));
    },
    /** 用伺服器回傳的清單與本機合併，寫回，回傳合併後清單 */
    mergeFromServer(serverItems) {
      return write(mergeLists(read(), serverItems, now()));
    },
    replaceAll: write,
    exportJson() {
      return JSON.stringify({ app: 'world-map', version: 1, exportedAt: new Date(now()).toISOString(), items: liveItems(read()) }, null, 2);
    },
    /** 匯入 JSON（合併，不覆蓋較新的本機資料）；回傳匯入筆數 */
    importJson(text) {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error('檔案不是有效的 JSON');
      }
      const list = Array.isArray(data) ? data : data?.items;
      if (!Array.isArray(list)) throw new Error('找不到收藏清單');
      const clean = [];
      for (const r of list.slice(0, 500)) {
        const lng = Number(r?.lng);
        const lat = Number(r?.lat);
        if (!(lng >= 70 && lng <= 140 && lat >= 0 && lat <= 60)) continue;
        const t = Number(r.updatedAt) > 0 ? Math.min(Number(r.updatedAt), now() + 300000) : now();
        clean.push({
          id: /^[A-Za-z0-9_.:-]{1,64}$/.test(String(r.id)) ? String(r.id) : newId(undefined, now),
          name: String(r.name || '未命名地點').slice(0, 100),
          address: String(r.address || '').slice(0, 200),
          note: String(r.note || '').slice(0, 300),
          lng, lat,
          adcode: /^\d{6}$/.test(String(r.adcode ?? '')) ? String(r.adcode) : '',
          createdAt: Number(r.createdAt) || t,
          updatedAt: t,
        });
      }
      write(mergeLists(read(), clean, now()));
      return clean.length;
    },
  };
}
