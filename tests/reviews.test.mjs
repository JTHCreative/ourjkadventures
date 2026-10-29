// Tests for /api/reviews, with Google and Firestore faked.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCaches } from '../server/firebase.js';
import { reviews, cleanText, _resetReviewCache } from '../server/reviews.js';
import { account } from '../server/account.js';
import { sign, fakeGoogle, env as baseEnv } from './helpers.mjs';

const catalog = { items: [
  { slug: 'corgi', name: 'corgi', kind: 'pin', price_cents: 1200 },
  { slug: 'pug', name: 'pug', kind: 'pin', price_cents: 1200 },
  { slug: 'bay-area-pin-board', name: 'bay area pin board', kind: 'board', price_cents: 8000 }
] };
const env = { ...baseEnv, ASSETS: { fetch: async () => Response.json(catalog) } };

const req = (method, token, { body, query = '' } = {}) => new Request('https://x.test/api/reviews' + query, {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : undefined
});
const post = (g, token, body) => reviews(req('POST', token, { body }), env, g.fetchFn);
const getPin = async (g, slug, token) => (await reviews(req('GET', token, { query: '?slug=' + slug }), env, g.fetchFn)).json();
const featured = async (g) => (await reviews(req('GET', null, { query: '?featured=1' }), env, g.fetchFn)).json();
// what the owner does in the Firebase console
const approve = (g, id) => { g.docs['reviews/' + id].status = { stringValue: 'approved' }; _resetReviewCache(); };

function fresh() {
  _resetCaches();
  _resetReviewCache();
  const g = fakeGoogle();
  g.docs['users/uid123'] = { firstName: { stringValue: 'juniper' }, lastName: { stringValue: 'hart' } };
  return g;
}

test('the note is cleaned: no tags or control characters, short, at most one blank line', () => {
  assert.equal(cleanText('  good <b>dog</b>\u0007  '), 'good bdog/b');
  assert.equal(cleanText('a\r\n\r\n\r\n\r\nb'), 'a\n\nb');
  assert.equal(cleanText('x'.repeat(900)).length, 600);
  assert.equal(cleanText(42), '');
});

test('only signed-in people with a confirmed email can leave a review', async () => {
  const g = fresh();
  assert.equal((await post(g, null, { slug: 'corgi', rating: 5 })).status, 401);
  assert.equal((await post(g, 'garbage', { slug: 'corgi', rating: 5 })).status, 401);
  assert.equal((await post(g, await sign({ email_verified: false }), { slug: 'corgi', rating: 5 })).status, 403);
  assert.equal(Object.keys(g.docs).filter((k) => k.startsWith('reviews/')).length, 0);
});

test('a rating must be a whole number from 1 to 5, on a pin that exists', async () => {
  const g = fresh();
  const tok = await sign({});
  for (const rating of [0, 6, 2.5, '5', null]) assert.equal((await post(g, tok, { slug: 'corgi', rating })).status, 400, String(rating));
  for (const slug of ['dragon', 'bay-area-pin-board', '../users/x', 7]) assert.equal((await post(g, tok, { slug, rating: 5 })).status, 400, String(slug));
});

