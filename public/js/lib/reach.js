// 「Google 連得到嗎？」快速偵測（VPN 有開才連得到）。
// 只對 tile.googleapis.com 發一個 no-cors 請求：能收到任何回應（含 404／403）＝可達；網路錯誤或逾時＝不可達。
// 結果暫存 60 秒，避免每次切換圖層都等一次逾時。CSP 的 connect-src 已允許 tile.googleapis.com。
export function createReachProbe({ url = 'https://tile.googleapis.com/', timeoutMs = 2500, ttlMs = 60000, fetchImpl = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let last = { t: -Infinity, ok: false };
  let inflight = null;
  return async function reachable(force = false) {
    if (!force && now() - last.t < ttlMs) return last.ok;
    if (inflight) return inflight;
    inflight = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let ok = false;
      try {
        await fetchImpl(url, { mode: 'no-cors', cache: 'no-store', signal: ctl.signal });
        ok = true;
      } catch {
        ok = false;
      } finally {
        clearTimeout(timer);
      }
      last = { t: now(), ok };
      inflight = null;
      return ok;
    })();
    return inflight;
  };
}
