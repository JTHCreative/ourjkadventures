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
import { pupOffers } from '../server/pup-pages.js';

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
  items: [{ key: 'aussie', qty: 2 }], shipping: 'ground', ship_to: HOME, heard_from: 'google', source_id: 'cnon:card-nonce-ok', attempt: 'attempt-0001', ...extra
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
  const paid = await r.json();
  assert.equal(paid.ok, true);
  assert.equal(paid.url, 'https://x.test/thank-you.html');
  // the thank-you page's pixel event (tests/meta.test.mjs): the order's own total, no tip
  assert.equal(paid.purchase.value, 33.25);
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

test('paying asks "how did you hear about us?": refused without it, tagged on the order and the payment with it', async () => {
  const { env, sq } = setup();
  const r = await pay(env, { heard_from: '' });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'heard_from');
  assert.equal(sq.payments.length, 0);
  // the quote doesn't need it: the summary shows before the form is filled in
  assert.equal((await quote(env)).status, 200);
  assert.equal((await pay(env, { heard_from: 'spca' })).status, 200);
  assert.equal(sq.orders[0].order.metadata.heard_from, 'spca');
  assert.ok(sq.payments[0].body.note.startsWith('found us: peninsula humane society spca'));
});

/* ---------- the collector's path: a pin on us at ten ---------- */
const collector = (w, charges, uid = 'juniper') => { w.g.docs['users/' + uid] = { charges: { integerValue: String(charges) }, freePinAvailable: { booleanValue: charges >= 10 }, earlyAccess: { booleanValue: true }, gift6Awarded: { booleanValue: true } }; };
const juniper = (claims = {}) => sign({ sub: 'juniper', ...claims });

test('a pin on us: only for a signed-in collector with ten pins, and only a pin from the shelf', async () => {
  const w = setup();
  collector(w, 10);
  collector(w, 9, 'maple');
  const ask = async (extra, token) => { const r = await post(w.env, '/api/checkout/quote', { items: [{ key: 'aussie', qty: 1 }], shipping: 'ground', ...extra }, token); return { http: r.status, ...(await r.json()) }; };

  // the page learns there's one to use, without asking for it
  assert.equal((await ask({}, await juniper())).free_pin_ready, true);
  assert.equal((await ask({}, await sign({ sub: 'maple' }))).free_pin_ready, undefined);
  assert.equal((await ask({})).free_pin_ready, undefined);

  const q = await ask({ free_pin: 'aussie:large' }, await juniper());
  assert.equal(q.http, 200);
  assert.deepEqual(q.free_pin, { key: 'aussie:large' });
  // the paid pin, shipping and tax on the paid pin: the pin on us adds nothing and takes nothing off
  assert.deepEqual([q.items_cents, q.shipping.cents, q.tax_cents, q.total_cents], [1200, 700, 113, 2013]);
  assert.deepEqual(q.lines, [{ key: 'aussie', qty: 1, cents: 1200 }]);

  assert.deepEqual([(await ask({ free_pin: 'aussie' })).http, (await ask({ free_pin: 'aussie' })).error], [403, 'free_pin']);
  assert.equal((await ask({ free_pin: 'aussie' }, await sign({ sub: 'maple' }))).http, 403);
  assert.equal((await ask({ free_pin: 'aussie' }, await juniper({ email_verified: false }))).http, 403);
  assert.equal((await ask({ free_pin: 'bay-area-pin-board' }, await juniper())).http, 400);
  assert.equal((await ask({ free_pin: 'nope' }, await juniper())).http, 400);
  assert.equal((await ask({ free_pin: 7 }, await juniper())).http, 400);
  // the pomeranian is marked sold out in square; and three aussies on the shelf can't cover three bought plus one on us
  assert.equal((await ask({ free_pin: 'pomeranian' }, await juniper())).http, 409);
  const tight = await ask({ items: [{ key: 'aussie', qty: 3 }], free_pin: 'aussie' }, await juniper());
  assert.deepEqual([tight.http, tight.error, tight.reason], [409, 'free_pin', 'stock']);
});

