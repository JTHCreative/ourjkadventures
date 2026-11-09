// Tests for pre-order: the owner's second switch on /admin. A pin on pre-order is being made: it can be bought
// (paid now, shipped in about preorder_weeks, the whole order together), with no "i'm interested" votes, and
// "email me when it's here" still takes sign-ups.
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

// aussie is linked, in stock and available; corgi is linked too
function setup({ preorder = [], unavailable = [] } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: true } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), corgi: str('V_POM') };
  w.g.docs['settings/available_sandbox'] = Object.fromEntries(unavailable.map((s) => [s, { booleanValue: false }]));
  w.g.docs['settings/preorder_sandbox'] = Object.fromEntries(preorder.map((s) => [s, { booleanValue: true }]));
  // "does this domain take mail?" always says yes here
  const fetchFn = async (url, opts) => {
    if (String(url).startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [{ type: 15, data: '10 mx.example.com.' }] });
    return w.fetchFn(url, opts);
  };
  globalThis.fetch = fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, RESEND_API_KEY: 're_test', ASSETS: { fetch: async () => Response.json(products) } };
  const call = async (method, path, { token, body, ip = '1.2.3.4' } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { ...w, env, call };
}
const item = async (s, slug) => (await (await s.call('GET', '/api/catalog')).json()).items.find((p) => p.slug === slug);

const HOME = { name: 'pup person', email: 'buyer@example.com', line1: '1 main st', city: 'oakland', state: 'CA', zip: '94607' };
const buy = (s, items, extra = {}) => s.call('POST', '/api/checkout', { body: { items, ship_to: HOME, ...extra } });

test('a pin on pre-order is for sale at its Square price, without looking at the shelf', async () => {
  const s = setup({ preorder: ['aussie'], unavailable: ['aussie'] });
  const c = await (await s.call('GET', '/api/catalog')).json();
  assert.equal(c.preorder_weeks, 4);
  const aussie = c.items.find((p) => p.slug === 'aussie');
  assert.equal(aussie.preorder, true);
  assert.equal(aussie.available, false);
  // Square has 3 standard aussies; a pre-order isn't limited by that, only by 20 an order
  assert.deepEqual(aussie.sizes, [
    { size: 'standard', key: 'aussie', price_cents: 1200, stock: 20, preorder: true },
    { size: 'large', key: 'aussie:large', price_cents: 1500, stock: 20, preorder: true }
  ]);
  const res = await buy(s, [{ key: 'aussie', qty: 10 }]);
  assert.equal(res.status, 200);
  assert.equal((await buy(s, [{ key: 'aussie', qty: 21 }])).status, 400);
  // no stock count asked of Square for a pre-order-only bag
  assert.equal(s.sq.calls.filter((c) => c.includes('/inventory/counts')).length, 1); // the catalog's own look
});

test('a pre-order checkout says when it ships: on the line, the shipment, the payment and the thank-you page', async () => {
  const s = setup({ preorder: ['aussie'] });
  const before = Date.now();
  assert.equal((await buy(s, [{ key: 'aussie', qty: 1 }])).status, 200);
  const link = s.sq.links[0];
  assert.deepEqual(link.order.line_items, [{ catalog_object_id: 'V_AUS', quantity: '1', note: 'pre-order. ships in about 4 weeks' }]);
  assert.deepEqual(link.order.metadata, { preorder: 'yes' });
  const ship = link.order.fulfillments[0].shipment_details;
  assert.equal(ship.shipping_note, 'pre-order: the whole order ships together in about 4 weeks');
  const when = Date.parse(ship.expected_shipped_at) - before;
  assert.ok(when >= 28 * 86400000 && when < 28 * 86400000 + 60000);
  assert.equal(link.payment_note, 'pre-order: ship the whole order together in about 4 weeks');
  assert.equal(link.checkout_options.redirect_url, 'https://x.test/thank-you.html?preorder=4');
});

test('a bag with a pre-order and an in-stock pin: the shelf is checked for the in-stock one, all ships together', async () => {
  const s = setup({ preorder: ['aussie'] });
  s.g.docs['settings/square_sandbox'].pomeranian = str('V_AUS_L');
  _resetCatalogCache();
  assert.equal((await buy(s, [{ key: 'aussie', qty: 2 }, { key: 'pomeranian', qty: 49 }])).status, 400); // over 20
  s.sq.stock.V_AUS_L = 1;
  const short = await buy(s, [{ key: 'aussie', qty: 2 }, { key: 'pomeranian', qty: 2 }]);
  assert.equal(short.status, 409);
  assert.deepEqual((await short.json()).items, [{ key: 'pomeranian', stock: 1 }]);
  assert.equal((await buy(s, [{ key: 'aussie', qty: 2 }, { key: 'pomeranian', qty: 1 }, { key: 'aussie:large', qty: 1 }])).status, 200);
  const link = s.sq.links[0];
  assert.deepEqual(link.order.line_items.map((l) => l.note || ''), ['pre-order. ships in about 4 weeks', '', 'pre-order. ships in about 4 weeks']);
  assert.ok(link.payment_note.startsWith('pre-order: ship the whole order together'));
});

