// 確認金鑰沒有出現在前端檔案、git 追蹤的檔案或 git 歷史中。
// 只比對 $AMAP_KEY 的值，絕不印出它。可選參數：要額外檢查的網址（例如 tunnel 網址）。
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const key = process.env.AMAP_KEY;
if (!key || key.length < 16) {
  console.error('✘ 環境變數 AMAP_KEY 未設定，無法比對');
  process.exit(2);
}
const hits = [];
// 同時比對其他伺服器端機密（只在環境變數有設定時才檢查；絕不印出值）
const secrets = [key, ...['AMAP_JS_SECURITY_CODE', 'BREVO_API_KEY', 'RESEND_API_KEY', 'AUTH_SECRET'].map((n) => process.env[n]).filter((v) => v && v.length >= 12)];
const scan = (label, buf) => {
  if (secrets.some((k) => buf.includes(k))) hits.push(label);
};

// 1) public/（前端會送到瀏覽器的所有檔案）
let nFiles = 0;
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else { nFiles++; scan('public:' + relative(root, p), readFileSync(p)); }
  }
};
walk(join(root, 'public'));
console.log(`• public/ 掃描 ${nFiles} 個檔案`);

// 2) git 追蹤與暫存的檔案、3) git 歷史中所有 blob
const git = (...a) => execFileSync('git', a, { cwd: root, maxBuffer: 1 << 28 });
if (existsSync(join(root, '.git'))) {
  const files = git('ls-files', '-z', '--cached').toString().split('\0').filter(Boolean);
  for (const f of files) {
    try { scan('git-index:' + f, git('show', ':' + f)); } catch {}
  }
  console.log(`• git 追蹤檔案 ${files.length} 個`);
  let blobs = [];
  try {
    blobs = git('rev-list', '--all', '--objects').toString().split('\n').filter(Boolean).map((l) => l.split(' ')[0]);
  } catch {}
  let nb = 0;
  for (const sha of blobs) {
    try {
      if (git('cat-file', '-t', sha).toString().trim() !== 'blob') continue;
      nb++;
      scan('git-history:' + sha, git('cat-file', '-p', sha));
    } catch {}
  }
  try { scan('git-log-messages', git('log', '--all', '--format=%B')); } catch {}
  console.log(`• git 歷史 blob ${nb} 個`);
}

// 4) 選填：線上網址抓回來的前端檔案
for (const base of process.argv.slice(2)) {
  for (const p of ['/', '/index.html', '/js/app.js', '/js/lib/api.js', '/js/lib/amap-map.js', '/js/lib/sheet.js', '/js/lib/navlinks.js', '/js/lib/coords.js', '/js/lib/format.js', '/css/app.css', '/manifest.webmanifest']) {
    const res = await fetch(base.replace(/\/$/, '') + p);
    scan('url:' + p, Buffer.from(await res.arrayBuffer()));
    // 回應標頭也查
    scan('url-headers:' + p, Buffer.from(JSON.stringify([...res.headers])));
  }
  console.log(`• 線上網址前端檔案已檢查：${base}`);
}

if (hits.length) {
  console.error(`✘ 在 ${hits.length} 處發現金鑰：\n  ` + hits.join('\n  '));
  process.exit(1);
}
console.log('✔ 沒有發現金鑰');
