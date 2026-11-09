// Tests for "i'm interested": the owner's available switch on /admin, the votes, and what /api/catalog shows.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { IP_DAILY_CAP } from '../server/interest.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const OWNER = 'owner@example.com';

// aussie is linked and in stock; corgi is marked not available
function setup({ open = true, unavailable = ['corgi'] } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: open } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), corgi: str('V_POM') };
  w.g.docs['settings/available_sandbox'] = Object.fromEntries(unavailable.map((s) => [s, { booleanValue: false }]));
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) } };
  const call = async (method, path, { token, body, cookie, ip = '1.2.3.4', origin } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (cookie) headers.Cookie = cookie;
    if (origin) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { ...w, env, call };
}
const catalog = async (s) => (await s.call('GET', '/api/catalog')).json();
const ticketOf = (res) => /jka_voter=([^;]+)/.exec(res.headers.get('Set-Cookie') || '')[1];
const vote = (s, slug, opts = {}) => s.call('POST', '/api/interest', { body: { slug }, ...opts });

test('a product that is not available is off sale and shows its tally, open or closed', async () => {
  for (const open of [true, false]) {
    const c = await catalog(setup({ open }));
    const corgi = c.items.find((p) => p.slug === 'corgi');
    assert.equal(corgi.available, false);
    assert.deepEqual(corgi.sizes, []);
    assert.equal(corgi.interest, 0);
    assert.equal(c.items.find((p) => p.slug === 'aussie').available, true);
  }
});

test('checkout refuses a product that is not available, even though it is linked and in stock', async () => {
  const s = setup();
  const res = await s.call('POST', '/api/checkout', { body: { items: [{ key: 'corgi', qty: 1 }] } });
  assert.equal(res.status, 400);
  assert.equal(s.sq.links.length, 0);
});

