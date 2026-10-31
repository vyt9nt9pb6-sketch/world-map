// 用真實查詢呼叫本機代理的 /api 端點（不需要、也不會印出金鑰）。
// 用法：node scripts/api-smoke.mjs [baseUrl]   預設 http://127.0.0.1:8787
const base = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const key = process.env.AMAP_KEY || '';
let failed = 0;

async function call(path) {
  const t = Date.now();
  const res = await fetch(base + path);
  const text = await res.text();
  if (key && text.includes(key)) throw new Error('回應中出現金鑰！');
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ms: Date.now() - t, body, headers: res.headers };
}
function check(name, cond, info) {
  console.log(`${cond ? '✔' : '✘'} ${name}${info ? ' — ' + info : ''}`);
  if (!cond) failed++;
}

const LYG = '119.221611,34.596653';

{
  const r = await call('/api/search?q=' + encodeURIComponent('加油站') + '&location=' + LYG);
  const top = r.body.results?.slice(0, 3).map((p) => `${p.name}（${p.distance ?? '?'}m）`).join('、');
  check('搜尋 加油站 @連雲港', r.status === 200 && r.body.results?.length > 0, `${r.status}, ${r.body.results?.length} 筆, 來源 ${r.body.source}, ${r.ms}ms：${top}`);
}
{
  const r = await call('/api/geocode?address=' + encodeURIComponent('江蘇省連雲港市連雲區'));
  const g = r.body.results?.[0];
  check('地址解析 江蘇省連雲港市連雲區', r.status === 200 && !!g, g ? `${g.name} → ${g.lng},${g.lat}（${g.level}）` : JSON.stringify(r.body));
}
{
  const g = await call('/api/geocode?address=' + encodeURIComponent('南京市'));
  const nj = g.body.results?.[0];
  for (const strategy of ['recommend', 'fastest', 'avoid_tolls']) {
    const r = await call(`/api/route?origin=${LYG}&destination=${nj.lng},${nj.lat}&strategy=${strategy}`);
    const s = (r.body.routes || []).map((x) => `${(x.distance / 1000).toFixed(1)}km/${Math.round(x.duration / 60)}分/¥${x.tolls}/${x.polyline.length}點`).join('；');
    check(`路線 連雲港→南京 [${strategy}]`, r.status === 200 && r.body.routes?.length > 0 && r.body.routes[0].polyline.length > 100, `${r.ms}ms：${s}`);
  }
}
{
  const r = await call('/api/route?origin=bad&destination=1,2');
  check('無效參數 → 400', r.status === 400 && r.body.error?.field === 'origin', r.body.error?.message);
  const r2 = await call('/api/v3/ip');
  check('非白名單端點 → 404', r2.status === 404);
  const r3 = await call('/api/search?q=a&key=evil');
  check('使用者傳的 key 被忽略', r3.status === 200);
}
// ───────── v2 ─────────
{
  const r = await call('/api/config');
  const txt = JSON.stringify(r.body);
  check('/api/config 結構', r.status === 200 && r.body.features && typeof r.body.features.auth === 'boolean', `features=${JSON.stringify(r.body.features)}`);
  check('/api/config 不含金鑰欄位', !/AMAP_KEY|security|BREVO|RESEND/i.test(txt));
}
for (const [kind, label] of [['toilet', '廁所'], ['gas', '加油站'], ['ev', '充電站']]) {
  const r = await call(`/api/nearby?kind=${kind}&location=${LYG}&radius=3000`);
  const top = r.body.results?.slice(0, 2).map((p) => `${p.name}（${p.distance}m）`).join('、');
  check(`附近${label}`, r.status === 200 && r.body.results?.length > 0 && r.body.results.every((p) => Number.isFinite(p.lng) && Number.isFinite(p.lat)), `${r.body.results?.length} 筆, ${r.ms}ms：${top}`);
}
{
  const r = await call('/api/nearby?kind=bank&location=' + LYG);
  check('附近 無效 kind → 400', r.status === 400);
}
const A = '119.221611,34.596653', B = '119.2300,34.6000';
for (const mode of ['walking', 'bicycling', 'electrobike']) {
  const r = await call(`/api/route?mode=${mode}&origin=${A}&destination=${B}`);
  const x = r.body.routes?.[0];
  check(`${mode} 路線`, r.status === 200 && !!x && x.polyline?.length > 2 && x.steps?.length > 0, x ? `${x.distance}m/${Math.round(x.duration / 60)}分/${x.steps.length}步/${x.polyline.length}點 ${r.ms}ms` : JSON.stringify(r.body).slice(0, 200));
}
{
  const g = await call('/api/geocode?address=' + encodeURIComponent('南京站'));
  const nj = g.body.results?.[0];
  const r = await call(`/api/route?mode=transit&origin=${LYG}&destination=${nj.lng},${nj.lat}`);
  const rs = r.body.routes || [];
  const trains = rs.flatMap((x) => x.segments.filter((s) => s.type === 'train'));
  const t = trains[0];
  check('公交/火車 連雲港→南京', r.status === 200 && rs.length > 0, `${rs.length} 條, ${r.ms}ms`);
  check('火車段含全部停靠站', !!t && t.stops?.length >= 3, t ? `${t.name || t.trip} ${t.stops.map((s) => s.name).join('→')}` : '無火車段');
  check('火車段含推測線路名稱', !!t && t.lineMatch?.estimated === true && t.lineMatch.sections?.length > 0, t?.lineMatch?.sections?.map((s) => s.line).join(' → '));
}
{
  const r = await call('/api/auth/me');
  check('auth/me 未登入 → user:null', r.status === 200 && r.body.user === null);
  const f = await call('/api/favorites');
  check('favorites 未登入 → 401', f.status === 401);
  const c = await fetch(base + '/api/auth/request-code', { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ email: 'not-an-email' }) });
  check('request-code 無效信箱 → 400（或未設定寄信 503）', [400, 503].includes(c.status), `status ${c.status}`);
}
{
  const u = 'https://uri.amap.com/marker?position=119.221600%2C34.596700&name=test&coordinate=gaode';
  const p = new URL(u);
  check('分享連結格式（GCJ-02 lng,lat）', p.hostname === 'uri.amap.com' && /^[\d.]+,[\d.]+$/.test(p.searchParams.get('position')));
}
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
