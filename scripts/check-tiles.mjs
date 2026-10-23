// 檢查前端實際使用的高德圖磚網址是否回 200 圖片（連雲港附近 z12 / z15）。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { TILE_URLS } from '../public/js/lib/layers.js';

const tile = (z, lng, lat) => {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x, y, z };
};
let failed = 0;
for (const [name, tpl] of Object.entries(TILE_URLS)) {
  for (const z of [12, 15]) {
    const t = tile(z, 119.3389, 34.7603);
    const url = tpl.replace('{s}', '1').replace('{x}', t.x).replace('{y}', t.y).replace('{z}', t.z);
    let out = 'curl-error';
    for (let attempt = 0; attempt < 3 && out === 'curl-error'; attempt++) {
      try {
        out = execFileSync('curl', ['-s', '-m', '20', '-o', '/tmp/wm-tile.bin', '-w', '%{http_code} %{content_type} %{size_download}', url]).toString();
      } catch {}
    }
    let dims = '';
    try {
      const b = readFileSync('/tmp/wm-tile.bin');
      if (b[0] === 0x89) dims = `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}px`;
      else if (b[0] === 0xff) {
        for (let i = 2; i < b.length - 9; ) {
          const m = b[i + 1];
          if (m >= 0xc0 && m <= 0xc2) { dims = `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}px`; break; }
          i += 2 + b.readUInt16BE(i + 2);
        }
      }
    } catch {}
    const ok = /^200 image\//.test(out);
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✘'} ${name.padEnd(17)} z${z}  ${out}  ${dims}`);
  }
}
process.exit(failed ? 1 : 0);
