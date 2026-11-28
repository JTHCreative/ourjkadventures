// Tests for code cards: what a code looks like, the owner's print runs, registering a card (once, to one account),
// the wrong-guess limit, and the collection. Google is faked. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { cleanCode, cleanPlace, codePins, randomTail, LETTERS, TRIES_PER_HOUR, BATCH_MAX } from '../server/codes.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url), 'utf8'));

function setup() {
  _resetCaches();
  const w = fakeWorld();
  globalThis.fetch = w.fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) } };
  const call = async (method, path, { token, body } = {}) => {
    const headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  const asOwner = async (method, path, body) => call(method, path, { token: await sign({ email: OWNER, sub: 'owner1' }), body });
  // a print run, and its codes
  const print = async (slug, count, size) => {
    const made = await (await asOwner('POST', '/api/admin/codes', { slug, count, size })).json();
    const run = await (await asOwner('GET', '/api/admin/codes/batch?id=' + made.made)).json();
    return { id: made.made, codes: run.codes.map((c) => c.code), list: made };
  };
  const register = async (code, claims = {}) => {
    const res = await call('POST', '/api/codes/register', { token: await sign(claims), body: { code } });
    return { http: res.status, ...(await res.json()) };
  };
  const str = (path, field) => { const v = w.g.docs[path] && w.g.docs[path][field]; return v ? (v.stringValue ?? Number(v.integerValue)) : undefined; };
  return { ...w, env, call, asOwner, print, register, str };
}

test('a code is three letters for the pin and five characters that are easy to read', () => {
  assert.equal(cleanCode('AUS7K2M9'), 'AUS7K2M9');
  assert.equal(cleanCode(' aus-7k2m9 '), 'AUS7K2M9');
  assert.equal(cleanCode('AUS 7K2 M9'), 'AUS7K2M9');
  for (const bad of ['AUS7K2M', 'AUS7K2M99', 'AUS7K2M0', 'AUS7K2MA', 'AUS7K2ML', '1US7K2M9', '', null, 42, 'x'.repeat(50)]) assert.equal(cleanCode(bad), null, String(bad));
  assert.equal(new Set(LETTERS).size, LETTERS.length);
  assert.doesNotMatch(LETTERS, /[AEIOU01L]/);
  for (let i = 0; i < 50; i++) assert.ok(cleanCode('AUS' + randomTail()));
});

test('every pin in products.json has its own three letters', () => {
  const pins = codePins(products);
  const allPins = products.items.filter((p) => p.kind === 'pin');
  assert.equal(pins.length, allPins.length, 'a pin is missing its "code" in products.json');
  assert.equal(new Set(pins.map((p) => p.prefix)).size, pins.length);
  assert.equal(pins.find((p) => p.slug === 'aussie').prefix, 'AUS');
  assert.equal(pins.find((p) => p.slug === 'golden').name, 'goldie');
});

test('only the owner makes print runs', async () => {
  const s = setup();
  assert.equal((await s.call('GET', '/api/admin/codes')).status, 401);
  assert.equal((await s.call('POST', '/api/admin/codes', { token: await sign({ email: 'pup@example.com' }), body: { slug: 'aussie', count: 5 } })).status, 403);
  assert.equal(Object.keys(s.g.docs).filter((k) => k.startsWith('codes/')).length, 0);
});

test('a print run makes that many fresh codes for one pin and size', async () => {
  const s = setup();
  const run = await s.print('aussie', 12, 'large');
  assert.equal(run.codes.length, 12);
  assert.equal(new Set(run.codes).size, 12);
  for (const c of run.codes) { assert.match(c, /^AUS/); assert.equal(cleanCode(c), c); assert.equal(s.str('codes/' + c, 'size'), 'large'); }
  assert.deepEqual(run.list.batches.map((b) => [b.slug, b.size, b.count, b.claimed]), [['aussie', 'large', 12, 0]]);
  assert.ok(run.list.pins.some((p) => p.slug === 'corgi' && p.prefix === 'COR'));

  const bad = async (body) => (await s.asOwner('POST', '/api/admin/codes', body)).status;
  assert.equal(await bad({ slug: 'bay-area-pin-board', count: 5 }), 400);
  assert.equal(await bad({ slug: 'corgi', count: 5, size: 'large' }), 400);
  assert.equal(await bad({ slug: 'corgi', count: 0 }), 400);
  assert.equal(await bad({ slug: 'corgi', count: BATCH_MAX + 1 }), 400);
  assert.equal(await bad({ slug: 'corgi', count: '5' }), 400);
  assert.equal((await s.asOwner('GET', '/api/admin/codes/batch?id=nope')).status, 400);
});

