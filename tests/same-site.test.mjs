// Tests for "did this come from one of our own pages?": ourjkadventures.com and www.ourjkadventures.com are the same
// shop, anything else isn't. Found 2026-11-09: signing up for "email me when it's here" from a www page was refused.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { fromOurSite } from '../server/same-site.js';
import worker from '../site/_worker.js';

const req = (url, origin) => new Request(url, { method: 'POST', headers: origin ? { Origin: origin } : {} });

test('www and the plain address count as one site, in either direction', () => {
  assert.ok(fromOurSite(req('https://ourjkadventures.com/api/notify', 'https://www.ourjkadventures.com')));
  assert.ok(fromOurSite(req('https://www.ourjkadventures.com/api/notify', 'https://ourjkadventures.com')));
  assert.ok(fromOurSite(req('https://ourjkadventures.com/api/notify', 'https://ourjkadventures.com')));
  assert.ok(fromOurSite(req('https://ourjkadventures.com/api/notify')), 'no Origin at all: a mail app, curl');
});

test('other websites are still turned away', () => {
  for (const o of ['https://evil.example', 'https://ourjkadventures.com.evil.example', 'https://notourjkadventures.com',
    'http://ourjkadventures.com', 'https://ourjkadventures.com:8443', 'null', 'not a url']) {
    assert.equal(fromOurSite(req('https://ourjkadventures.com/api/notify', o)), false, o);
  }
});

test('a page asked for at www moves to the plain address; a POST is let through', async () => {
  const env = { ASSETS: { fetch: async () => new Response('page') } };
  const r = await worker.fetch(new Request('https://www.ourjkadventures.com/pup-club/doodle?x=1'), env);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://ourjkadventures.com/pup-club/doodle?x=1');
  // firebase "set up" enough to reach the door check; email isn't, so it stops just after with its own answer
  const post = await worker.fetch(new Request('https://www.ourjkadventures.com/api/notify', { method: 'POST', headers: { Origin: 'https://www.ourjkadventures.com' } }), { ...env, FIREBASE_SERVICE_ACCOUNT: 'x' });
  assert.deepEqual(await post.json(), { error: 'email not set up' });
});
