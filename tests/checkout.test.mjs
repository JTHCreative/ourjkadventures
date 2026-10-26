// Tests for /api/checkout with accounts: signed-in orders are tagged and noted, the shop switch holds.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { fakeGoogle, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));

function setup(shopOpen) {
  _resetCaches();
  const g = fakeGoogle();
  const sent = [];
  const catalog = { ...products, shop_open: shopOpen, items: products.items.map((p) => ({ ...p, sold_out: false })) };
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).endsWith('/v2/online-checkout/payment-links')) {
      sent.push(JSON.parse(opts.body));
      return Response.json({ payment_link: { url: 'https://square.link/u/abc', order_id: 'ORDER_' + sent.length } });
    }
    return g.fetchFn(String(url), opts);
  };
  const env = { ...baseEnv, SQUARE_ENV: 'sandbox', ASSETS: { fetch: async () => Response.json(catalog) } };
  return { g, sent, env };
}
const checkout = (env, token) => worker.fetch(new Request('https://x.test/api/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify({ items: [{ slug: 'aussie', qty: 1 }] })
}), env);

test('a closed shop refuses everyone, signed in or not', async () => {
  const { env, sent } = setup(false);
  assert.equal((await checkout(env, await sign({}))).status, 403);
  assert.equal(sent.length, 0);
});

test('a signed-in checkout tags the order, fills in the email and notes it for order history', async () => {
  const { env, sent, g } = setup(true);
  const r = await checkout(env, await sign({}));
  assert.equal(r.status, 200);
  assert.deepEqual(sent[0].order.metadata, { uid: 'uid123' });
  assert.equal(sent[0].pre_populated_data.buyer_email, 'pup@example.com');
  assert.equal(sent[0].order.line_items[0].base_price_money.amount, 1200);
  assert.ok(g.docs['users/uid123/orders/ORDER_1']);
});

test('signed out, or with a bad ticket, checkout still works but nothing is tagged', async () => {
  const { env, sent, g } = setup(true);
  assert.equal((await checkout(env)).status, 200);
  assert.equal((await checkout(env, 'not-a-ticket')).status, 200);
  assert.equal(sent[0].order.metadata, undefined);
  assert.equal(sent[1].pre_populated_data, undefined);
  assert.deepEqual(Object.keys(g.docs), []);
});