test('registering needs a signed-in account with a confirmed email', async () => {
  const s = setup();
  const { codes } = await s.print('corgi', 1);
  assert.equal((await s.call('POST', '/api/codes/register', { body: { code: codes[0] } })).status, 401);
  const r = await s.register(codes[0], { email_verified: false });
  assert.equal(r.http, 403);
  assert.equal(r.error, 'confirm');
  assert.equal((await s.register('nonsense')).http, 400);
  assert.equal(s.str('codes/' + codes[0], 'claimedBy'), undefined);
});

test('a card works once, for the first account to register it', async () => {
  const s = setup();
  const { id, codes } = await s.print('aussie', 2);
  const first = await s.register(codes[0].toLowerCase().replace(/^(...)/, '$1-'), { sub: 'juniper' });
  assert.deepEqual([first.status, first.pin, first.charges], ['registered', { slug: 'aussie', size: 'standard', name: 'aussie' }, 1]);
  assert.equal(s.str('codes/' + codes[0], 'claimedBy'), 'juniper');
  assert.equal(s.str('users/juniper', 'charges'), 1);
  assert.equal(s.str('users/juniper', 'lifetimeCharges'), 1);
  assert.equal(s.str('code_batches/' + id, 'claimed'), 1);

  // the same person again: nothing more is counted
  assert.equal((await s.register(codes[0], { sub: 'juniper' })).status, 'yours');
  assert.equal(s.str('users/juniper', 'charges'), 1);
  // someone else: too late, and nothing for them
  assert.equal((await s.register(codes[0], { sub: 'maple' })).status, 'taken');
  assert.equal(s.g.docs['users/maple'], undefined);
  // the lock holds even if the card itself somehow still looked free
  delete s.g.docs['codes/' + codes[0]].claimedBy;
  assert.equal((await s.register(codes[0], { sub: 'maple' })).status, 'taken');
  assert.equal((await s.register(codes[0], { sub: 'juniper' })).status, 'yours');
  assert.equal(s.str('users/juniper', 'charges'), 1);

  assert.equal((await s.register(codes[1], { sub: 'juniper' })).charges, 2);
  const mine = await (await s.call('GET', '/api/collection', { token: await sign({ sub: 'juniper' }) })).json();
  assert.equal(mine.charges, 2);
  assert.deepEqual(mine.pins.map((p) => p.slug), ['aussie', 'aussie']);
  assert.equal((await (await s.call('GET', '/api/collection', { token: await sign({ sub: 'maple' }) })).json()).pins.length, 0);
});

test('wrong guesses run out for the hour, right ones do not count against you', async () => {
  const s = setup();
  const { codes } = await s.print('pug', 2);
  assert.equal((await s.register(codes[0])).status, 'registered');
  for (let i = 0; i < TRIES_PER_HOUR; i++) assert.equal((await s.register('PUG22222')).status, 'unknown');
  assert.equal((await s.register('PUG22222')).status, 'limit');
  assert.equal((await s.register(codes[1])).status, 'limit');
  // another account isn't held up by it
  assert.equal((await s.register(codes[1], { sub: 'maple' })).status, 'registered');
});

test('the owner can look a card up, cancel a lost one and put it back', async () => {
  const s = setup();
  const { codes } = await s.print('shiba', 2);
  const card = async (body) => { const r = await s.asOwner('POST', '/api/admin/codes/card', body); return { http: r.status, ...(await r.json()) }; };
  assert.equal((await card({ code: codes[0] })).card.status, 'open');
  assert.equal((await card({ code: 'SHI22222' })).http, 404);
  assert.equal((await card({ code: codes[0], cancelled: true })).card.status, 'cancelled');
  assert.equal((await s.register(codes[0])).status, 'unknown');
  assert.equal((await card({ code: codes[0], cancelled: false })).card.status, 'open');

  s.g.docs['users/uid123'] = { email: { stringValue: 'pup@example.com' } };
  assert.equal((await s.register(codes[0])).status, 'registered');
  const found = (await card({ code: codes[0] })).card;
  assert.deepEqual([found.status, found.email, found.pin.slug], ['registered', 'pup@example.com', 'shiba']);
  // a registered card is in someone's collection: it can't be cancelled
  assert.equal((await card({ code: codes[0], cancelled: true })).http, 409);
});

