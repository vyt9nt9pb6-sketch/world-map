import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createDefaultLimiter } from '../core/ratelimit.js';

test('Cloudflare Worker：非 API 交給靜態資產，未知 API 回 404', async () => {
  const env = { AMAP_KEY: 'X'.repeat(32), ASSETS: { fetch: async () => new Response('static') } };
  assert.equal(await (await worker.fetch(new Request('https://w.example/index.html'), env)).text(), 'static');
  assert.equal((await worker.fetch(new Request('https://w.example/api/nope'), env)).status, 404);
});

test('預設限流：每 IP 與全站總量', () => {
  const rl = createDefaultLimiter({ RATE_BURST: '2', RATE_PER_SEC: '0', GLOBAL_BURST: '3', GLOBAL_PER_SEC: '0' });
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, true);
  assert.equal(rl.take('a').ok, false); // 單一 IP 用完
  assert.equal(rl.take('b').ok, true);
  assert.equal(rl.take('c').ok, false); // 全站用完
});
