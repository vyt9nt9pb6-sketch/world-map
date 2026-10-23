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
console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
