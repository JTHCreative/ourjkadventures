// Tests for guest reviews (no account), and guest reviews joining an account once its email is confirmed.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCaches } from '../server/firebase.js';
import { reviews, guestName, GUEST_PER_DAY, _resetReviewCache } from '../server/reviews.js';
import { account } from '../server/account.js';
import { pendingReviews, setReviewStatus } from '../server/reviews.js';
import { sign, fakeGoogle, env as baseEnv } from './helpers.mjs';

const catalog = { items: [
  { slug: 'corgi', name: 'corgi', kind: 'pin' },
  { slug: 'pug', name: 'pug', kind: 'pin' }
] };
const env = { ...baseEnv, ASSETS: { fetch: async () => Response.json(catalog) } };
// a pretend internet address book: example.com takes mail, anything else doesn't exist
function world() {
  _resetCaches();
  _resetReviewCache();
  const g = fakeGoogle();
  const fetchFn = async (url, opts) => {
    if (String(url).startsWith('https://cloudflare-dns.com/')) {
      const name = new URL(String(url)).searchParams.get('name');
      return Response.json(name === 'example.com' ? { Status: 0, Answer: [{ type: 15, data: '10 mx.example.com.' }] } : { Status: 3 });
    }
    return g.fetchFn(url, opts);
  };
  return { g, fetchFn };
}
const guest = (w, body, ip = '1.2.3.4') => reviews(new Request('https://x.test/api/reviews', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify(body)
}), env, w.fetchFn);
const pin = async (w, slug) => (await reviews(new Request('https://x.test/api/reviews?slug=' + slug), env, w.fetchFn)).json();
const hello = async (w, claims) => account(new Request('https://x.test/api/account', {
  method: 'POST', headers: { Authorization: 'Bearer ' + (await sign(claims)), 'Content-Type': 'application/json' }, body: '{}'
}), env, w.fetchFn);
const good = { slug: 'corgi', rating: 5, text: 'the ears.', name: 'Juniper  Hsu', email: 'June@Example.com' };

test('a guest name becomes first name and last initial, as typed, like an account', () => {
  assert.equal(guestName('juniper hsu'), 'juniper h.');
  assert.equal(guestName('  June '), 'June');
  assert.equal(guestName('<b>'), 'b');
  assert.equal(guestName(''), 'a collector');
});

test('a guest review waits for the owner, then shows with the short name and never the email', async () => {
  const w = world();
  assert.deepEqual(await (await guest(w, good)).json(), { saved: true, status: 'pending' });
  assert.equal((await pin(w, 'corgi')).count, 0);
  const waiting = await pendingReviews(env, w.fetchFn);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].guest, true);
  assert.ok(await setReviewStatus(env, waiting[0].id, 'approved', 'owner@example.com', w.fetchFn));
  const shown = await pin(w, 'corgi');
  assert.equal(shown.count, 1);
  assert.deepEqual(shown.reviews[0].name, 'Juniper H.');
  assert.ok(!JSON.stringify(shown).includes('example.com'));
  // the email is kept on the server only, for joining an account later
  const stored = Object.entries(w.g.docs).find(([k]) => k.startsWith('reviews/corgi_g'));
  assert.equal(stored[1].email.stringValue, 'june@example.com');
});

test('guest reviews need stars, a pin, a name and an email whose domain takes mail', async () => {
  const w = world();
  const sent = async (b) => { const r = await guest(w, b); return [r.status, (await r.json()).error]; };
  assert.deepEqual(await sent({ ...good, rating: 0 }), [400, 'rating']);
  assert.deepEqual(await sent({ ...good, slug: 'nope' }), [400, 'slug']);
  assert.deepEqual(await sent({ ...good, name: '  ' }), [400, 'name']);
  assert.deepEqual(await sent({ ...good, email: 'june@' }), [400, 'email']);
  assert.deepEqual(await sent({ ...good, email: 'june@gmial-typo.test' }), [200, 'domain']);
  assert.equal(Object.keys(w.g.docs).filter((k) => k.startsWith('reviews/')).length, 0);
});

test('one guest review per email per pin, and at most GUEST_PER_DAY a day from one connection', async () => {
  const w = world();
  await guest(w, good);
  assert.deepEqual(await (await guest(w, { ...good, email: 'june@example.com', text: 'again' })).json(), { error: 'already' });
  assert.equal((await guest(w, { ...good, slug: 'pug' })).status, 200); // another pin is fine
  for (let i = 2; i < GUEST_PER_DAY; i++) assert.equal((await guest(w, { ...good, email: 'p' + i + '@example.com' })).status, 200);
  assert.equal((await guest(w, { ...good, email: 'more@example.com' })).status, 429);
  assert.equal((await guest(w, { ...good, email: 'more@example.com' }, '5.6.7.8')).status, 200);
});

test('signing in with that email, confirmed, brings the guest reviews into the account', async () => {
  const w = world();
  await guest(w, good);
  await guest(w, { ...good, slug: 'pug', rating: 4 });
  // not confirmed yet: nothing moves
  await hello(w, { sub: 'uidJune', email: 'june@example.com', email_verified: false });
  assert.equal(Object.keys(w.g.docs).filter((k) => /^reviews\/[a-z-]+_g/.test(k)).length, 2);
  // confirmed: both are now hers, as if written signed in, still waiting for the owner
  await hello(w, { sub: 'uidJune', email: 'june@example.com', email_verified: true });
  assert.equal(Object.keys(w.g.docs).filter((k) => /^reviews\/[a-z-]+_g/.test(k)).length, 0);
  assert.equal(w.g.docs['reviews/corgi_uidJune'].uid.stringValue, 'uidJune');
  assert.equal(w.g.docs['reviews/corgi_uidJune'].status.stringValue, 'pending');
  assert.equal(w.g.docs['reviews/pug_uidJune'].rating.integerValue, '4');
  // and she can now see and change them on the pin page
  const mine = await (await reviews(new Request('https://x.test/api/reviews?slug=corgi', {
    headers: { Authorization: 'Bearer ' + (await sign({ sub: 'uidJune', email: 'june@example.com' })) }
  }), env, w.fetchFn)).json();
  assert.equal(mine.mine.text, 'the ears.');
});

test('someone else\'s confirmed account does not get the guest reviews', async () => {
  const w = world();
  await guest(w, good);
  await hello(w, { sub: 'uidOther', email: 'other@example.com', email_verified: true });
  assert.equal(Object.keys(w.g.docs).filter((k) => k.startsWith('reviews/corgi_g')).length, 1);
  assert.ok(!w.g.docs['reviews/corgi_uidOther']);
});

test('an account review of the same pin stays; the guest copy is dropped', async () => {
  const w = world();
  await guest(w, good);
  w.g.docs['reviews/corgi_uidJune'] = { slug: { stringValue: 'corgi' }, uid: { stringValue: 'uidJune' }, rating: { integerValue: '3' }, status: { stringValue: 'approved' } };
  await hello(w, { sub: 'uidJune', email: 'june@example.com', email_verified: true });
  assert.equal(w.g.docs['reviews/corgi_uidJune'].rating.integerValue, '3');
  assert.equal(Object.keys(w.g.docs).filter((k) => k.startsWith('reviews/corgi_g')).length, 0);
});
