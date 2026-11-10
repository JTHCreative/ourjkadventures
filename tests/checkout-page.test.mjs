// Tests for the checkout page's server side: /api/checkout/quote (the order summary, with Square's tax and the
// tip) and /api/checkout/pay (Square's card form in our page: we make the order and charge the one-time token).
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

function setup(shopOpen = true, extraEnv = { SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test' }) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: shopOpen } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), pomeranian: str('V_POM') };
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ...extraEnv, ASSETS: { fetch: async () => Response.json(products) } };
  return { ...w, env };
}
const HOME = { name: 'pup person', email: 'buyer@example.com', line1: '1 main st', line2: '', city: 'oakland', state: 'CA', zip: '94607' };
const post = (env, path, body, token) => worker.fetch(new Request('https://x.test' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
  body: JSON.stringify(body)
}), env);
const quote = (env, extra = {}) => post(env, '/api/checkout/quote', { items: [{ key: 'aussie', qty: 2 }], shipping: 'ground', ...extra });
const pay = (env, extra = {}, token) => post(env, '/api/checkout/pay', {
  items: [{ key: 'aussie', qty: 2 }], shipping: 'ground', ship_to: HOME, source_id: 'cnon:card-nonce-ok', attempt: 'attempt-0001', ...extra
}, token);

test('the catalog tells the page about Square\'s card form only once it is set up, and never the token', async () => {
  let { env } = setup(true, {});
  let c = await (await worker.fetch(new Request('https://x.test/api/catalog'), env)).json();
  assert.equal(c.card, null);
  ({ env } = setup(true));
  c = await (await worker.fetch(new Request('https://x.test/api/catalog'), env)).json();
  assert.deepEqual(c.card, { app_id: 'sandbox-sq0idb-test', location_id: 'loc', sdk: 'https://sandbox.web.squarecdn.com/v1/square.js' });
  assert.equal(JSON.stringify(c).includes(env.SQUARE_ACCESS_TOKEN + '"'), false);
});

test('the quote is Square\'s own sums: items, shipping, the booth\'s tax, and no address needed', async () => {
  const { env, sq } = setup();
  const r = await quote(env);
  assert.equal(r.status, 200);
  const q = await r.json();
  assert.deepEqual(q.lines, [{ key: 'aussie', qty: 2, cents: 2400 }]);
  assert.equal(q.items_cents, 2400);
  assert.deepEqual(q.shipping, { id: 'ground', cents: 700, free: false });
  assert.equal(q.tax_cents, 225);
  assert.equal(q.tip_cents, 0);
  assert.equal(q.total_cents, 3325);
  // only worked out, never made: no order in Square
  assert.equal(sq.orders.length, 0);
});

test('a tip is the buyer\'s choice: a percentage of the items worked out here, or their own amount', async () => {
  const { env } = setup();
  let q = await (await quote(env, { tip: { percent: 10 } })).json();
  assert.equal(q.tip_cents, 240);
  assert.equal(q.total_cents, 3325 + 240);
  q = await (await quote(env, { tip: { cents: 300 } })).json();
  assert.equal(q.tip_cents, 300);
  q = await (await quote(env, { tip: null })).json();
  assert.equal(q.tip_cents, 0);
  // anything else is refused, never taken off the total
  for (const tip of [{ percent: 50 }, { percent: '10' }, { cents: -100 }, { cents: 10001 }, { cents: 2.5 }, 'lots']) {
    assert.equal((await quote(env, { tip })).status, 400, JSON.stringify(tip));
  }
});

test('the quote refuses a closed shop and more than is on the shelf', async () => {
  let { env } = setup(false);
  assert.equal((await quote(env)).status, 403);
  ({ env } = setup());
  const r = await quote(env, { items: [{ key: 'aussie', qty: 4 }] });
  assert.equal(r.status, 409);
  assert.deepEqual((await r.json()).items, [{ key: 'aussie', stock: 3 }]);
});

test('paying makes the order with its shipment and charges its own total, tip on top', async () => {
  const { env, sq } = setup();
  const r = await pay(env, { tip: { percent: 15 }, price_cents: 1, total: 1 });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, url: 'https://x.test/thank-you.html' });
  assert.equal(sq.orders.length, 1);
  const order = sq.orders[0].order;
  assert.equal(order.line_items[0].catalog_object_id, 'V_AUS');
  assert.equal(order.line_items[0].base_price_money.amount, 1200);
  assert.equal(order.fulfillments[0].shipment_details.recipient.address.postal_code, '94607');
  assert.equal(sq.payments.length, 1);
  const p = sq.payments[0].body;
  assert.equal(p.order_id, order.id);
  assert.equal(p.source_id, 'cnon:card-nonce-ok');
  assert.deepEqual(p.amount_money, { amount: 3325, currency: 'USD' });
  assert.deepEqual(p.tip_money, { amount: 360, currency: 'USD' });
  assert.equal(p.autocomplete, true);
  assert.equal(p.buyer_email_address, 'buyer@example.com');
  assert.ok(p.idempotency_key.length <= 45);
});

test('pressing pay twice with the same attempt makes one order and one charge', async () => {
  const { env, sq } = setup();
  assert.equal((await pay(env)).status, 200);
  assert.equal((await pay(env)).status, 200);
  assert.equal(sq.orders.length, 1);
  assert.equal(sq.payments.length, 1);
});

