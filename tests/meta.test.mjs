// Tests for the Meta Pixel's server side (server/meta.js): Purchase from /api/checkout/pay, the browser's events
// passed on by /api/meta-event, consent, hashing, and that the pixel's number and the secret stay where they belong.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { hashEmail, _resetMetaLimit } from '../server/meta.js';
import { META_PIXEL_ID } from '../site/assets/pixel-id.js';
import { fakeWorld, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const TOKEN = 'capi-secret-token';

function setup(extraEnv = { META_CAPI_TOKEN: TOKEN }, metaStatus = 200) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  _resetMetaLimit();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: true } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), pomeranian: str('V_POM') };
  const meta = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes('graph.facebook.com')) {
      meta.push({ url: String(url), body: JSON.parse(opts.body) });
      return metaStatus === 200 ? Response.json({ events_received: 1 }) : Response.json({ error: { message: 'nope' } }, { status: metaStatus });
    }
    return w.fetchFn(url, opts);
  };
  const env = { ...baseEnv, SQUARE_APPLICATION_ID: 'sandbox-sq0idb-test', ...extraEnv, ASSETS: { fetch: async () => Response.json(products) } };
  return { ...w, env, meta };
}
const HOME = { name: 'pup person', email: ' Buyer@Example.com ', line1: '1 main st', line2: '', city: 'oakland', state: 'CA', zip: '94607' };
const post = (env, path, body, headers = {}) => worker.fetch(new Request('https://x.test' + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9', 'User-Agent': 'test browser', ...headers },
  body: JSON.stringify(body)
}), env);
const pay = (env, extra = {}) => post(env, '/api/checkout/pay', {
  items: [{ key: 'aussie', qty: 2 }], shipping: 'ground', ship_to: HOME, heard_from: 'google', source_id: 'cnon:card-nonce-ok', attempt: 'attempt-0001', ...extra
});
const FBP = 'fb.1.1700000000000.1234567890';
const event = (env, extra = {}, headers) => post(env, '/api/meta-event', {
  name: 'AddToCart', event_id: 'evt-12345678', items: [{ key: 'aussie:large', qty: 1 }], path: '/pup-club/aussie', fbp: FBP, fbc: '', ...extra
}, headers);

test('an email is scrambled the way meta asks: trimmed, lowercase, sha-256', async () => {
  assert.equal(await hashEmail(' Buyer@Example.com '), crypto.createHash('sha256').update('buyer@example.com').digest('hex'));
  assert.equal(await hashEmail(''), '');
});

test('a paid order without a yes on the cookie note: the page gets its ticket, meta hears nothing from us', async () => {
  const { env, sq, meta } = setup();
  const r = await pay(env);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.purchase.event_id, 'purchase-' + sq.orders[0].order.id);
  // items, shipping and tax, as Square worked it out
  assert.equal(j.purchase.value, 33.25);
  assert.equal(j.purchase.currency, 'USD');
  assert.deepEqual(j.purchase.content_ids, ['aussie']);
  assert.equal(j.purchase.num_items, 2);
  assert.equal(meta.length, 0);
});

