// 可插拔的郵件寄送器。由環境變數選擇：
//   MAIL_PROVIDER = brevo | resend | cloudflare
//   MAIL_FROM     = 寄件人地址（必須是該服務已驗證的地址／網域）
//   MAIL_FROM_NAME（選填，預設「地圖」）
//   BREVO_API_KEY / RESEND_API_KEY（秘密，只放後端）；cloudflare 則用 [[send_email]] binding 名稱 EMAIL
// 沒設定時 createMailer 回傳 null，登入功能會顯示「尚未啟用」。API 金鑰不會出現在任何回應或日誌。

export class MailError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'MailError';
    this.status = status;
  }
}

const TIMEOUT = 10000;

async function post(fetchImpl, url, headers, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch {
    throw new MailError('mail provider unreachable');
  }
  if (!res.ok) throw new MailError('mail provider rejected the request', res.status);
}

function brevo(env, fetchImpl) {
  return {
    name: 'brevo',
    send: ({ to, subject, text, html }) =>
      post(
        fetchImpl,
        'https://api.brevo.com/v3/smtp/email',
        { 'api-key': env.BREVO_API_KEY },
        {
          sender: { name: env.MAIL_FROM_NAME || '地圖', email: env.MAIL_FROM },
          to: [{ email: to }],
          subject,
          textContent: text,
          htmlContent: html,
        },
      ),
  };
}

function resend(env, fetchImpl) {
  return {
    name: 'resend',
    send: ({ to, subject, text, html }) =>
      post(
        fetchImpl,
        'https://api.resend.com/emails',
        { authorization: `Bearer ${env.RESEND_API_KEY}` },
        { from: `${env.MAIL_FROM_NAME || '地圖'} <${env.MAIL_FROM}>`, to: [to], subject, text, html },
      ),
  };
}

function cloudflare(env) {
  return {
    name: 'cloudflare',
    async send({ to, subject, text, html }) {
      try {
        await env.EMAIL.send({ to, from: { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME || '地圖' }, subject, text, html });
      } catch {
        throw new MailError('cloudflare email send failed');
      }
    },
  };
}

/** @returns {{name:string, send(msg:{to,subject,text,html}):Promise<void>} | null} */
export function createMailer(env, fetchImpl = fetch) {
  const provider = String(env?.MAIL_PROVIDER || '').toLowerCase();
  if (!env?.MAIL_FROM) return null;
  if (provider === 'brevo' && env.BREVO_API_KEY) return brevo(env, fetchImpl);
  if (provider === 'resend' && env.RESEND_API_KEY) return resend(env, fetchImpl);
  if (provider === 'cloudflare' && env.EMAIL && typeof env.EMAIL.send === 'function') return cloudflare(env);
  return null;
}
