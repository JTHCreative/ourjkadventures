// Tests for /api/catalog and /api/checkout: Square prices and stock, the open sign, and signed-in orders.
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

// shopOpen: true, false, or undefined for "no switch saved yet"
function setup(shopOpen, links = { aussie: 'V_AUS', 'aussie:large': 'V_AUS_L', pomeranian: 'V_POM' }) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  if (shopOpen !== undefined) w.g.docs['settings/shop'] = { open: { booleanValue: shopOpen } };
  w.g.docs['settings/square_sandbox'] = Object.fromEntries(Object.entries(links).map(([k, v]) => [k, str(v)]));
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ASSETS: { fetch: async () => Response.json(products) } };
  return { ...w, env };
}
const checkout = (env, items, token) => worker.fetch(new Request('https://x.test/api/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ items: items || [{ key: 'aussie', qty: 1 }] })
}), env);
const catalog = async (env) => (await worker.fetch(new Request('https://x.test/api/catalog'), env)).json();

test('the catalog takes prices and stock from Square for linked products only', async () => {
  const { env } = setup(true);
  const c = await catalog(env);
  assert.equal(c.open, true);
  const aussie = c.items.find((p) => p.slug === 'aussie');
  assert.deepEqual(aussie.sizes, [
    { size: 'standard', key: 'aussie', price_cents: 1200, stock: 3 },
    { size: 'large', key: 'aussie:large', price_cents: 1500, stock: 48 }
  ]);
  // ticked "sold out" in Square wins over the count
  assert.deepEqual(c.items.find((p) => p.slug === 'pomeranian').sizes, [{ size: 'standard', key: 'pomeranian', price_cents: 1200, stock: 0 }]);
  // not linked yet: on the site, but nothing to buy
  assert.deepEqual(c.items.find((p) => p.slug === 'corgi').sizes, []);
  assert.equal(JSON.stringify(c).includes('V_AUS'), false);
});

test('while the shop is closed the catalog shows no stock', async () => {
  const { env } = setup(false);
  const c = await catalog(env);
  assert.equal(c.open, false);
  assert.ok(c.items.every((p) => p.sizes.every((s) => s.stock === 0)));
});

test('the catalog is remembered for a minute', async () => {
  const { env, sq } = setup(true);
  await catalog(env);
  const n = sq.calls.length;
  await catalog(env);
  await catalog(env);
  assert.equal(sq.calls.length, n);
});

test('a closed shop refuses everyone, signed in or not', async () => {
  const { env, sq } = setup(false);
  assert.equal((await checkout(env, null, await sign({}))).status, 403);
  assert.equal(sq.links.length, 0);
});

test('no open sign at all, or a Firestore that cannot be reached, means closed', async () => {
  const { env, sq, g } = setup(undefined);
  assert.equal((await checkout(env)).status, 403);
  _resetShopCache();
  _resetCatalogCache();
  g.docs['settings/shop'] = { open: { booleanValue: true } };
  const down = { ...env, FIREBASE_SERVICE_ACCOUNT: '{"client_email":"x","private_key":"broken"}' };
  assert.equal((await checkout(down)).status, 403);
  assert.equal(sq.links.length, 0);
});

test('checkout points at the Square items, so Square lowers the stock, and never sends a price', async () => {
  const { env, sq } = setup(true);
  const r = await checkout(env, [{ key: 'aussie', qty: 2 }, { key: 'aussie:large', qty: 1 }, { key: 'aussie', qty: 1 }]);
  assert.equal(r.status, 200);
  assert.deepEqual(sq.links[0].order.line_items, [
    { catalog_object_id: 'V_AUS', quantity: '3' },
    { catalog_object_id: 'V_AUS_L', quantity: '1' }
  ]);
  assert.equal(JSON.stringify(sq.links[0].order).includes('price'), false);
  assert.equal(sq.links[0].checkout_options.shipping_fee.charge.amount, products.shipping_cents);
});

test('checkout refuses more than is on the shelf, checked fresh', async () => {
  const { env, sq } = setup(true);
  await catalog(env); // the one-minute list says 3 aussies
  sq.stock.V_AUS = 1; // the booth just sold two
  const r = await checkout(env, [{ key: 'aussie', qty: 2 }]);
  assert.equal(r.status, 409);
  assert.deepEqual((await r.json()).items, [{ key: 'aussie', stock: 1 }]);
  assert.equal((await checkout(env, [{ key: 'pomeranian', qty: 1 }])).status, 409);
  assert.equal(sq.links.length, 0);
});

test('checkout refuses keys it does not sell and silly quantities', async () => {
  const { env } = setup(true);
  for (const items of [[{ key: 'corgi', qty: 1 }], [{ key: 'aussie:huge', qty: 1 }], [{ slug: 'aussie', qty: 1 }],
    [{ key: 'aussie', qty: 0 }], [{ key: 'aussie', qty: 21 }], [{ key: 'aussie', qty: 15 }, { key: 'aussie', qty: 15 }]]) {
    assert.equal((await checkout(env, items)).status, 400, JSON.stringify(items));
  }
});

test('a signed-in checkout tags the order, fills in the email and notes it for order history', async () => {
  const { env, sq, g } = setup(true);
  const r = await checkout(env, null, await sign({}));
  assert.equal(r.status, 200);
  assert.deepEqual(sq.links[0].order.metadata, { uid: 'uid123' });
  assert.equal(sq.links[0].pre_populated_data.buyer_email, 'pup@example.com');
  assert.ok(g.docs['users/uid123/orders/ORDER_1']);
});

test('signed out, or with a bad ticket, checkout still works but nothing is tagged', async () => {
  const { env, sq, g } = setup(true);
  assert.equal((await checkout(env)).status, 200);
  assert.equal((await checkout(env, null, 'not-a-ticket')).status, 200);
  assert.equal(sq.links[0].order.metadata, undefined);
  assert.equal(sq.links[1].pre_populated_data, undefined);
  assert.deepEqual(Object.keys(g.docs).filter((k) => !k.startsWith('settings/')), []);
});
