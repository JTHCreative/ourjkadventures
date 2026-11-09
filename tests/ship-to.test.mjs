// Tests for where an order ships (u.s. states and d.c. only) and the gift note, at checkout and on /admin.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { cleanShipTo, cleanGift, STATES, GIFT_MAX } from '../server/ship-to.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const HOME = { name: 'pup person', email: 'Buyer@Example.com', line1: '1 main st', line2: 'apt 2', city: 'oakland', state: 'CA', zip: '94607' };

function setup() {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: true } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L') };
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: 'owner@example.com', ASSETS: { fetch: async () => Response.json(products) } };
  return { ...w, env };
}
const checkout = (env, extra) => worker.fetch(new Request('https://x.test/api/checkout', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items: [{ key: 'aussie', qty: 1 }], ship_to: HOME, ...extra })
}), env);

test('the 50 states and d.c., and nothing else', () => {
  assert.equal(STATES.length, 51);
  for (const code of ['PR', 'GU', 'VI', 'AS', 'MP', 'AA', 'AE', 'AP', 'ON', 'XX', '']) {
    assert.equal(cleanShipTo({ ...HOME, state: code }).field, 'state', code);
  }
  assert.equal(cleanShipTo({ ...HOME, state: 'ca ' }).ok, true);
});

test('the zip code must be a u.s. one, and belong to the state', () => {
  assert.equal(cleanShipTo(HOME).value.zip, '94607');
  assert.equal(cleanShipTo({ ...HOME, zip: '946071234' }).value.zip, '94607-1234');
  assert.equal(cleanShipTo({ ...HOME, zip: '94607-1234' }).value.zip, '94607-1234');
  for (const zip of ['9460', 'SW1A 1AA', 'M5V 2T6', '946077', '', 'abcde']) assert.equal(cleanShipTo({ ...HOME, zip }).field, 'zip', zip);
  // a paris postcode is five digits too, but 75001 is texas, not california
  assert.equal(cleanShipTo({ ...HOME, zip: '75001' }).error, 'zip not in state');
  assert.equal(cleanShipTo({ ...HOME, state: 'TX', zip: '75001' }).ok, true);
  for (const [state, zip] of [['NY', '10001'], ['MA', '02134'], ['DC', '20500'], ['AK', '99501'], ['HI', '96813'], ['WA', '98101'], ['ME', '04101']]) {
    assert.equal(cleanShipTo({ ...HOME, state, zip }).ok, true, state);
  }
  // puerto rico's zip codes are not in any state
  assert.equal(cleanShipTo({ ...HOME, state: 'FL', zip: '00901' }).field, 'zip');
});

test('every box but the apartment is needed, and odd characters are cleaned', () => {
  for (const field of ['name', 'email', 'line1', 'city']) assert.equal(cleanShipTo({ ...HOME, [field]: '  ' }).field, field);
  assert.equal(cleanShipTo({ ...HOME, email: 'not-an-email' }).field, 'email');
  assert.equal(cleanShipTo({ ...HOME, line2: undefined }).ok, true);
  const v = cleanShipTo({ ...HOME, name: ' pup\n<b>person</b> ' }).value;
  assert.equal(v.name, 'pup b person /b');
  assert.equal(v.email, 'buyer@example.com');
  assert.equal(cleanShipTo(null).field, 'name');
});

test('the gift note: only with the tick, at most 200 letters, a blank card is fine', () => {
  assert.equal(cleanGift(null), null);
  assert.equal(cleanGift({ gift: 'yes', message: 'hi' }), null);
  assert.deepEqual(cleanGift({ gift: true }), { message: '' });
  assert.deepEqual(cleanGift({ gift: true, message: '  happy birthday <3\r\nlove, k  ' }), { message: 'happy birthday 3\nlove, k' });
  assert.ok(cleanGift({ gift: true, message: 'a'.repeat(GIFT_MAX + 1) }).error);
});

test('checkout puts the checked address on the order and turns off square\'s own address form', async () => {
  const { env, sq } = setup();
  const r = await checkout(env);
  assert.equal(r.status, 200);
  const link = sq.links[0];
  assert.equal(link.checkout_options.ask_for_shipping_address, false);
  assert.deepEqual(link.order.fulfillments, [{
    type: 'SHIPMENT', state: 'PROPOSED',
    shipment_details: {
      recipient: { display_name: 'pup person', email_address: 'buyer@example.com', address: {
        address_line_1: '1 main st', address_line_2: 'apt 2', locality: 'oakland', administrative_district_level_1: 'CA', postal_code: '94607', country: 'US'
      } },
      carrier: 'USPS', shipping_type: 'ground'
    }
  }]);
  assert.deepEqual(link.pre_populated_data, { buyer_email: 'buyer@example.com' });
  assert.equal(link.order.metadata, undefined);
});

