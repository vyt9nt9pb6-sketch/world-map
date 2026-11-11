import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { assetCacheControl, rewriteAssetUrls, versionFromEtag } from '../core/asset-rev.js';

test('靜態檔快取：HTML／JS／CSS 每次都要確認，圖與人口網格可以快取', () => {
  assert.equal(assetCacheControl('text/html; charset=utf-8'), 'no-cache');
  assert.equal(assetCacheControl('text/javascript; charset=utf-8'), 'no-cache');
  assert.equal(assetCacheControl('text/css; charset=utf-8'), 'no-cache');
  assert.equal(assetCacheControl('application/gzip'), 'public, max-age=3600');
  assert.equal(assetCacheControl('image/png'), 'public, max-age=3600');
});

test('HTML 進入點加上 ?v=etag，其他網址不動，也不重複加', () => {
  const html = '<link rel="stylesheet" href="/css/app.css" /><link rel="stylesheet" href="/css/glass.css" /><script type="module" src="/js/app.js"></script><a href="/js/lib/coords.js">x</a>';
  const out = rewriteAssetUrls(html, {
    '/js/app.js': versionFromEtag('abc123'),
    '/css/app.css': versionFromEtag('"def"'),
    '/css/glass.css': versionFromEtag('W/"ghi"'),
  });
  assert.match(out, /src="\/js\/app\.js\?v=abc123"/);
  assert.match(out, /href="\/css\/app\.css\?v=def"/);
  assert.match(out, /href="\/css\/glass\.css\?v=ghi"/);
  assert.match(out, /href="\/js\/lib\/coords\.js"/);
  assert.equal(rewriteAssetUrls(out, { '/js/app.js': 'zzz' }), out);
  assert.equal(versionFromEtag('W/"abc123"'), 'abc123');
});

test('Worker 回 HTML 時改寫 app.js 網址，所以舊的 max-age 快取用不上', async () => {
  const html = '<!doctype html><script type="module" src="/js/app.js"></script><link rel="stylesheet" href="/css/app.css" /><link rel="stylesheet" href="/css/glass.css" />';
  const etag = { '/js/app.js': '"v5js"', '/css/app.css': '"v5css"', '/css/glass.css': '"v5glass"' };
  const env = {
    ASSETS: {
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (etag[path]) return new Response('', { status: 200, headers: { etag: etag[path] } });
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', etag: '"raw-html"' } });
      },
    },
  };
  const res = await worker.fetch(new Request('https://w.example/'), env);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.match(body, /src="\/js\/app\.js\?v=v5js"/);
  assert.match(body, /href="\/css\/app\.css\?v=v5css"/);
  assert.match(body, /href="\/css\/glass\.css\?v=v5glass"/);
  assert.notEqual(res.headers.get('etag'), '"raw-html"');
  const again = await worker.fetch(new Request('https://w.example/', { headers: { 'if-none-match': res.headers.get('etag') } }), env);
  assert.equal(again.status, 304);
});