test('a new review waits for the owner, then shows with its average and no account id', async () => {
  const g = fresh();
  const tok = await sign({});
  const r = await post(g, tok, { slug: 'corgi', rating: 5, text: 'wears it <i>every</i> day.' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { saved: true, status: 'pending' });
  const doc = g.docs['reviews/corgi_uid123'];
  assert.equal(doc.status.stringValue, 'pending');
  assert.equal(doc.name.stringValue, 'juniper h.');
  assert.equal(doc.text.stringValue, 'wears it ievery/i day.');

  // waiting: the public sees nothing yet, the writer sees their own
  assert.deepEqual(await getPin(g, 'corgi'), { count: 0, average: null, reviews: [] });
  assert.deepEqual((await getPin(g, 'corgi', tok)).mine, { rating: 5, text: 'wears it ievery/i day.', status: 'pending' });

  approve(g, 'corgi_uid123');
  g.docs['users/uid456'] = { firstName: { stringValue: 'sam' } };
  await post(g, await sign({ sub: 'uid456' }), { slug: 'corgi', rating: 2, text: 'the pin back came loose.' });
  approve(g, 'corgi_uid456');

  const pin = await getPin(g, 'corgi');
  assert.equal(pin.count, 2);
  assert.equal(pin.average, 3.5); // low ratings count toward the average like any other
  assert.equal(pin.reviews.length, 2);
  assert.ok(pin.reviews.every((x) => !('uid' in x)));
  assert.ok(pin.reviews.some((x) => x.name === 'sam' && x.rating === 2));
  assert.equal((await getPin(g, 'pug')).count, 0);
});

test('the home page gets approved 4 and 5 star reviews that have words', async () => {
  const g = fresh();
  const people = [['u1', 'corgi', 5, 'so much joy.'], ['u2', 'corgi', 4, 'lovely.'], ['u3', 'pug', 5, ''], ['u4', 'pug', 3, 'fine.'], ['u5', 'pug', 5, 'waiting.']];
  for (const [sub, slug, rating, text] of people) {
    g.docs['users/' + sub] = { firstName: { stringValue: sub } };
    await post(g, await sign({ sub }), { slug, rating, text });
  }
  for (const [sub, slug] of people.slice(0, 4)) approve(g, slug + '_' + sub);
  const f = await featured(g);
  assert.deepEqual(f.reviews.map((x) => x.text).sort(), ['lovely.', 'so much joy.']);
  assert.deepEqual(await featured(fresh()), { reviews: [] });
});

test('editing an approved review sends it back for another look', async () => {
  const g = fresh();
  const tok = await sign({});
  await post(g, tok, { slug: 'pug', rating: 4, text: 'good.' });
  approve(g, 'pug_uid123');
  const created = g.docs['reviews/pug_uid123'].createdAt.timestampValue;
  assert.equal((await getPin(g, 'pug')).count, 1);
  await post(g, tok, { slug: 'pug', rating: 5, text: 'better every day.' });
  assert.equal(g.docs['reviews/pug_uid123'].status.stringValue, 'pending');
  assert.equal(g.docs['reviews/pug_uid123'].createdAt.timestampValue, created);
  assert.equal((await getPin(g, 'pug')).count, 0);
});

test('people can delete their own review, and deleting an account removes its reviews', async () => {
  const g = fresh();
  const tok = await sign({});
  await post(g, tok, { slug: 'pug', rating: 5, text: 'a' });
  await post(g, tok, { slug: 'corgi', rating: 5, text: 'b' });
  assert.equal((await reviews(req('DELETE', tok, { query: '?slug=pug' }), env, g.fetchFn)).status, 200);
  assert.equal(g.docs['reviews/pug_uid123'], undefined);
  assert.ok(g.docs['reviews/corgi_uid123']);
  assert.equal((await reviews(req('DELETE', null, { query: '?slug=corgi' }), env, g.fetchFn)).status, 401);

  g.docs['users/uid999'] = { firstName: { stringValue: 'other' } };
  await post(g, await sign({ sub: 'uid999' }), { slug: 'corgi', rating: 4, text: 'stays.' });
  const r = await account(new Request('https://x.test/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }), env, g.fetchFn);
  assert.equal(r.status, 200);
  assert.equal(g.docs['reviews/corgi_uid123'], undefined);
  assert.ok(g.docs['reviews/corgi_uid999'], 'other people keep theirs');
});

test('bad requests are refused calmly', async () => {
  const g = fresh();
  assert.equal((await reviews(req('PUT', null), env, g.fetchFn)).status, 405);
  assert.equal((await reviews(req('GET', null, { query: '?slug=../x' }), env, g.fetchFn)).status, 400);
  assert.equal((await reviews(req('GET', null), env, g.fetchFn)).status, 400);
  assert.equal((await reviews(req('GET', null, { query: '?featured=1' }), {}, g.fetchFn)).status, 503);
});

/* ---------- the admin page ---------- */
const adminReq = (method, token, body) => new Request('https://x.test/api/reviews/admin', {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : undefined
});
const ADMIN = { sub: 'owner1', email: 'ourjkadventures@gmail.com', email_verified: true };

test('only the shop account, with its email confirmed, gets into the admin list', async () => {
  const g = fresh();
  assert.equal((await reviews(adminReq('GET', null), env, g.fetchFn)).status, 401);
  assert.equal((await reviews(adminReq('GET', await sign({})), env, g.fetchFn)).status, 403);
  assert.equal((await reviews(adminReq('GET', await sign({ ...ADMIN, email_verified: false })), env, g.fetchFn)).status, 403);
  assert.equal((await reviews(adminReq('GET', await sign({ ...ADMIN, email: 'OurJKAdventures@Gmail.com ' })), env, g.fetchFn)).status, 200);
  assert.equal((await reviews(adminReq('PATCH', await sign({}), { id: 'corgi_uid123', status: 'approved' }), env, g.fetchFn)).status, 403);
  // a different list in Cloudflare replaces the default
  const other = { ...env, ADMIN_EMAILS: 'helper@example.com, pup@example.com' };
  assert.equal((await reviews(adminReq('GET', await sign({})), other, g.fetchFn)).status, 200);
  assert.equal((await reviews(adminReq('GET', await sign(ADMIN)), other, g.fetchFn)).status, 403);
});

test('the admin sees every review, waiting ones first, and can approve, hide or send back', async () => {
  const g = fresh();
  const tok = await sign({});
  await post(g, tok, { slug: 'corgi', rating: 5, text: 'joy.' });
  await post(g, tok, { slug: 'pug', rating: 2, text: 'loose back.' });
  approve(g, 'pug_uid123');
  const admin = await sign(ADMIN);
  const list = (await (await reviews(adminReq('GET', admin), env, g.fetchFn)).json()).reviews;
  assert.deepEqual(list.map((r) => [r.id, r.status]), [['corgi_uid123', 'pending'], ['pug_uid123', 'approved']]);
  assert.ok(list.every((r) => !('uid' in r)));
  assert.equal(list[0].name, 'juniper h.');

  const r = await reviews(adminReq('PATCH', admin, { id: 'corgi_uid123', status: 'approved' }), env, g.fetchFn);
  assert.deepEqual(await r.json(), { id: 'corgi_uid123', status: 'approved' });
  assert.equal((await getPin(g, 'corgi')).count, 1, 'shows at once on this server');
  await reviews(adminReq('PATCH', admin, { id: 'pug_uid123', status: 'hidden' }), env, g.fetchFn);
  assert.equal((await getPin(g, 'pug')).count, 0);
  await reviews(adminReq('PATCH', admin, { id: 'pug_uid123', status: 'pending' }), env, g.fetchFn);
  assert.equal(g.docs['reviews/pug_uid123'].status.stringValue, 'pending');
  assert.equal(g.docs['reviews/pug_uid123'].text.stringValue, 'loose back.', 'nothing else changes');
});

test('the admin page refuses bad ids, unknown statuses and missing reviews', async () => {
  const g = fresh();
  const admin = await sign(ADMIN);
  for (const id of ['', 'nounderscore', '../users_x', 'corgi_a/b', 7]) {
    assert.equal((await reviews(adminReq('PATCH', admin, { id, status: 'approved' }), env, g.fetchFn)).status, 400, String(id));
  }
  assert.equal((await reviews(adminReq('PATCH', admin, { id: 'corgi_uid123', status: 'deleted' }), env, g.fetchFn)).status, 400);
  assert.equal((await reviews(adminReq('PATCH', admin, { id: 'corgi_nobody', status: 'approved' }), env, g.fetchFn)).status, 404);
  assert.equal((await reviews(adminReq('DELETE', admin), env, g.fetchFn)).status, 405);
});

test('the account page learns whether this is the admin', async () => {
  const g = fresh();
  const hi = async (claims) => (await (await account(new Request('https://x.test/api/account', { method: 'POST', headers: { Authorization: 'Bearer ' + await sign(claims) } }), env, g.fetchFn)).json()).admin;
  assert.equal(await hi({}), false);
  assert.equal(await hi(ADMIN), true);
  assert.equal(await hi({ ...ADMIN, sub: 'owner2', email_verified: false }), false);
});
