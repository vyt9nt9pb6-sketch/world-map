// 高德即時路況（AMap.TileLayer.Traffic）。圖磚由高德直接提供，沿用頁面上的 AMAP_JS_KEY。
// 官方預設不自動更新；這裡打開 autoRefresh，間隔 180 秒（API 預設值）。

export const TRAFFIC_INTERVAL_SEC = 180;

/** 與高德路況圖磚一致的四段：暢通／緩行／擁堵／嚴重擁堵。 */
export const TRAFFIC_LEGEND = [
  { id: 'smooth', name: '暢通', color: '#34b000' },
  { id: 'slow', name: '緩行', color: '#fecb00' },
  { id: 'jam', name: '擁堵', color: '#df0100' },
  { id: 'severe', name: '嚴重擁堵', color: '#8e0e0b' },
];

export function trafficLayerOptions(extra = {}) {
  return {
    zIndex: 14,
    opacity: 0.92,
    autoRefresh: true,
    interval: TRAFFIC_INTERVAL_SEC,
    zooms: [6, 20],
    ...extra,
  };
}

export function trafficLegendHtml() {
  const items = TRAFFIC_LEGEND.map((s) => `<span class="tl"><i style="background:${s.color}"></i>${s.name}</span>`).join('');
  return `${items}<span class="heat-unit">高德即時路況 · 約每 ${Math.round(TRAFFIC_INTERVAL_SEC / 60)} 分鐘更新</span>`;
}

export function createTrafficLayer(AMap, extra = {}) {
  if (!AMap?.TileLayer?.Traffic) throw new Error('這份高德 JS API 沒有路況圖層');
  return new AMap.TileLayer.Traffic(trafficLayerOptions(extra));
}
