// Tests for /api/admin: only a confirmed email on ADMIN_EMAILS gets in, and the open sign saves.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin, isAdmin } from '../server/admin.js';
import { account } from '../server/account.js';
import { isShopOpen, _resetShopCache } from '../server/shop.js';
import { _resetCaches } from '../server/firebase.js';
import { fakeGoogle, sign, stranger, env as baseEnv } from './helpers.mjs';

const OWNER = 'Owner@Example.com';
const env = { ...baseEnv, ADMIN_EMAILS: ' someone@else.com , owner@example.com ' };

function fresh() { _resetCaches(); _resetShopCache(); return fakeGoogle(); }
function call(g, method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return admin(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, g.fetchFn);
}

test('isAdmin wants a confirmed email on the list, ignoring capitals and spaces', () => {
  assert.equal(isAdmin({ email: OWNER, email_verified: true }, env), true);
  assert.equal(isAdmin({ email: OWNER, email_verified: false }, env), false);
  assert.equal(isAdmin({ email: OWNER }, env), false);
  assert.equal(isAdmin({ email: 'pup@example.com', email_verified: true }, env), false);
  assert.equal(isAdmin({ email: OWNER, email_verified: true }, { ...env, ADMIN_EMAILS: '' }), false);
});

test('no ticket, a forged ticket or an expired ticket is turned away', async () => {
  const g = fresh();
  assert.equal((await call(g, 'GET', '/api/admin')).status, 401);
  assert.equal((await call(g, 'GET', '/api/admin', await sign({ email: OWNER }, { key: stranger.privateKey }))).status, 401);
  const t = Math.floor(Date.now() / 1000);
  assert.equal((await call(g, 'GET', '/api/admin', await sign({ email: OWNER, exp: t - 600, iat: t - 4000 }))).status, 401);
  assert.equal((await call(g, 'GET', '/api/admin', await sign({ email: OWNER, aud: 'another-project' }))).status, 401);
});

test('a real customer, or the owner with an unconfirmed email, gets a 403', async () => {
  const g = fresh();
  assert.equal((await call(g, 'GET', '/api/admin', await sign({}))).status, 403);
  assert.equal((await call(g, 'GET', '/api/admin/shop', await sign({ email: OWNER, email_verified: false }))).status, 403);
  assert.equal((await call(g, 'POST', '/api/admin/shop', await sign({}), { open: true })).status, 403);
  assert.equal(g.docs['settings/shop'], undefined);
});

test('the owner opens and closes the shop, and the site sees it', async () => {
  const g = fresh();
  const token = await sign({ email: OWNER });
  assert.deepEqual(await (await call(g, 'GET', '/api/admin', token)).json(), { admin: true, email: OWNER });
  assert.equal((await (await call(g, 'GET', '/api/admin/shop', token)).json()).open, false);
  assert.equal(await isShopOpen(env, g.fetchFn), false);

  const r = await call(g, 'POST', '/api/admin/shop', token, { open: true });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).open, true);
  assert.equal(g.docs['settings/shop'].updatedBy.stringValue, OWNER);
  assert.equal(await isShopOpen(env, g.fetchFn), true);

  await call(g, 'POST', '/api/admin/shop', token, { open: false });
  assert.equal(await isShopOpen(env, g.fetchFn), false);
});

test('the switch only takes a real true or false', async () => {
  const g = fresh();
  const token = await sign({ email: OWNER });
  for (const open of ['true', 1, null]) assert.equal((await call(g, 'POST', '/api/admin/shop', token, { open })).status, 400);
  assert.equal((await call(g, 'POST', '/api/admin/shop', token, {})).status, 400);
  assert.equal(g.docs['settings/shop'], undefined);
});

test('the open sign is remembered for a minute, so visitors do not each ask Firestore', async () => {
  const g = fresh();
  g.docs['settings/shop'] = { open: { booleanValue: true } };
  assert.equal(await isShopOpen(env, g.fetchFn), true);
  const reads = g.calls.filter((c) => c.includes('settings/shop')).length;
  await isShopOpen(env, g.fetchFn);
  await isShopOpen(env, g.fetchFn);
  assert.equal(g.calls.filter((c) => c.includes('settings/shop')).length, reads);
});

test('the account page learns whether to show the owner link', async () => {
  const g = fresh();
  const hello = async (token) => (await account(new Request('https://x.test/api/account', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token } }), env, g.fetchFn)).json();
  assert.equal((await hello(await sign({ email: OWNER, sub: 'owner1' }))).admin, true);
  assert.equal((await hello(await sign({}))).admin, false);
});

