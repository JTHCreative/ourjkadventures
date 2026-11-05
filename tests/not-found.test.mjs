// Tests for the "page not found" page (server/not-found.js): any address we don't have shows site/404.html,
// still answered as a 404, and real pages and the pup pages are left alone.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { env as baseEnv } from './helpers.mjs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const files = { '/404': read('site/404.html'), '/shop': read('site/shop.html'), '/products.json': read('site/products.json') };
const assets = {
  fetch: async (req) => {
    const path = new URL(req.url || req).pathname;
    return path in files ? new Response(files[path], { headers: { 'Content-Type': 'text/html' } }) : new Response('not found', { status: 404 });
  }
};
const call = (path, method = 'GET') => worker.fetch(new Request('https://x.test' + path, { method }), { ...baseEnv, ASSETS: assets });

test('an address we don\'t have shows the friendly page, as a 404', async () => {
  for (const path of ['/no-such-page', '/a/b/c', '/pup-club/not-a-dog', '/pup-club/bay-area-pin-board']) {
    const res = await call(path);
    assert.equal(res.status, 404, path);
    assert.match(res.headers.get('Content-Type'), /text\/html/, path);
    assert.match(await res.text(), /this page wandered off\./, path);
  }
  const head = await call('/no-such-page', 'HEAD');
  assert.equal(head.status, 404);
  assert.equal(await head.text(), '');
});

test('real pages are untouched, and the 404 page stays out of search', async () => {
  const res = await call('/shop');
  assert.equal(res.status, 200);
  assert.equal(await res.text(), files['/shop']);
  assert.match(files['/404'], /<meta name="robots" content="noindex">/);
  assert.match(files['/404'], /<base href="\/">/);
});
