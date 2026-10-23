// 打包單檔 Worker：worker/bundled.js + core/ + 內嵌 public/ → dist/worker.js
import { build } from 'esbuild';
import { readdir, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '': 'text/plain; charset=utf-8',
};

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

export async function buildWorker() {
  const map = {};
  for (const f of await walk(PUBLIC)) {
    const buf = await readFile(f);
    const key = '/' + relative(PUBLIC, f).split('\\').join('/');
    map[key] = {
      type: TYPES[extname(f)] ?? 'application/octet-stream',
      hash: createHash('sha256').update(buf).digest('hex').slice(0, 16),
      b64: buf.toString('base64'),
    };
  }
  await mkdir(join(ROOT, 'dist'), { recursive: true });
  const outfile = join(ROOT, 'dist/worker.js');
  await build({
    entryPoints: [join(ROOT, 'worker/bundled.js')],
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', minify: false,
    outfile, logLevel: 'warning',
    plugins: [{
      name: 'assets',
      setup(b) {
        b.onResolve({ filter: /^virtual:assets$/ }, () => ({ path: 'assets', namespace: 'virtual' }));
        b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: `export const ASSETS_MAP = ${JSON.stringify(map)};`, loader: 'js' }));
      },
    }],
  });
  return { outfile, files: Object.keys(map).length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await buildWorker();
  console.log(`✔ 已打包 ${r.files} 個靜態檔 → ${relative(ROOT, r.outfile)}`);
}
