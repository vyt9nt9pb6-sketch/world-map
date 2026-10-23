// 顯示格式（繁體中文）

export function formatDistance(meters) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m < 0) return '—';
  if (m < 1000) return `${Math.round(m)} 公尺`;
  if (m < 100000) return `${(m / 1000).toFixed(1)} 公里`;
  return `${Math.round(m / 1000)} 公里`;
}

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '—';
  const totalMin = Math.max(1, Math.round(s / 60));
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (h === 0) return `${min} 分鐘`;
  if (min === 0) return `${h} 小時`;
  return `${h} 小時 ${min} 分`;
}

export function formatYuan(yuan) {
  if (yuan == null || yuan === '') return '—';
  const y = Number(yuan);
  if (!Number.isFinite(y) || y < 0) return '—';
  if (y === 0) return '免費';
  return `¥${Math.round(y)}`;
}
