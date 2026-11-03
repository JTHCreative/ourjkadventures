// Tests for the shop's featured carousel: the owner's picks on /admin, and what /api/catalog shows from them.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const OWNER = 'owner@example.com';

// the fake Square has aussie (3 standard, 48 large) in stock and the pomeranian ticked sold out; corgi is not linked
function setup({ open = true, featured } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: open } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), pomeranian: str('V_POM') };
  if (featured !== undefined) w.g.docs['settings/featured_sandbox'] = { slugs: str(featured) };
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) } };
  const call = async (method, path, token, body) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { ...w, env, call };
}
const catalog = async (s) => (await s.call('GET', '/api/catalog')).json();

test('the carousel shows only picks that are in stock, in the order chosen', async () => {
  const s = setup({ featured: 'pomeranian,corgi,aussie,not-a-pin' });
  const c = await catalog(s);
  assert.deepEqual(c.featured, ['aussie']);
  // each product says which set it belongs to, so the carousel knows which page to link
  assert.equal(c.items.find((p) => p.slug === 'aussie').series, 'pup-club');
});

test('no picks, or none saved yet, means no carousel', async () => {
  assert.deepEqual((await catalog(setup())).featured, []);
  assert.deepEqual((await catalog(setup({ featured: '' }))).featured, []);
});

test('the carousel still shows while the shop is closed, with no stock numbers', async () => {
  const c = await catalog(setup({ open: false, featured: 'aussie' }));
  assert.deepEqual(c.featured, ['aussie']);
  assert.ok(c.items.every((p) => p.sizes.every((x) => x.stock === 0)));
});

test('the owner sees every product with its stock, and the picks so far', async () => {
  const s = setup({ featured: 'pomeranian' });
  const body = await (await s.call('GET', '/api/admin/featured', await sign({ email: OWNER }))).json();
  assert.equal(body.max, 8);
  assert.equal(body.stockKnown, true);
  assert.deepEqual(body.featured, ['pomeranian']);
  const by = Object.fromEntries(body.products.map((p) => [p.slug, p]));
  assert.equal(by.aussie.stock, 51);
  assert.equal(by.pomeranian.stock, 0);
  assert.equal(by.corgi.linked, false);
  assert.equal(by['bay-area-pin-board'].kind, 'board');
});

test('only in-stock products can be picked, and at most eight', async () => {
  const s = setup();
  const t = await sign({ email: OWNER });
  const post = (slugs) => s.call('POST', '/api/admin/featured', t, { slugs });
  assert.equal((await post(['pomeranian'])).status, 400);
  assert.equal((await post(['corgi'])).status, 400);
  assert.equal((await post(['not-a-pin'])).status, 400);
  assert.equal((await post(['aussie', 'aussie'])).status, 400);
  assert.equal((await post('aussie')).status, 400);
  assert.equal((await post(Array.from({ length: 9 }, (_, i) => 'pin' + i))).status, 400);
  assert.equal(s.g.docs['settings/featured_sandbox'], undefined);

  const r = await post(['aussie']);
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).featured, ['aussie']);
  assert.equal(s.g.docs['settings/featured_sandbox'].slugs.stringValue, 'aussie');
  assert.equal(s.g.docs['settings/featured_sandbox'].updatedBy.stringValue, OWNER);
  // the shop sees it at once on this server
  assert.deepEqual((await catalog(s)).featured, ['aussie']);
});

test('a pick that sold out may stay picked, and simply hides until it is back', async () => {
  const s = setup({ featured: 'pomeranian' });
  const t = await sign({ email: OWNER });
  const r = await s.call('POST', '/api/admin/featured', t, { slugs: ['pomeranian', 'aussie'] });
  assert.equal(r.status, 200);
  assert.deepEqual((await catalog(s)).featured, ['aussie']);
});

test('nobody but the owner can see or change the picks', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/admin/featured')).status, 401);
  assert.equal((await s.call('GET', '/api/admin/featured', await sign({}))).status, 403);
  assert.equal((await s.call('POST', '/api/admin/featured', await sign({}), { slugs: ['aussie'] })).status, 403);
  assert.equal(s.g.docs['settings/featured_sandbox'], undefined);
});

test('if Square cannot be reached, picks are not saved', async () => {
  const s = setup();
  const t = await sign({ email: OWNER });
  const broken = async (url, opts) => (String(url).includes('squareup') ? new Response('{}', { status: 500 }) : s.fetchFn(url, opts));
  globalThis.fetch = broken;
  const r = await worker.fetch(new Request('https://x.test/api/admin/featured', {
    method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify({ slugs: ['aussie'] })
  }), s.env);
  assert.equal(r.status, 503);
  assert.equal(s.g.docs['settings/featured_sandbox'], undefined);
});
