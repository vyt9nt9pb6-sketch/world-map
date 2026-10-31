// 共用的 HTTP 小工具（無外部相依）

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'private, max-age=60' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
  });
}

/** 含使用者資料或登入狀態的回應：絕不快取 */
export function jsonNoStore(body, status = 200, extraHeaders = {}) {
  return json(body, status, { 'cache-control': 'no-store', ...extraHeaders });
}

export function errorResponse(status, code, message, field, infocode) {
  // infocode 是高德公開的錯誤代碼（例如 10009），方便排查；不含任何金鑰或網址
  return json({ error: { code, message, ...(field ? { field } : {}), ...(infocode ? { infocode } : {}) } }, status);
}

const MAX_BODY = 256 * 1024;

/** 讀取 JSON 請求本文：限制大小、限制 Content-Type */
export async function readJson(request, maxBytes = MAX_BODY) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (!ct.startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type', '請以 application/json 傳送');
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw new HttpError(413, 'too_large', '資料太大');
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'too_large', '資料太大');
  try {
    const v = JSON.parse(text);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw new HttpError(400, 'invalid_json', '資料格式錯誤');
  }
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