test('a pin on pre-order that is ticked sold out in Square, or a closed shop, sells nothing', async () => {
  const s = setup({ preorder: ['corgi'] }); // corgi is linked to the item ticked sold out
  assert.deepEqual((await item(s, 'corgi')).sizes, []);
  assert.equal((await buy(s, [{ key: 'corgi', qty: 1 }])).status, 400);
  s.g.docs['settings/shop'] = { open: { booleanValue: false } };
  _resetShopCache();
  _resetCatalogCache();
  assert.ok((await item(s, 'aussie')).sizes.every((z) => z.stock === 0));
  assert.equal(s.sq.links.length, 0);
});

test('the ship time comes from products.json', async () => {
  const s = setup({ preorder: ['aussie'] });
  s.env.ASSETS = { fetch: async () => Response.json({ ...products, preorder_weeks: 6 }) };
  _resetCatalogCache();
  assert.equal((await buy(s, [{ key: 'aussie', qty: 1 }])).status, 200);
  assert.equal(s.sq.links[0].order.line_items[0].note, 'pre-order. ships in about 6 weeks');
});

test('a pin on pre-order takes no votes, and its tally stays out of the shop', async () => {
  const s = setup({ preorder: ['corgi'], unavailable: ['corgi'] });
  s.g.docs['interest_sandbox/corgi'] = { slug: str('corgi'), count: { integerValue: '4' } };
  const res = await s.call('POST', '/api/interest', { body: { slug: 'corgi' } });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'preorder');
  assert.equal((await item(s, 'corgi')).interest, 0);
  // the owner still sees it
  const body = await (await s.call('GET', '/api/admin/products', { token: await sign({ email: OWNER }) })).json();
  assert.equal(body.interest.corgi, 4);
  assert.equal(body.preorder.corgi, true);
});

test('a pin on pre-order takes "email me when it\'s here" sign-ups, but "it\'s here" waits until it is', async () => {
  const s = setup({ preorder: ['aussie'] });
  const added = await (await s.call('POST', '/api/notify', { body: { slug: 'aussie', email: 'pup@example.com' } })).json();
  assert.deepEqual(added, { status: 'added' });
  const owner = await sign({ email: OWNER });
  const summary = await (await s.call('GET', '/api/admin/notify', { token: owner })).json();
  const row = summary.products.find((p) => p.slug === 'aussie');
  assert.equal(row.preorder, true);
  assert.equal(row.available, false);
  const send = await s.call('POST', '/api/admin/notify', { token: owner, body: { slug: 'aussie' } });
  assert.equal((await send.json()).error, 'not available');
});

test('the owner flips pre-order on and off; nobody else can', async () => {
  const s = setup();
  const owner = await sign({ email: OWNER });
  const flip = (token, slug, preorder) => s.call('POST', '/api/admin/preorder', { token, body: { slug, preorder } });
  assert.equal((await flip(await sign({ email: 'pup@example.com' }), 'aussie', true)).status, 403);
  assert.equal((await flip(owner, 'not-a-pin', true)).status, 400);
  assert.equal((await flip(owner, 'aussie', 'yes')).status, 400);

  assert.equal((await flip(owner, 'aussie', true)).status, 200);
  assert.equal((await item(s, 'aussie')).preorder, true);
  assert.ok((await item(s, 'aussie')).sizes.every((z) => z.preorder === true));
  let links = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(links.preorder.aussie, true);
  // the available switch is left as it was
  assert.equal(links.available.aussie, true);

  // off again: back in the shop, because available was never turned off
  assert.equal((await flip(owner, 'aussie', false)).status, 200);
  assert.equal((await item(s, 'aussie')).preorder, false);
  assert.equal((await item(s, 'aussie')).sizes.length, 2);
  links = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(links.preorder.aussie, false);
});

test('a pin on pre-order never turns in the featured carousel', async () => {
  const s = setup({ preorder: ['aussie'] });
  s.g.docs['settings/featured_sandbox'] = { slugs: str('aussie') };
  assert.deepEqual((await (await s.call('GET', '/api/catalog')).json()).featured, []);
});

test('google is told a pre-order pin can be pre-ordered', async () => {
  const { pupOffers } = await import('../server/pup-pages.js');
  const catalog = {
    open: true, currency: 'USD',
    items: [{ slug: 'aussie', available: false, preorder: true, sizes: [{ size: 'standard', key: 'aussie', price_cents: 1200, stock: 20, preorder: true }] }],
    byKey: { aussie: { currency: 'USD' } }
  };
  assert.equal(pupOffers(catalog, 'aussie')[0].availability, 'https://schema.org/PreOrder');
  assert.deepEqual(pupOffers({ ...catalog, open: false }, 'aussie'), []);
});
