// 分享／標記我的位置。座標一律是 GCJ-02（高德 uri.amap.com 也用 GCJ-02）。

const fmt = (n) => Number(n).toFixed(6);

/** 高德地圖「標記點」連結：任何裝置點開都會顯示該點；安裝了高德 App 的手機會喚起 App。 */
export function amapMarkerUrl({ lng, lat, name }) {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) throw new Error('lng/lat required');
  const q = new URLSearchParams();
  q.set('position', `${fmt(lng)},${fmt(lat)}`);
  q.set('name', String(name || '我的位置').slice(0, 60));
  q.set('src', 'WorldMap');
  q.set('coordinate', 'gaode');
  q.set('callnative', '1');
  return `https://uri.amap.com/marker?${q}`;
}

export function shareMessage({ name, url }) {
  return `${name || '我的位置'}（高德地圖連結）：${url}`;
}

/**
 * 簡訊連結。iOS 要用 `sms:&body=`（`sms:?body=` 在部分 iOS 版本會丟掉內文），
 * Android 與其他平台用 `sms:?body=`。不指定收件人，讓使用者自己選。
 */
export function smsHref(body, platform = {}) {
  const sep = platform.isIOS ? '&' : '?';
  return `sms:${sep}body=${encodeURIComponent(body)}`;
}

/** 依環境決定可用的分享管道（純函式，方便測試） */
export function shareChannels(nav = {}, platform = {}) {
  return {
    native: typeof nav.share === 'function',
    sms: !!platform.isMobile,
    copy: true,
  };
}

export async function copyText(text, nav = globalThis.navigator, doc = globalThis.document) {
  try {
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 退回舊方法 */
  }
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
    doc.body.appendChild(ta);
    ta.select();
    const ok = doc.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch {
    return false;
  }
}
