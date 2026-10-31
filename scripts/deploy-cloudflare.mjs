// 重新部署到 Cloudflare Workers（單檔 Worker，靜態檔已內嵌）。
//
// 用法：
//   node scripts/deploy-cloudflare.mjs            # 打包並產生 .run/cf-deploy.js（不含金鑰）
//   node scripts/deploy-cloudflare.mjs --secret   # 另外產生 .run/set-secret.js（含金鑰！用完立刻刪）
//
// 產生的檔案是給 Grok Bot 的 Cloudflare 連接器（execute 工具）用的：
//   execute {"code": "$file:/workspace/world-map/.run/cf-deploy.js"}
//   execute {"code": "$file:/workspace/world-map/.run/set-secret.js"}  → 之後 shred -u .run/set-secret.js
// 注意：Grok Bot 連接器會遮蔽像金鑰的字串，set-secret.js 經連接器送出時金鑰會被換成佔位字；
// 請改在 Cloudflare 後台設定 AMAP_KEY（README 有步驟）。
// 若有 wrangler 權杖（CLOUDFLARE_API_TOKEN），也可直接：npx wrangler deploy（用 wrangler.toml 的 Static Assets）。
//
// 本腳本絕不印出金鑰。
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildWorker } from './build-worker.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NAME = process.env.CF_WORKER_NAME || 'world-map';
const COMPAT = '2026-10-01';
const RUN = join(ROOT, '.run');

const { outfile } = await buildWorker();
const code = await readFile(outfile, 'utf8');
const key = process.env.AMAP_KEY;
if (key && code.includes(key)) {
  console.error('✘ 打包結果含有金鑰，停止。');
  process.exit(1);
}

// KV 命名空間（收藏／登入用）。先建立：見 README「Cloudflare 部署」。
//   CF_KV_NAMESPACE_ID=<id> node scripts/deploy-cloudflare.mjs
const KV_ID = process.env.CF_KV_NAMESPACE_ID;
const metadata = {
  main_module: 'worker.js',
  compatibility_date: COMPAT,
  bindings: [
    // 每個 IP 每 60 秒最多 60 次 /api 請求（Cloudflare Rate Limiting 綁定）
    { type: 'ratelimit', name: 'API_RATE_LIMIT', namespace_id: '1001', simple: { limit: 60, period: 60 } },
    ...(KV_ID ? [{ type: 'kv_namespace', name: 'WM_KV', namespace_id: KV_ID }] : []),
  ],
  // 重新部署時保留所有「秘密」（AMAP_KEY、TIANDITU_TK、AMAP_JS_*、BREVO_API_KEY…）與純文字變數，絕不覆蓋
  keep_bindings: ['secret_text', 'plain_text'],
  observability: { enabled: false },
};

await mkdir(RUN, { recursive: true });
const deployJs = `async () => {
  const name = ${JSON.stringify(NAME)};
  const metadata = ${JSON.stringify(metadata)};
  const code = ${JSON.stringify(code)};
  const b = 'WMB' + Date.now();
  const body = ['--' + b, 'Content-Disposition: form-data; name="metadata"', 'Content-Type: application/json', '', JSON.stringify(metadata),
    '--' + b, 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"', 'Content-Type: application/javascript+module', '', code,
    '--' + b + '--', ''].join('\\r\\n');
  const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/\${name}\`, body, contentType: 'multipart/form-data; boundary=' + b, rawBody: true });
  let sub;
  try {
    sub = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/workers/scripts/\${name}/subdomain\`, body: { enabled: true, previews_enabled: false } });
  } catch (e) { sub = { success: false, error: String(e.message).slice(0, 200) }; }
  return { deployed: r.success, etag: r.result?.etag, bindings: (r.result?.bindings || []).map(x => x.name + ':' + x.type), subdomainEnabled: sub.success, subErr: sub.error };
}`;
await writeFile(join(RUN, 'cf-deploy.js'), deployJs, { mode: 0o600 });
console.log(KV_ID ? '✔ 含 KV 綁定 WM_KV' : '⚠ 未設 CF_KV_NAMESPACE_ID：收藏／登入功能不會啟用');
console.log(`✔ .run/cf-deploy.js（${(deployJs.length / 1024).toFixed(0)} KB，不含金鑰）`);

if (process.argv.includes('--secret')) {
  if (!key) { console.error('✘ 沒有 AMAP_KEY 環境變數'); process.exit(1); }
  const secretJs = `async () => {
  const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/${NAME}/secrets\`, body: { name: 'AMAP_KEY', type: 'secret_text', text: ${JSON.stringify(key)} } });
  return { success: r.success, name: r.result?.name, type: r.result?.type };
}`;
  await writeFile(join(RUN, 'set-secret.js'), secretJs, { mode: 0o600 });
  console.log('✔ .run/set-secret.js（含金鑰，用完請 shred -u）');
}
