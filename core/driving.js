// 駕車多路線規劃：把高德 v5（strategy 32–45 可回多條）與 v3（strategy 10–20 多條、11＝時間最短／距離最短／躲避擁堵）
// 的結果合併、去重、標記（最快／最短／推薦／少收費…），讓使用者自由挑選。
//
// 已查證的高德策略（官方文件：路徑規劃 2.0 與 路徑規劃 v3，2026 年版）：
//   v5：32 推薦(同 App 預設)  33 躲避擁堵  34 高速優先  35 不走高速  36 少收費  37 大路優先  38 速度最快
//       40 躲避擁堵+不走高速  42 少收費+不走高速  43 躲避擁堵+少收費+不走高速   1 費用優先(不走收費路段，只回一條)
//   v3：11 時間最短＋距離最短＋躲避擁堵(三條)  13 不走高速  14 避免收費  15 躲避擁堵+不走高速
//       16 避免收費+不走高速   7 費用優先：不走高速且避免所有收費路段(一條)
// v5 沒有「距離最短」策略，所以「最短距離」來自 v3 strategy 11；開了「避開高速／收費」時改用合併後距離最短者標記。
import { mapRouteResponse, mapDrivingV3Response } from './mapping.js';

/** 依開關決定要查哪些 (版本, 策略)。每次最多 3 個上游請求（高德個人金鑰日額度有限）。 */
export function planCalls({ avoidHighway, avoidToll, strategy }) {
  if (avoidHighway && avoidToll) return [['v5', '42'], ['v3', '16'], ['v3', '7']];
  if (avoidToll) return [['v5', '1'], ['v5', '36'], ['v3', '14']];
  if (avoidHighway) return [['v5', '35'], ['v5', '40'], ['v3', '13']];
  // 舊參數 strategy（highway/fastest…）仍然支援
  if (strategy && strategy !== 'recommend') return [['v5', { fastest: '38', highway: '34', no_highway: '35', avoid_tolls: '1' }[strategy] ?? '32'], ['v3', '11']];
  return [['v5', '32'], ['v3', '11']];
}

export function haversine(a, b) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(x)));
}

const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(a, b, 1);

export function isDuplicate(a, b) {
  const sameRoads = a.roads.length > 0 && a.roads.join('|') === b.roads.join('|');
  if (sameRoads && near(a.distance, b.distance, 0.03)) return true;
  return near(a.distance, b.distance, 0.005) && near(a.duration, b.duration, 0.05);
}

/** 合併多組結果：去重（保留先出現者）、標記、排序、最多 maxRoutes 條 */
export function mergeRoutes(groups, { avoidToll = false, maxRoutes = 5 } = {}) {
  const unique = [];
  for (const g of groups) {
    for (const r of g.routes) {
      if (!r.polyline?.length) continue;
      if (unique.some((u) => isDuplicate(u, r))) continue;
      unique.push({ ...r, tags: [] });
    }
  }
  if (!unique.length) return [];
  let pool = unique;
  let tollNote = null;
  if (avoidToll) {
    const free = unique.filter((r) => !r.tolls);
    if (free.length) pool = free;
    else tollNote = 'no_toll_free'; // 找不到完全免費的路線：照實保留並提示
  }
  const by = (key, dir = 1) => [...pool].sort((a, b) => dir * ((a[key] ?? 1e12) - (b[key] ?? 1e12)))[0];
  const fastest = by('duration');
  const shortest = by('distance');
  fastest.tags.push('fastest');
  shortest.tags.push('shortest');
  const hasTolls = pool.some((r) => r.tolls > 0);
  if (hasTolls) {
    const cheapest = by('tolls');
    if (cheapest.tolls != null && pool.some((r) => (r.tolls ?? 0) > cheapest.tolls)) cheapest.tags.push('leastToll');
  }
  if (pool.some((r) => r.trafficLights != null)) {
    const calm = by('trafficLights');
    if (pool.some((r) => (r.trafficLights ?? 0) > (calm.trafficLights ?? 0))) calm.tags.push('leastLights');
  }
  // 第一組的第一條＝高德推薦（同 App 預設）
  const first = groups.find((g) => g.routes.length)?.routes[0];
  const rec = pool.find((r) => first && isDuplicate(r, first)) ?? pool[0];
  rec.tags.unshift('recommend');
  // 排序：推薦 → 最快 → 最短 → 其餘依時間；保證最快、最短一定在內
  const must = [rec, fastest, shortest].filter((r, i, a) => a.indexOf(r) === i);
  const rest = pool.filter((r) => !must.includes(r)).sort((a, b) => (a.duration ?? 1e12) - (b.duration ?? 1e12));
  const ordered = [...must, ...rest].slice(0, maxRoutes);
  const out = ordered.map((r, i) => ({ ...r, index: i }));
  if (tollNote) out.tollNote = tollNote;
  return out;
}

/** 轉成 UI 用的格式並加上直線距離／繞行比 */
export function decorate(routes, straight) {
  return routes.map((r) => ({
    ...r,
    straightDistance: straight,
    detour: straight > 0 && r.distance ? Math.round((r.distance / straight) * 100) / 100 : null,
  }));
}

export { mapRouteResponse, mapDrivingV3Response };