test('paying with a pin on us: a line with no price, used once, and the count stays at ten', async () => {
  const w = setup();
  collector(w, 10);
  const token = await juniper();
  const r = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie:large', expected_total_cents: 2013 }, token);
  assert.equal(r.status, 200);
  const order = w.sq.orders[0].order;
  assert.equal(order.total_money.amount, 2013);
  const line = order.line_items.find((l) => l.uid === 'collectors-path-pin');
  assert.deepEqual([line.name, line.quantity, line.base_price_money.amount, line.catalog_object_id], ["collector's path pin: large aussie pin", '1', 0, undefined]);
  assert.match(line.note, /take one large aussie pin off the count/);
  assert.equal(order.metadata.free_pin, 'aussie:large');
  assert.equal(order.discounts, undefined);
  assert.match(w.sq.payments[0].body.note, /collector's path: a large aussie pin on us/);
  // the count stays at ten (the path doesn't start again yet), and there's no pin waiting any more
  assert.equal(w.g.docs['users/juniper'].charges.integerValue, '10');
  assert.equal(w.g.docs['users/juniper'].freePinUsed.booleanValue, true);
  assert.equal(w.g.docs['users/juniper'].freePinAvailable.booleanValue, false);
  assert.ok(w.g.docs['users/juniper/redemptions/' + order.id]);
  assert.equal(w.g.docs['users/juniper/locks/free_pin'], undefined);

  // the same pay press again charges nothing and takes nothing more off
  const again = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie:large' }, token);
  assert.equal((await again.json()).already, true);
  assert.equal(w.sq.orders.length, 1);
  // a new press: no pin on us left
  const next = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie', attempt: 'attempt-0002' }, token);
  assert.equal(next.status, 403);
  assert.equal(w.sq.orders.length, 1);
});

test('a pin on us is kept when the card is declined, and held by one pay press at a time', async () => {
  const w = setup();
  collector(w, 10);
  const token = await juniper();
  const declined = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie', source_id: 'cnon:card-declined' }, token);
  assert.equal(declined.status, 402);
  assert.equal(w.g.docs['users/juniper'].freePinUsed, undefined);
  assert.equal(w.g.docs['users/juniper/locks/free_pin'], undefined);

  // another tab is in the middle of paying with it
  w.g.docs['users/juniper/locks/free_pin'] = { at: { timestampValue: new Date().toISOString() } };
  const busy = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie', attempt: 'attempt-0003' }, token);
  assert.deepEqual([busy.status, (await busy.json()).reason], [409, 'busy']);
  // a hold left behind long ago doesn't lock them out
  w.g.docs['users/juniper/locks/free_pin'] = { at: { timestampValue: new Date(Date.now() - 3600e3).toISOString() } };
  const ok = await pay(w.env, { items: [{ key: 'aussie', qty: 1 }], free_pin: 'aussie', attempt: 'attempt-0004' }, token);
  assert.equal(ok.status, 200);
  assert.equal(w.g.docs['users/juniper'].freePinUsed.booleanValue, true);
});

test("square's hosted page never takes a pin on us", async () => {
  const w = setup(true, {});
  collector(w, 10);
  const r = await post(w.env, '/api/checkout', { items: [{ key: 'aussie', qty: 1 }], shipping: 'ground', ship_to: HOME, heard_from: 'google', free_pin: 'aussie' }, await juniper());
  assert.equal(r.status, 400);
  assert.equal(w.sq.links.length, 0);
  assert.equal(w.g.docs['users/juniper'].freePinUsed, undefined);
});

/* ---------- collectors first: a pin only accounts with a first look can buy ---------- */
test('collectors first: the catalog says so, and only a collector with a first look can check out', async () => {
  const w = setup();
  w.g.docs['settings/early_sandbox'] = { aussie: { booleanValue: true }, 'bay-area-pin-board': { booleanValue: true } };
  w.g.docs['users/juniper'] = { earlyAccess: { booleanValue: true }, charges: { integerValue: '3' } };
  w.g.docs['users/maple'] = { charges: { integerValue: '2' } };
  const c = await (await worker.fetch(new Request('https://x.test/api/catalog'), w.env)).json();
  const aussie = c.items.find((p) => p.slug === 'aussie');
  assert.equal(aussie.early, true);
  // still shown with its price: people can see what's coming
  assert.equal(aussie.sizes[0].price_cents, 1200);
  assert.equal(c.items.find((p) => p.slug === 'pomeranian').early, undefined);
  // no price for search engines while only collectors can buy it
  assert.deepEqual(pupOffers({ open: true, items: [{ slug: 'aussie', available: true, early: true, sizes: [{ key: 'aussie', size: 'standard', price_cents: 1200, stock: 3 }] }] }, 'aussie'), []);

  const go = async (token, items = [{ key: 'aussie', qty: 1 }]) => { const r = await post(w.env, '/api/checkout/quote', { items, shipping: 'ground' }, token); return { http: r.status, ...(await r.json()) }; };
  const no = await go();
  assert.deepEqual([no.http, no.error, no.items], [403, 'early', [{ key: 'aussie' }]]);
  assert.equal((await go(await sign({ sub: 'maple' }))).http, 403);
  assert.equal((await go(await juniper({ email_verified: false }))).http, 403);
  assert.equal((await go(await juniper())).http, 200);
  // paying is checked the same way, and nothing reaches square for someone without a first look
  assert.equal((await pay(w.env, { items: [{ key: 'aussie', qty: 1 }] })).status, 403);
  assert.equal(w.sq.orders.length, 0);
  assert.equal((await pay(w.env, { items: [{ key: 'aussie', qty: 1 }] }, await juniper())).status, 200);
});

test('collectors first: only the owner flips the switch, and only for pins', async () => {
  const w = setup();
  const flip = async (body, email) => (await post({ ...w.env, ADMIN_EMAILS: 'owner@example.com' }, '/api/admin/early', body, await sign({ email }))).status;
  assert.equal(await flip({ slug: 'aussie', early: true }, 'pup@example.com'), 403);
  assert.equal(await flip({ slug: 'bay-area-pin-board', early: true }, 'owner@example.com'), 400);
  assert.equal(await flip({ slug: 'aussie', early: 'yes' }, 'owner@example.com'), 400);
  assert.equal(await flip({ slug: 'aussie', early: true }, 'owner@example.com'), 200);
  assert.equal(w.g.docs['settings/early_sandbox'].aussie.booleanValue, true);
  let c = await (await worker.fetch(new Request('https://x.test/api/catalog'), w.env)).json();
  assert.equal(c.items.find((p) => p.slug === 'aussie').early, true);
  assert.equal(await flip({ slug: 'aussie', early: false }, 'owner@example.com'), 200);
  c = await (await worker.fetch(new Request('https://x.test/api/catalog'), w.env)).json();
  assert.equal(c.items.find((p) => p.slug === 'aussie').early, undefined);
});