test('checkout refuses an address outside the u.s. states, or none at all, and says which box', async () => {
  const { env, sq } = setup();
  let r = await checkout(env, { ship_to: { ...HOME, state: 'PR', zip: '00901' } });
  assert.equal(r.status, 400);
  assert.deepEqual(await r.json(), { error: 'address', field: 'state', reason: 'we ship to u.s. states only' });
  r = await checkout(env, { ship_to: { ...HOME, zip: '10001' } });
  assert.equal((await r.json()).reason, 'zip not in state');
  assert.equal((await checkout(env, { ship_to: undefined })).status, 400);
  assert.equal((await checkout(env, { ship_to: 'oakland' })).status, 400);
  assert.equal(sq.links.length, 0);
});

test('a gift: the note goes on the order and the payment, and on the owner\'s list', async () => {
  const { env, sq, g } = setup();
  const r = await checkout(env, { gift: { gift: true, message: 'happy birthday, mo!\nlove, k' } });
  assert.equal(r.status, 200);
  const link = sq.links[0];
  assert.equal(link.order.fulfillments[0].shipment_details.shipping_note, 'gift. write on the card: "happy birthday, mo!\nlove, k"');
  assert.deepEqual(link.order.metadata, { gift: 'yes' });
  assert.ok(link.payment_note.startsWith('gift. write on the card'));
  assert.ok(link.payment_note.includes('ship to: pup person, 1 main st, apt 2, oakland, CA 94607'));
  const doc = g.docs['gifts/ORDER_1'];
  assert.equal(doc.message.stringValue, 'happy birthday, mo!\nlove, k');
  assert.equal(doc.email.stringValue, 'buyer@example.com');
  assert.equal(doc.zip.stringValue, '94607');
  // too long a note is refused, not cut short
  assert.equal((await checkout(env, { gift: { gift: true, message: 'a'.repeat(201) } })).status, 400);
});

test('a gift that also ships free keeps both notes for the owner', async () => {
  const { env, sq } = setup();
  const r = await worker.fetch(new Request('https://x.test/api/checkout', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ key: 'aussie:large', qty: 3 }], ship_to: HOME, gift: { gift: true } })
  }), env);
  assert.equal(r.status, 200);
  assert.ok(sq.links[0].payment_note.startsWith('free ground shipping (2 to 5 days) / gift. blank card, no note'));
});

test('/admin lists paid gift orders with the note, email and address; "card written" takes one off', async () => {
  const { env, g, fetchFn } = setup();
  await checkout(env, { gift: { gift: true, message: 'paid one' } });
  await checkout(env, { gift: { gift: true, message: 'left half way' } });
  g.squareOrders.ORDER_1 = { id: 'ORDER_1', state: 'OPEN', tenders: [{}], line_items: [{ name: 'Aussie Standard Pin', quantity: '1' }], created_at: '2026-11-09T10:00:00Z' };
  g.squareOrders.ORDER_2 = { id: 'ORDER_2', state: 'OPEN', line_items: [] };
  const owner = await sign({ email: 'owner@example.com' });
  const call = (method, body) => admin(new Request('https://x.test/api/admin/gifts', {
    method, headers: { Authorization: 'Bearer ' + owner, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), env, fetchFn);
  let res = await (await call('GET')).json();
  assert.equal(res.gifts.length, 1);
  const gift = res.gifts[0];
  assert.equal(gift.id, 'ORDER_1');
  assert.equal(gift.message, 'paid one');
  assert.equal(gift.email, 'buyer@example.com');
  assert.deepEqual(gift.address, { line1: '1 main st', line2: 'apt 2', city: 'oakland', state: 'CA', zip: '94607' });
  assert.deepEqual(gift.items, [{ name: 'Aussie Standard Pin', qty: 1 }]);
  // the unpaid one stays noted (it may still be paid) but isn't shown
  assert.ok(g.docs['gifts/ORDER_2']);
  res = await (await call('POST', { id: 'ORDER_1' })).json();
  assert.equal(res.gifts.length, 0);
  assert.equal(g.docs['gifts/ORDER_1'], undefined);
  assert.equal((await call('POST', { id: '../settings/shop' })).status, 400);
  // a customer can't see the list
  const stranger = await sign({});
  const r = await admin(new Request('https://x.test/api/admin/gifts', { headers: { Authorization: 'Bearer ' + stranger } }), env, fetchFn);
  assert.equal(r.status, 403);
});

test('the catalog tells the bag which states we ship to', async () => {
  const { env } = setup();
  const c = await (await worker.fetch(new Request('https://x.test/api/catalog'), env)).json();
  assert.equal(c.states.length, 51);
  assert.deepEqual(c.states.find((s) => s.code === 'CA'), { code: 'CA', name: 'california' });
  assert.equal(c.gift_max, 200);
});