function review(slug, uid, status, rating = 4) {
  return {
    slug: { stringValue: slug }, uid: { stringValue: uid }, rating: { integerValue: String(rating) },
    text: { stringValue: 'lovely.' }, name: { stringValue: 'juniper h.' }, status: { stringValue: status },
    createdAt: { timestampValue: '2026-10-30T10:00:00Z' }
  };
}

test('the owner sees waiting reviews and can approve or hide them', async () => {
  const g = fresh();
  g.docs['reviews/corgi_uid9'] = review('corgi', 'uid9', 'pending', 2);
  g.docs['reviews/pug_uid8'] = review('pug', 'uid8', 'approved');
  const token = await sign({ email: OWNER });

  const list = (await (await call(g, 'GET', '/api/admin/reviews', token)).json()).reviews;
  assert.deepEqual(list.map((r) => r.id), ['corgi_uid9']);
  assert.equal(list[0].rating, 2);
  assert.equal(list[0].uid, undefined);

  assert.equal((await call(g, 'POST', '/api/admin/reviews', token, { id: 'corgi_uid9', status: 'approved' })).status, 200);
  assert.equal(g.docs['reviews/corgi_uid9'].status.stringValue, 'approved');
  assert.equal((await call(g, 'POST', '/api/admin/reviews', token, { id: 'pug_uid8', status: 'hidden' })).status, 200);
  assert.equal(g.docs['reviews/pug_uid8'].status.stringValue, 'hidden');
});

test('review changes need a known status, a real review, and the owner', async () => {
  const g = fresh();
  g.docs['reviews/corgi_uid9'] = review('corgi', 'uid9', 'pending');
  const token = await sign({ email: OWNER });
  assert.equal((await call(g, 'POST', '/api/admin/reviews', token, { id: 'corgi_uid9', status: 'deleted' })).status, 400);
  assert.equal((await call(g, 'POST', '/api/admin/reviews', token, { id: 'corgi_nobody', status: 'approved' })).status, 404);
  assert.equal((await call(g, 'POST', '/api/admin/reviews', token, { id: '../users/x', status: 'approved' })).status, 404);
  assert.equal((await call(g, 'POST', '/api/admin/reviews', await sign({}), { id: 'corgi_uid9', status: 'approved' })).status, 403);
  assert.equal((await call(g, 'GET', '/api/admin/reviews', await sign({}))).status, 403);
  assert.equal(g.docs['reviews/corgi_uid9'].status.stringValue, 'pending');
});

/* ---------- products: linking website products to Square items ---------- */
import { fakeWorld } from './helpers.mjs';
import { _resetCatalogCache } from '../server/catalog.js';
import fs from 'node:fs';
const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));

function world() {
  _resetCaches(); _resetShopCache(); _resetCatalogCache();
  const w = fakeWorld();
  const e = { ...env, ASSETS: { fetch: async () => Response.json(products) } };
  const go = (method, path, token, body) => {
    const headers = { Authorization: 'Bearer ' + token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return admin(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), e, w.fetchFn);
  };
  return { ...w, go };
}

test('the owner sees every website product, its sizes, and the Square items to choose from', async () => {
  const w = world();
  const body = await (await w.go('GET', '/api/admin/products', await sign({ email: OWNER }))).json();
  assert.equal(body.mode, 'sandbox');
  assert.ok(body.products.some((p) => p.key === 'aussie:large' && p.size === 'large'));
  assert.ok(body.products.some((p) => p.key === 'bay-area-pin-board'));
  assert.ok(!body.products.some((p) => p.key === 'bay-area-pin-board:large'));
  // archived items and items at another location are not offered
  assert.deepEqual(body.square.map((s) => s.id).sort(), ['V_AUS', 'V_AUS_L', 'V_POM']);
  assert.equal(body.square.find((s) => s.id === 'V_AUS_L').stock, 48);
  assert.deepEqual(body.links, {});
});

test('the owner links products; bad keys, unknown items and doubles are refused', async () => {
  const w = world();
  const t = await sign({ email: OWNER });
  assert.equal((await w.go('POST', '/api/admin/products', t, { links: { 'not-a-pin': 'V_AUS' } })).status, 400);
  assert.equal((await w.go('POST', '/api/admin/products', t, { links: { aussie: 'V_OLD' } })).status, 400);
  assert.equal((await w.go('POST', '/api/admin/products', t, { links: { aussie: 'V_AUS', corgi: 'V_AUS' } })).status, 400);
  assert.equal(w.g.docs['settings/square_sandbox'], undefined);

  const r = await w.go('POST', '/api/admin/products', t, { links: { aussie: 'V_AUS', 'aussie:large': 'V_AUS_L', corgi: '' } });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).links, { aussie: 'V_AUS', 'aussie:large': 'V_AUS_L' });
  assert.equal((await w.go('POST', '/api/admin/products', await sign({}), { links: {} })).status, 403);
});