test('a declined card says why, in a word the page can explain, and nothing is charged', async () => {
  const { env, sq } = setup();
  let r = await pay(env, { source_id: 'cnon:card-declined' });
  assert.equal(r.status, 402);
  assert.deepEqual(await r.json(), { error: 'declined', reason: 'declined' });
  r = await pay(env, { source_id: 'cnon:card-cvv', attempt: 'attempt-0002' });
  assert.equal(r.status, 402);
  assert.equal((await r.json()).reason, 'cvv');
  assert.equal(sq.payments.length, 0);
});

test('paying checks the address, the attempt and the token, and waits for the card form to be set up', async () => {
  let { env } = setup();
  let r = await pay(env, { ship_to: { ...HOME, zip: '10001' } });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).field, 'zip');
  assert.equal((await pay(env, { source_id: '' })).status, 400);
  assert.equal((await pay(env, { attempt: 'x' })).status, 400);
  ({ env } = setup(true, {}));
  assert.equal((await pay(env)).status, 503);
});

test('a signed-in buyer\'s order is tagged and goes on their order history; a gift goes on the cards to write', async () => {
  const { env, sq, g } = setup();
  const r = await pay(env, { gift: { gift: true, message: 'happy birthday!' }, tip: { cents: 200 } }, await sign({}));
  assert.equal(r.status, 200);
  const meta = sq.orders[0].order.metadata;
  assert.equal(meta.uid, 'uid123');
  assert.equal(meta.gift_note, 'happy birthday!');
  assert.equal(meta.tip, '200');
  assert.ok(g.docs['users/uid123/orders/ORDER_1']);
  assert.ok(g.docs['gifts/ORDER_1']);
  assert.match(sq.payments[0].body.note, /write on the card: "happy birthday!"/);
});

test('free ground over $40 sends no shipping line on the paid order either', async () => {
  const { env, sq } = setup();
  const r = await pay(env, { items: [{ key: 'aussie:large', qty: 3 }] });
  assert.equal(r.status, 200);
  assert.equal(sq.orders[0].order.service_charges, undefined);
  assert.match(sq.payments[0].body.note, /free ground shipping/);
});

test('a large pin can be quoted and paid for (its line uid has no ":", which Square refuses)', async () => {
  const { env, sq } = setup();
  const q = await (await quote(env, { items: [{ key: 'aussie', qty: 1 }, { key: 'aussie:large', qty: 1 }] })).json();
  assert.deepEqual(q.lines, [{ key: 'aussie', qty: 1, cents: 1200 }, { key: 'aussie:large', qty: 1, cents: 1500 }]);
  const r = await pay(env, { items: [{ key: 'aussie:large', qty: 2 }] });
  assert.equal(r.status, 200);
  assert.equal(sq.orders[0].order.line_items[0].uid, 'aussie.large');
  assert.equal(sq.payments.length, 1);
});

test('if the total the buyer saw is no longer Square\'s total, nothing is charged and the new total comes back', async () => {
  const { env, sq } = setup();
  // two aussies on ground: $24 + $7 + $2.25 tax = $33.25
  let r = await pay(env, { expected_total_cents: 3000 });
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: 'total', total_cents: 3325 });
  assert.equal(sq.payments.length, 0);
  // the tip counts toward the total they saw
  r = await pay(env, { expected_total_cents: 3325 + 240, tip: { percent: 10 } });
  assert.equal(r.status, 200);
  assert.equal(sq.payments.length, 1);
});

test('the quote\'s total is exactly what paying charges, so a real checkout never trips the total check', async () => {
  const { env, sq } = setup();
  const items = [{ key: 'aussie', qty: 1 }, { key: 'aussie:large', qty: 2 }];
  const q = await (await quote(env, { items, shipping: 'priority', tip: { percent: 15 } })).json();
  const r = await pay(env, { items, shipping: 'priority', tip: { percent: 15 }, expected_total_cents: q.total_cents });
  assert.equal(r.status, 200);
  const p = sq.payments[0].body;
  assert.equal(p.amount_money.amount + p.tip_money.amount, q.total_cents);
});

test('a pay press that went through can be looked up afterwards, by its id only', async () => {
  const { env, g } = setup();
  const status = async (id) => (await worker.fetch(new Request('https://x.test/api/checkout/status?attempt=' + id), env)).json();
  assert.deepEqual(await status('attempt-0001'), { paid: false });
  assert.equal((await pay(env)).status, 200);
  assert.deepEqual(await status('attempt-0001'), { paid: true, url: 'https://x.test/thank-you.html' });
  // only the order and the thank-you page are kept: nothing about the buyer
  assert.deepEqual(Object.keys(g.docs['checkout_attempts_sandbox/attempt-0001']).sort(), ['createdAt', 'order', 'url']);
  assert.deepEqual(await status('attempt-9999'), { paid: false });
  const bad = await worker.fetch(new Request('https://x.test/api/checkout/status?attempt=../users'), env);
  assert.equal(bad.status, 400);
});

test('a pay press for an order that is already paid can\'t charge again', async () => {
  const { env, sq } = setup();
  assert.equal((await pay(env)).status, 200);
  // the tab was closed and opened again: same pay press, a fresh token from the card form
  const r = await pay(env, { source_id: 'cnon:card-nonce-second' });
  // it went through the first time: the thank-you page, and no second charge
  assert.deepEqual(await r.json(), { ok: true, url: 'https://x.test/thank-you.html', already: true });
  assert.equal(sq.payments.length, 1);
  assert.equal(sq.orders.length, 1);
});