test('deleting an account takes its pins with it, and the cards stay used', async () => {
  const s = setup();
  const { codes } = await s.print('husky', 1);
  await s.register(codes[0]);
  assert.ok(s.g.docs['users/uid123/collection/' + codes[0]]);
  assert.equal((await s.call('DELETE', '/api/account', { token: await sign({}) })).status, 200);
  assert.equal(s.g.docs['users/uid123/collection/' + codes[0]], undefined);
  assert.equal((await s.register(codes[0], { sub: 'maple' })).status, 'taken');
});

test('the register page keeps to itself: not indexed, no pixel, and the same letters as the server', () => {
  const read = (f) => fs.readFileSync(new URL('../site/' + f, import.meta.url), 'utf8');
  const page = read('register.html');
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.match(page, /data-account-page="register"/);
  assert.match(read('assets/pixel.js'), /QUIET = [^\n]*\|register\)/);
  assert.ok(read('assets/account.js').includes("const CODE_LETTERS = '" + LETTERS + "';"));
  assert.ok(!read('sitemap.xml').includes('/register'));
});

test('the pin board: only your own pins can be placed, and only in sensible spots', async () => {
  const s = setup();
  const { codes } = await s.print('corgi', 3);
  await s.register(codes[0], { sub: 'juniper' });
  await s.register(codes[1], { sub: 'juniper' });
  await s.register(codes[2], { sub: 'maple' });
  const mine = async (sub) => (await (await s.call('GET', '/api/collection', { token: await sign({ sub }) })).json()).pins;
  const save = async (sub, pins) => (await s.call('POST', '/api/collection/board', { token: await sign({ sub }), body: { pins } })).status;

  // a new pin waits in the tray
  assert.deepEqual((await mine('juniper')).map((p) => [p.on, p.x, p.y, p.r]), [[false, 0.5, 0.5, 0], [false, 0.5, 0.5, 0]]);
  assert.equal(await save('juniper', [{ id: codes[0], x: 0.251234, y: 0.75, r: -30.04, z: 2 }]), 200);
  const placed = (await mine('juniper')).find((p) => p.id === codes[0]);
  assert.deepEqual([placed.on, placed.x, placed.y, placed.r, placed.z, placed.slug], [true, 0.2512, 0.75, -30, 2, 'corgi']);
  // back to the tray: it stays in the collection
  assert.equal(await save('juniper', [{ id: codes[0], off: true }]), 200);
  assert.equal((await mine('juniper')).find((p) => p.id === codes[0]).on, false);
  assert.equal((await mine('juniper')).length, 2);

  // someone else's pin, or one nobody has: nothing is saved, not even the good half of the list
  assert.equal(await save('juniper', [{ id: codes[1], x: 0.1, y: 0.1, r: 0, z: 1 }, { id: codes[2], x: 0.5, y: 0.5, r: 0, z: 1 }]), 404);
  assert.equal((await mine('juniper')).find((p) => p.id === codes[1]).on, false);
  assert.equal(s.g.docs['users/juniper/collection/' + codes[2]], undefined);
  assert.equal((await mine('maple'))[0].on, false);

  for (const bad of [[], 'x', [{ id: codes[1], x: 1.2, y: 0.5, r: 0, z: 1 }], [{ id: codes[1], x: 0.5, y: 0.5, r: 400, z: 1 }], [{ id: codes[1], x: '0.5', y: 0.5, r: 0, z: 1 }],
    [{ id: 'nope', x: 0.5, y: 0.5, r: 0, z: 1 }], [{ id: codes[1], off: true }, { id: codes[1], off: true }]]) {
    assert.equal(await save('juniper', bad), 400, JSON.stringify(bad));
  }
  assert.equal((await s.call('POST', '/api/collection/board', { body: { pins: [] } })).status, 401);
  assert.equal(cleanPlace({ id: codes[1].toLowerCase(), off: true }), null);
  // charges are never touched by the board
  assert.equal(s.str('users/juniper', 'charges'), 2);
});
