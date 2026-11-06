// Tests for Google Merchant Center (server/merchant.js): what Google is told, only what changed, failing closed,
// never from the sandbox, and the owner's card on /admin. Google and Square are pretend (tests/helpers.mjs).
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { syncMerchant, merchantProducts, offerId } from '../server/merchant.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const OWNER = 'owner@example.com';
const API = 'https://merchantapi.googleapis.com';

// a pretend Merchant Center: data sources, product inputs, and Google's view of each product
function fakeMerchant() {
  const sources = [];
  const inputs = {};
  const calls = [];
  let down = false;
  const fetchFn = async (url, opts = {}) => {
    if (!url.startsWith(API)) return null;
    const method = opts.method || 'GET';
    calls.push(method + ' ' + url.slice(API.length));
    if (down) return Response.json({ error: { message: 'resting' } }, { status: 503 });
    if (!opts.headers || opts.headers.Authorization !== 'Bearer server-token') return Response.json({ error: { message: 'no' } }, { status: 401 });
    const path = new URL(url).pathname;
    if (/\/datasources\/v1\/accounts\/\d+\/dataSources$/.test(path)) {
      if (method === 'GET') return Response.json({ dataSources: sources });
      const made = { ...JSON.parse(opts.body), name: 'accounts/123/dataSources/' + (900 + sources.length) };
      sources.push(made);
      return Response.json(made);
    }
    if (path.endsWith('/productInputs:insert')) {
      const p = JSON.parse(opts.body);
      inputs[p.offerId] = p;
      return Response.json({ ...p, name: 'accounts/123/productInputs/en~US~' + p.offerId });
    }
    const del = /\/productInputs\/(.+)$/.exec(path);
    if (del && method === 'DELETE') {
      const id = decodeURIComponent(del[1]).split('~')[2];
      if (!inputs[id]) return Response.json({ error: { message: 'not found' } }, { status: 404 });
      delete inputs[id];
      return Response.json({});
    }
    if (path.endsWith('/products') && method === 'GET') {
      return Response.json({ products: Object.values(inputs).map((p) => ({
        offerId: p.offerId,
        productStatus: p.offerId === 'aussie-large'
          ? { destinationStatuses: [{ disapprovedCountries: ['US'] }], itemLevelIssues: [{ severity: 'DISAPPROVED', description: 'image too small', resolution: 'use a bigger picture' }] }
          : { destinationStatuses: [{ approvedCountries: ['US'] }] }
      })) });
    }
    if (path.endsWith('/developerRegistration:registerGcp')) return Response.json({ name: 'accounts/123/developerRegistration', gcpIds: ['1'] });
    return Response.json({ error: { message: 'unknown' } }, { status: 404 });
  };
  return { sources, inputs, calls, fetchFn, setDown: (v) => { down = v; } };
}

