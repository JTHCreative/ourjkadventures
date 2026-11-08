// Tests for pre-order: the owner's second switch on /admin. A pin on pre-order is being made: never for sale,
// no "i'm interested" votes, but "email me when it's here" still takes sign-ups.
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

test('a pin on pre-order is off sale, even when it is linked, in stock and switched available', async () => {
  const s = setup({ preorder: ['aussie'] });
  const aussie = await item(s, 'aussie');
  assert.equal(aussie.preorder, true);
  assert.equal(aussie.available, false);
  assert.deepEqual(aussie.sizes, []);
  assert.equal((await item(s, 'corgi')).preorder, false);
  const res = await s.call('POST', '/api/checkout', { body: { items: [{ key: 'aussie', qty: 1 }] } });
  assert.equal(res.status, 400);
  assert.equal(s.sq.links.length, 0);
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
  assert.deepEqual((await item(s, 'aussie')).sizes, []);
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