test('one vote per ticket: a second tap from the same browser is not counted', async () => {
  const s = setup();
  const first = await vote(s, 'corgi');
  assert.deepEqual(await first.json(), { counted: true, count: 1 });
  const cookie = 'jka_voter=' + ticketOf(first);
  assert.match(first.headers.get('Set-Cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const again = await (await vote(s, 'corgi', { cookie })).json();
  assert.deepEqual(again, { counted: false, reason: 'already', count: 1 });
  // the tally shows in the catalog at once, not a minute later
  assert.equal((await catalog(s)).items.find((p) => p.slug === 'corgi').interest, 1);
});

test('nothing stored holds the ticket or the IP address as it is', async () => {
  const s = setup();
  const res = await vote(s, 'corgi', { ip: '203.0.113.9' });
  const ticket = ticketOf(res);
  const saved = JSON.stringify(Object.keys(s.g.docs)) + JSON.stringify(s.g.docs);
  assert.ok(!saved.includes(ticket));
  assert.ok(!saved.includes('203.0.113.9'));
});

test('one connection counts at most IP_DAILY_CAP votes per pin per day, then says so', async () => {
  const s = setup();
  for (let i = 0; i < IP_DAILY_CAP; i++) assert.equal((await (await vote(s, 'corgi')).json()).counted, true);
  assert.deepEqual(await (await vote(s, 'corgi')).json(), { counted: false, reason: 'limit', count: IP_DAILY_CAP });
  // a different connection is still welcome
  assert.equal((await (await vote(s, 'corgi', { ip: '5.6.7.8' })).json()).counted, true);
});

test('no votes for a product that is in the shop, an unknown one, or from another website', async () => {
  const s = setup();
  assert.equal((await vote(s, 'aussie')).status, 409);
  assert.equal((await vote(s, 'not-a-pin')).status, 400);
  assert.equal((await vote(s, '../settings/shop')).status, 400);
  assert.equal((await vote(s, 'corgi', { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await vote(s, 'corgi', { origin: 'https://x.test' })).status, 200);
  assert.equal((await s.call('GET', '/api/interest')).status, 405);
});

test('the owner flips a product to not available and back; nobody else can', async () => {
  const s = setup({ unavailable: [] });
  const owner = await sign({ email: OWNER });
  const flip = (token, slug, available) => s.call('POST', '/api/admin/availability', { token, body: { slug, available } });
  assert.equal((await flip(await sign({ email: 'pup@example.com' }), 'aussie', false)).status, 403);
  assert.equal((await flip(owner, 'not-a-pin', false)).status, 400);
  assert.equal((await flip(owner, 'aussie', 'no')).status, 400);

  assert.equal((await flip(owner, 'aussie', false)).status, 200);
  let c = await catalog(s);
  assert.equal(c.items.find((p) => p.slug === 'aussie').available, false);
  assert.deepEqual(c.items.find((p) => p.slug === 'aussie').sizes, []);

  const links = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(links.available.aussie, false);
  assert.equal(links.available.beagle, true);

  assert.equal((await flip(owner, 'aussie', true)).status, 200);
  c = await catalog(s);
  assert.equal(c.items.find((p) => p.slug === 'aussie').sizes.length, 2);
});

test('the owner sees every tally, including for products that have since arrived', async () => {
  const s = setup();
  await vote(s, 'corgi');
  await vote(s, 'corgi', { ip: '9.9.9.9' });
  const owner = await sign({ email: OWNER });
  await s.call('POST', '/api/admin/availability', { token: owner, body: { slug: 'corgi', available: true } });
  const body = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(body.interest.corgi, 2);
  // in the shop now, so the public count steps away
  assert.equal((await catalog(s)).items.find((p) => p.slug === 'corgi').interest, 0);
});

test('the owner can clear a product\'s count: back to 0, votes forgotten, not kept as "asked"; nobody else can', async () => {
  const s = setup();
  const first = await vote(s, 'corgi');
  await vote(s, 'corgi', { ip: '9.9.9.9' });
  const owner = await sign({ email: OWNER });
  const clear = (token, slug) => s.call('DELETE', '/api/admin/interest', { token, body: { slug } });
  assert.equal((await clear(await sign({ email: 'someone@example.com' }), 'corgi')).status, 403);
  assert.equal((await clear(owner, 'not-a-pin')).status, 400);
  const res = await (await clear(owner, 'corgi')).json();
  assert.equal(res.cleared, 2);
  assert.equal(res.interest.corgi, undefined);
  const body = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(body.interest.corgi, undefined);
  assert.equal(body.asked.corgi, undefined);
  assert.equal((await catalog(s)).items.find((p) => p.slug === 'corgi').interest, 0);
  // the browser that tapped before can tap again, and it counts from 0
  assert.deepEqual(await (await vote(s, 'corgi', { cookie: 'jka_voter=' + ticketOf(first) })).json(), { counted: true, count: 1 });
});

const unvote = (s, slug, opts = {}) => s.call('DELETE', '/api/interest', { body: { slug }, ...opts });

test('tapping again takes the vote back: one off the tally, and the browser can vote again', async () => {
  const s = setup();
  const first = await vote(s, 'corgi');
  const cookie = 'jka_voter=' + ticketOf(first);
  await vote(s, 'corgi', { ip: '9.9.9.9' }); // someone else
  assert.deepEqual(await (await unvote(s, 'corgi', { cookie })).json(), { removed: true, count: 1 });
  assert.equal((await catalog(s)).items.find((p) => p.slug === 'corgi').interest, 1);
  // a second take-back finds nothing of theirs, and never goes below what others gave
  assert.deepEqual(await (await unvote(s, 'corgi', { cookie })).json(), { removed: false, reason: 'not counted', count: 1 });
  // and they can say yes again
  assert.deepEqual(await (await vote(s, 'corgi', { cookie })).json(), { counted: true, count: 2 });
});

test('no ticket, or another browser\'s ticket, takes nothing back', async () => {
  const s = setup();
  await vote(s, 'corgi');
  assert.equal((await (await unvote(s, 'corgi')).json()).removed, false);
  assert.equal((await (await unvote(s, 'corgi', { cookie: 'jka_voter=00000000-0000-4000-8000-000000000000' })).json()).removed, false);
  assert.equal((await unvote(s, 'not-a-pin')).status, 400);
  assert.equal((await unvote(s, 'corgi', { origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await catalog(s)).items.find((p) => p.slug === 'corgi').interest, 1);
});

test('tapping on and off does not use up the daily limit for one connection', async () => {
  const s = setup();
  const cookie = 'jka_voter=' + ticketOf(await vote(s, 'corgi'));
  await unvote(s, 'corgi', { cookie });
  for (let i = 0; i < IP_DAILY_CAP + 3; i++) {
    assert.equal((await (await vote(s, 'corgi', { cookie })).json()).counted, true);
    assert.equal((await (await unvote(s, 'corgi', { cookie })).json()).removed, true);
  }
  assert.equal((await (await vote(s, 'corgi', { cookie })).json()).counted, true);
});

// the bay area pin board goes through exactly what the pins do: the owner's switch, the vote, taking it back,
// the public tally and the owner's tally
test('the pin board: switched off on /admin, it takes "i\'m interested" votes like a pin', async () => {
  const s = setup({ unavailable: [] });
  const owner = await sign({ email: OWNER });
  const slug = 'bay-area-pin-board';
  // while it's available there's nothing to wait for
  assert.equal((await vote(s, slug)).status, 409);

  assert.equal((await s.call('POST', '/api/admin/availability', { token: owner, body: { slug, available: false } })).status, 200);
  let board = (await catalog(s)).items.find((p) => p.slug === slug);
  assert.equal(board.available, false);
  assert.deepEqual(board.sizes, []);

  const first = await vote(s, slug);
  assert.deepEqual(await first.json(), { counted: true, count: 1 });
  const cookie = 'jka_voter=' + ticketOf(first);
  assert.equal((await vote(s, slug, { ip: '9.9.9.9' })).status, 200);
  assert.equal((await catalog(s)).items.find((p) => p.slug === slug).interest, 2);

  // tapped again: one off
  assert.deepEqual(await (await unvote(s, slug, { cookie })).json(), { removed: true, count: 1 });
  const body = await (await s.call('GET', '/api/admin/products', { token: owner })).json();
  assert.equal(body.available[slug], false);
  assert.equal(body.interest[slug], 1);

  // checkout won't sell it while it's switched off
  assert.equal((await s.call('POST', '/api/checkout', { body: { items: [{ key: slug, qty: 1 }] } })).status, 400);
});