// aussie: 3 standard and 48 large in stock. pomeranian: linked, but ticked sold out in Square. corgi: not linked
function setup({ open = true, mode = 'production', account = '123', availableOff = [] } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  const m = fakeMerchant();
  w.g.docs['settings/shop'] = { open: { booleanValue: open } };
  w.g.docs['settings/square_' + mode] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), pomeranian: str('V_POM') };
  for (const slug of availableOff) w.g.docs['settings/available_' + mode] = { [slug]: { booleanValue: false } };
  const fetchFn = async (url, opts) => (await m.fetchFn(String(url), opts)) || w.fetchFn(String(url), opts);
  globalThis.fetch = fetchFn;
  const env = {
    ...baseEnv, SQUARE_ENV: mode, ADMIN_EMAILS: OWNER,
    ...(account ? { MERCHANT_ACCOUNT_ID: account } : {}),
    ASSETS: { fetch: async () => Response.json(products) }
  };
  const call = async (method, path, token, body) => {
    const headers = token ? { Authorization: 'Bearer ' + token } : {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  const sync = (opts = {}) => syncMerchant(env, { fetchFn, ...opts });
  return { ...w, m, env, call, sync, fetchFn };
}
const sentIds = (s) => Object.keys(s.m.inputs).sort();

test('offer ids keep to letters, numbers and dashes', () => {
  assert.equal(offerId('aussie'), 'aussie');
  assert.equal(offerId('aussie:large'), 'aussie-large');
});

test('google gets the square price and stock, both aussie sizes grouped, and nothing unlinked', async () => {
  const s = setup();
  const r = await s.sync();
  assert.equal(r.lastError, '');
  assert.deepEqual(sentIds(s), ['aussie', 'aussie-large', 'pomeranian']);
  const std = s.m.inputs.aussie;
  assert.equal(std.contentLanguage, 'en');
  assert.equal(std.feedLabel, 'US');
  const a = std.productAttributes;
  assert.equal(a.title, 'aussie australian shepherd enamel pin, standard size');
  assert.deepEqual(a.price, { amountMicros: '12000000', currencyCode: 'USD' });
  assert.equal(a.availability, 'IN_STOCK');
  assert.equal(a.link, 'https://ourjkadventures.com/pup-club/aussie');
  assert.equal(a.imageLink, 'https://ourjkadventures.com/assets/img/merchant/aussie.jpg');
  assert.equal(a.itemGroupId, 'aussie');
  assert.equal(a.size, 'standard');
  assert.equal(a.brand, 'j+k adventures');
  assert.equal(a.identifierExists, false);
  assert.equal(a.shipping[0].country, 'US');
  assert.equal(s.m.inputs['aussie-large'].productAttributes.price.amountMicros, '15000000');
  // the pomeranian is ticked sold out in square: listed, but out of stock. it comes in two sizes on the website,
  // so it's grouped even though only one is linked so far
  const pom = s.m.inputs.pomeranian.productAttributes;
  assert.equal(pom.availability, 'OUT_OF_STOCK');
  assert.equal(pom.itemGroupId, 'pomeranian');
  assert.equal(pom.title, 'pomeranian dog enamel pin, standard size');
  // it made its own product list in merchant center, once
  assert.equal(s.m.sources.length, 1);
  assert.equal(s.m.sources[0].displayName, 'website (ourjkadventures.com)');
});

test('no discounts, ever: no sale price or minimum price is sent', async () => {
  const s = setup();
  await s.sync();
  for (const p of Object.values(s.m.inputs)) {
    for (const k of ['salePrice', 'salePriceEffectiveDate', 'autoPricingMinPrice', 'promotionIds', 'loyaltyPrograms']) {
      assert.equal(p.productAttributes[k], undefined, k + ' on ' + p.offerId);
    }
  }
});

test('every product in the shop has a picture for google', () => {
  for (const p of products.items) {
    assert.ok(fs.existsSync(new URL('../site/assets/img/merchant/' + p.slug + '.jpg', import.meta.url)), p.slug + ': run python3 scripts/merchant-pictures.py');
  }
});

test('a closed shop is out of stock on google', async () => {
  const s = setup({ open: false });
  await s.sync();
  assert.deepEqual(sentIds(s), ['aussie', 'aussie-large', 'pomeranian']);
  for (const p of Object.values(s.m.inputs)) assert.equal(p.productAttributes.availability, 'OUT_OF_STOCK');
});

test('only what changed is sent again, and a switched-off product is taken down', async () => {
  const s = setup();
  await s.sync();
  const inserts = () => s.m.calls.filter((c) => c.includes(':insert')).length;
  assert.equal(inserts(), 3);
  _resetCatalogCache();
  await s.sync();
  assert.equal(inserts(), 3, 'nothing changed, nothing sent');
  // the booth sold the last standard aussies
  s.sq.stock.V_AUS = 0;
  await s.sync();
  assert.equal(inserts(), 4);
  assert.equal(s.m.inputs.aussie.productAttributes.availability, 'OUT_OF_STOCK');
  // the owner switches the pomeranian off on /admin
  s.g.docs['settings/available_production'] = { pomeranian: { booleanValue: false } };
  const r = await s.sync();
  assert.equal(r.lastRemoved, 1);
  assert.deepEqual(sentIds(s), ['aussie', 'aussie-large']);
  // the data source was looked up once and then remembered
  assert.equal(s.m.sources.length, 1);
  assert.equal(s.m.calls.filter((c) => c.startsWith('POST /datasources')).length, 1);
});

test('if square can\'t be read, everything on google goes out of stock and nothing is taken down', async () => {
  const s = setup();
  await s.sync();
  _resetCatalogCache();
  const broken = async (url, opts) => (String(url).includes('squareup') ? new Response('down', { status: 500 }) : s.fetchFn(url, opts));
  const r = await syncMerchant(s.env, { fetchFn: broken });
  assert.match(r.lastError, /shelf/);
  assert.deepEqual(sentIds(s), ['aussie', 'aussie-large', 'pomeranian']);
  for (const p of Object.values(s.m.inputs)) assert.equal(p.productAttributes.availability, 'OUT_OF_STOCK');
  // and when square is back, the aussies are back in stock
  const back = await s.sync();
  assert.equal(back.lastError, '');
  assert.equal(s.m.inputs.aussie.productAttributes.availability, 'IN_STOCK');
});

test('sandbox prices never reach google, and nothing happens until the account is set', async () => {
  const sandbox = setup({ mode: 'sandbox' });
  assert.deepEqual(await sandbox.sync(), { skipped: 'sandbox' });
  assert.equal(sandbox.m.calls.length, 0);
  const none = setup({ account: '' });
  assert.deepEqual(await none.sync(), { skipped: 'not configured' });
  assert.equal(none.m.calls.length, 0);
});

test('google being down is noted, not thrown', async () => {
  const s = setup();
  s.m.setDown(true);
  const r = await s.sync();
  assert.match(r.lastError, /503/);
  assert.equal(r.listed, 0);
});

test('a product with no page of its own is not sent', () => {
  const catalog = { open: true, currency: 'USD', shipping_cents: 500, items: [{ slug: 'mystery', available: true, sizes: [{ size: 'standard', key: 'mystery', price_cents: 1200, stock: 4 }] }] };
  assert.deepEqual(merchantProducts(catalog, { items: [{ slug: 'mystery', name: 'mystery', kind: 'pin', series: 'hometown' }] }), {});
});

test('the 10-minute timer runs the sync', async () => {
  const s = setup();
  const waits = [];
  await worker.scheduled({ cron: '*/10 * * * *' }, s.env, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.deepEqual(sentIds(s), ['aussie', 'aussie-large', 'pomeranian']);
});

test('/admin: only the owner sees google shopping, with what google says about each product', async () => {
  const s = setup();
  const stranger = await sign({ sub: 'u2', email: 'someone@example.com', email_verified: true, aud: 'jk-test', iss: 'https://securetoken.google.com/jk-test' });
  assert.equal((await s.call('GET', '/api/admin/merchant', stranger)).status, 403);
  const owner = await sign({ sub: 'u1', email: OWNER, email_verified: true, aud: 'jk-test', iss: 'https://securetoken.google.com/jk-test' });
  const before = await (await s.call('GET', '/api/admin/merchant', owner)).json();
  assert.equal(before.live, true);
  assert.equal(before.listed, 0);
  const sent = await (await s.call('POST', '/api/admin/merchant', owner, { action: 'send' })).json();
  assert.equal(sent.listed, 3);
  const large = sent.products.find((p) => p.offerId === 'aussie-large');
  assert.equal(large.price_cents, 1500);
  assert.equal(large.google.disapproved, true);
  assert.equal(large.google.issues[0].description, 'image too small');
  assert.equal(sent.products.find((p) => p.offerId === 'aussie').google.approved, true);
  const reg = await s.call('POST', '/api/admin/merchant', owner, { action: 'register' });
  assert.equal(reg.status, 200);
  assert.ok(s.m.calls.some((c) => c.includes('developerRegistration:registerGcp')));
});

test('/admin: in sandbox mode the buttons send nothing', async () => {
  const s = setup({ mode: 'sandbox' });
  const owner = await sign({ sub: 'u1', email: OWNER, email_verified: true, aud: 'jk-test', iss: 'https://securetoken.google.com/jk-test' });
  const res = await s.call('POST', '/api/admin/merchant', owner, { action: 'send' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).live, false);
  assert.equal(s.m.calls.length, 0);
});
