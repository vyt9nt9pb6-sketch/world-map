// 搜尋歷史（只存在這台裝置的 localStorage，不上傳）。最多 15 筆，新的在前，同字串去重。
const KEY = 'wm.searchHistory.v1';
export const MAX_HISTORY = 15;

export function createHistory(storage = globalThis.localStorage, now = Date.now) {
  const read = () => {
    try {
      const v = JSON.parse(storage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => x && typeof x.q === 'string' && x.q) : [];
    } catch {
      return [];
    }
  };
  const write = (list) => {
    try {
      storage.setItem(KEY, JSON.stringify(list));
    } catch {
      /* 無痕模式或空間不足：略過 */
    }
    return list;
  };
  return {
    list: read,
    add(q) {
      const text = String(q ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
      if (!text) return read();
      const rest = read().filter((x) => x.q.toLowerCase() !== text.toLowerCase());
      return write([{ q: text, at: now() }, ...rest].slice(0, MAX_HISTORY));
    },
    remove(q) {
      return write(read().filter((x) => x.q !== q));
    },
    clear() {
      return write([]);
    },
    /** 輸入時的建議：以輸入文字開頭或包含者 */
    suggest(prefix) {
      const p = String(prefix ?? '').trim().toLowerCase();
      const all = read();
      return p ? all.filter((x) => x.q.toLowerCase().includes(p)) : all;
    },
  };
}
