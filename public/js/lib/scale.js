// 比例尺：依縮放層級與緯度算「每像素幾公尺」，挑一個整齊的長度（1、2、5 × 10^n 公尺）。
// Web Mercator：256px 圖磚，zoom 0 時赤道約 156543.03 m/px。
export function metersPerPixel(zoom, lat) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

const STEPS = [1, 2, 5];

/** @returns {{meters:number, px:number, label:string}} px 不超過 maxPx */
export function scaleBar(zoom, lat, maxPx = 96) {
  const mpp = metersPerPixel(zoom, lat);
  if (!(mpp > 0) || !Number.isFinite(mpp)) return { meters: 0, px: 0, label: '' };
  const maxMeters = mpp * maxPx;
  let best = 1;
  for (let p = 0.1; p <= 1e7; p *= 10) {
    for (const s of STEPS) {
      const v = s * p;
      if (v <= maxMeters) best = v;
    }
  }
  const label = best >= 1000 ? `${+(best / 1000).toFixed(0)} 公里` : best >= 1 ? `${Math.round(best)} 公尺` : `${best} 公尺`;
  return { meters: best, px: Math.round(best / mpp), label };
}