test('a paid order with a yes: one Purchase to meta, same ticket, email scrambled, the key never in the address', async () => {
  const { env, sq, meta } = setup();
  const r = await pay(env, { meta: { consent: true, fbp: FBP, fbc: 'not a cookie' }, tip: { cents: 500 } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(meta.length, 1);
  assert.equal(meta[0].url, 'https://graph.facebook.com/v26.0/' + META_PIXEL_ID + '/events');
  assert.equal(meta[0].url.includes(TOKEN), false);
  assert.equal(meta[0].body.access_token, TOKEN);
  assert.equal(meta[0].body.test_event_code, undefined);
  const e = meta[0].body.data[0];
  assert.equal(e.event_name, 'Purchase');
  assert.equal(e.event_id, j.purchase.event_id);
  assert.equal(e.action_source, 'website');
  // the tip isn't part of the order's value
  assert.equal(e.custom_data.value, 33.25);
  assert.equal(e.custom_data.currency, 'USD');
  assert.equal(e.custom_data.order_id, sq.orders[0].order.id);
  assert.deepEqual(e.custom_data.contents, [{ id: 'aussie', quantity: 2, item_price: 12 }]);
  assert.deepEqual(e.user_data.em, [crypto.createHash('sha256').update('buyer@example.com').digest('hex')]);
  assert.equal(e.user_data.fbp, FBP);
  assert.equal(e.user_data.fbc, undefined);
  assert.equal(e.user_data.client_ip_address, '203.0.113.9');
  assert.equal(JSON.stringify(e).toLowerCase().includes('buyer@example.com'), false);
  assert.equal(JSON.stringify(e).includes('main st'), false);
});

test('meta being down, or no key, never gets in the way of a sale', async () => {
  let s = setup({ META_CAPI_TOKEN: TOKEN }, 500);
  assert.equal((await pay(s.env, { meta: { consent: true } })).status, 200);
  assert.equal(s.meta.length, 1);
  s = setup({});
  assert.equal((await pay(s.env, { meta: { consent: true } })).status, 200);
  assert.equal(s.meta.length, 0);
});

test('the test code rides along only while it is set', async () => {
  const { env, meta } = setup({ META_CAPI_TOKEN: TOKEN, META_TEST_EVENT_CODE: 'TEST123' });
  await event(env);
  assert.equal(meta[0].body.test_event_code, 'TEST123');
});

test('/api/meta-event passes a browser event on with our own price', async () => {
  const { env, meta } = setup();
  const r = await event(env, { value: 0.01 });
  assert.equal(r.status, 200);
  assert.equal(meta.length, 1);
  const e = meta[0].body.data[0];
  assert.equal(e.event_name, 'AddToCart');
  assert.equal(e.event_id, 'evt-12345678');
  assert.equal(e.event_source_url, 'https://x.test/pup-club/aussie');
  assert.equal(e.custom_data.value, 15);
  assert.deepEqual(e.custom_data.content_ids, ['aussie:large']);
  assert.equal(e.custom_data.content_name, 'aussie');
  assert.equal(e.user_data.fbp, FBP);
  assert.equal(e.user_data.em, undefined);
});

test('/api/meta-event: a product not in the shop yet is seen without a price', async () => {
  const { env, meta } = setup();
  assert.equal((await event(env, { name: 'ViewContent', items: [{ key: 'corgi', qty: 1 }] })).status, 200);
  assert.deepEqual(meta[0].body.data[0].custom_data.content_ids, ['corgi']);
  assert.equal(meta[0].body.data[0].custom_data.value, undefined);
});

test('/api/meta-event turns away what it should', async () => {
  const { env, meta } = setup();
  assert.equal((await event(env, { name: 'Purchase' })).status, 400);
  assert.equal((await event(env, { name: 'Lead' })).status, 400);
  assert.equal((await event(env, { event_id: 'x' })).status, 400);
  assert.equal((await event(env, { items: [] })).status, 400);
  assert.equal((await event(env, { items: [{ key: 'not-a-product', qty: 1 }] })).status, 400);
  assert.equal((await event(env, { items: [{ key: '<script>', qty: 1 }] })).status, 400);
  assert.equal((await event(env, {}, { Origin: 'https://elsewhere.example' })).status, 403);
  assert.equal((await worker.fetch(new Request('https://x.test/api/meta-event'), env)).status, 405);
  assert.equal(meta.length, 0);
  // an odd page address is left out, not passed on
  await event(env, { path: '/reset-password?oobCode=secret' });
  assert.equal(meta[0].body.data[0].event_source_url, 'https://x.test/');
});

test('/api/meta-event without the key answers ok and sends nothing; a flood from one connection is slowed', async () => {
  let s = setup({});
  const r = await event(s.env);
  assert.equal(r.status, 200);
  assert.equal(s.meta.length, 0);
  s = setup();
  let last;
  for (let i = 0; i < 61; i++) last = await event(s.env);
  assert.equal(last.status, 429);
  assert.equal(s.meta.length, 60);
});

test('the pixel\'s number lives in one file, and the browser code never names the secret', () => {
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((f) => {
    const p = dir + '/' + f.name;
    if (f.isDirectory()) { if (!['img', '3d', 'video'].includes(f.name)) walk(p); } else if (/\.(js|html|json|jsonc)$/.test(f.name)) files.push(p);
  });
  const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  walk(root + '/site');
  walk(root + '/server');
  files.push(root + '/wrangler.jsonc');
  const withId = files.filter((p) => fs.readFileSync(p, 'utf8').includes(META_PIXEL_ID)).map((p) => p.slice(root.length));
  assert.deepEqual(withId, ['/site/assets/pixel-id.js']);
  const browser = files.filter((p) => p.includes('/site/') && !p.endsWith('_worker.js'));
  assert.deepEqual(browser.filter((p) => fs.readFileSync(p, 'utf8').includes('META_CAPI_TOKEN')), []);
});

test('the pixel only loads after a yes, stays off the private pages, and guards every call', () => {
  const src = fs.readFileSync(new URL('../site/assets/pixel.js', import.meta.url), 'utf8');
  // meta's script is only ever added inside load(), and load() is only reached from empty() after a "yes"
  assert.equal(src.split('connect.facebook.net').length, 2);
  assert.match(src, /if \(choice !== 'yes'\) return;[^\n]*\n\s*load\(\);/);
  assert.match(src, /function load\(\) \{\s*if \(loaded \|\| quiet\) return;/);
  for (const page of ['admin', 'sign-in', 'account', 'reset-password', 'email']) assert.match(src, new RegExp('[(|]' + page + '[|)]'));
  // no bare fbq calls outside the guarded helper and the starter
  assert.match(src, /typeof window\.fbq === 'function'/);
  const app = fs.readFileSync(new URL('../site/assets/app.js', import.meta.url), 'utf8');
  assert.equal(/fbq\(/.test(app), false);
});
