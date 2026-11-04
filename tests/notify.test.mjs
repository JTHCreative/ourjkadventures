// Tests for "email me when it's here": sign-up, the confirm link, the stop link, and the owner's send button.
// Resend is faked: nothing leaves the machine. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { SIGNUPS_PER_DAY, cleanEmail } from '../server/notify.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const OWNER = 'owner@example.com';

function setup({ open = true, unavailable = ['corgi'], resend = true, limit } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: open } };
  w.g.docs['settings/available_sandbox'] = Object.fromEntries(unavailable.map((s) => [s, { booleanValue: false }]));
  // a pretend Resend: remembers every email, single or batch
  const sent = [];
  const resendCalls = [];
  const fetchFn = async (url, opts = {}) => {
    if (String(url).startsWith('https://api.resend.com/')) {
      resendCalls.push({ url: String(url), headers: opts.headers, body: JSON.parse(opts.body) });
      if (opts.headers.Authorization !== 'Bearer re_test') return new Response('{"name":"validation_error"}', { status: 401 });
      const list = String(url).endsWith('/batch') ? JSON.parse(opts.body) : [JSON.parse(opts.body)];
      sent.push(...list);
      return Response.json(String(url).endsWith('/batch') ? { data: list.map((_, i) => ({ id: 'e' + i })) } : { id: 'e1' });
    }
    return w.fetchFn(url, opts);
  };
  globalThis.fetch = fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) } };
  if (resend) env.RESEND_API_KEY = 're_test';
  if (limit) env.EMAIL_DAILY_LIMIT = String(limit);
  const call = async (method, path, { token, body, ip = '1.2.3.4', origin, form } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (origin) headers.Origin = origin;
    let payload;
    if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = form; }
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: payload }), env);
  };
  return { ...w, env, call, sent, resendCalls };
}
const signUp = async (s, slug, email, opts = {}) => (await s.call('POST', '/api/notify', { body: { slug, email }, ...opts })).json();
const codeIn = (text, kind) => new RegExp('email\\.html\\?' + kind + '=([^\\s]+)').exec(text)[1];
const owner = () => sign({ email: OWNER });
const flip = async (s, slug, available) => s.call('POST', '/api/admin/availability', { token: await owner(), body: { slug, available } });
const pressSend = async (s, slug) => s.call('POST', '/api/admin/notify', { token: await owner(), body: { slug } });

test('email addresses are tidied and checked', () => {
  assert.equal(cleanEmail('  Pup@Example.COM '), 'pup@example.com');
  for (const bad of ['', 'pup', 'pup@', '@x.com', 'a b@x.com', 'pup@x', '<pup@x.com>', 'x'.repeat(250) + '@x.com', 42]) assert.equal(cleanEmail(bad), null, String(bad));
});

test('the catalog says whether email is offered', async () => {
  assert.equal((await (await setup().call('GET', '/api/catalog')).json()).email, true);
  assert.equal((await (await setup({ resend: false }).call('GET', '/api/catalog')).json()).email, false);
});

test('signing up sends one "is this you?" email; the address is not on the list until it is confirmed', async () => {
  const s = setup();
  assert.deepEqual(await signUp(s, 'corgi', 'Pup@Example.com'), { status: 'sent' });
  assert.equal(s.sent.length, 1);
  const m = s.sent[0];
  assert.deepEqual(m.to, ['pup@example.com']);
  assert.equal(m.subject, 'is this you? the corgi pin.');
  assert.equal(m.reply_to, 'support@ourjkadventures.com');
  assert.match(m.from, /j\+k adventures/);
  assert.ok(m.html.includes('<a href="https://x.test/email.html?confirm='));
  assert.equal(m.text, m.text.toLowerCase());
  assert.ok(!/!/.test(m.text + m.subject));

  // asking again straight away doesn't send a second email
  assert.deepEqual(await signUp(s, 'corgi', 'pup@example.com'), { status: 'sent' });
  assert.equal(s.sent.length, 1);

  let summary = await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json();
  assert.deepEqual(summary.products.map((p) => [p.slug, p.confirmed, p.pending]), [['corgi', 0, 1]]);
  assert.equal(summary.sentToday, 1);

  const res = await (await s.call('POST', '/api/notify/confirm', { body: { code: codeIn(m.text, 'confirm') } })).json();
  assert.deepEqual(res, { confirmed: true, name: 'corgi pin' });
  summary = await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json();
  assert.deepEqual(summary.products.map((p) => [p.slug, p.confirmed, p.pending]), [['corgi', 1, 0]]);
  assert.deepEqual(await signUp(s, 'corgi', 'pup@example.com'), { status: 'already' });
});

test('a wrong or made-up confirm code confirms nothing', async () => {
  const s = setup();
  await signUp(s, 'corgi', 'pup@example.com');
  const code = codeIn(s.sent[0].text, 'confirm');
  const wrong = code.slice(0, -1) + (code.endsWith('0') ? '1' : '0');
  assert.equal((await s.call('POST', '/api/notify/confirm', { body: { code: wrong } })).status, 404);
  assert.equal((await s.call('POST', '/api/notify/confirm', { body: { code: 'nope' } })).status, 400);
});

test('sign-ups are refused for bad input, products in the shop, other websites, and when email is not set up', async () => {
  const s = setup();
  assert.equal((await s.call('POST', '/api/notify', { body: { slug: 'corgi', email: 'nope' } })).status, 400);
  assert.equal((await s.call('POST', '/api/notify', { body: { slug: 'not-a-pin', email: 'a@b.co' } })).status, 400);
  assert.equal((await s.call('POST', '/api/notify', { body: { slug: 'aussie', email: 'a@b.co' } })).status, 409);
  assert.equal((await s.call('POST', '/api/notify', { body: { slug: 'corgi', email: 'a@b.co' }, origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await setup({ resend: false }).call('POST', '/api/notify', { body: { slug: 'corgi', email: 'a@b.co' } })).status, 503);
  assert.equal(s.sent.length, 0);
});

test('one connection can sign up at most SIGNUPS_PER_DAY addresses a day', async () => {
  const s = setup();
  for (let i = 0; i < SIGNUPS_PER_DAY; i++) assert.equal((await signUp(s, 'corgi', 'p' + i + '@example.com')).status, 'sent');
  assert.deepEqual(await signUp(s, 'corgi', 'more@example.com'), { status: 'limit' });
  assert.equal((await signUp(s, 'corgi', 'more@example.com', { ip: '5.6.7.8' })).status, 'sent');
});

test('the site stops at its own daily limit instead of running into the post office', async () => {
  const s = setup({ limit: 2 });
  assert.equal((await signUp(s, 'corgi', 'a@example.com')).status, 'sent');
  assert.equal((await signUp(s, 'corgi', 'b@example.com', { ip: '2.2.2.2' })).status, 'sent');
  assert.deepEqual(await signUp(s, 'corgi', 'c@example.com', { ip: '3.3.3.3' }), { status: 'busy' });
  assert.equal(s.sent.length, 2);
});

async function confirmed(s, emails) {
  for (const [i, e] of emails.entries()) {
    await signUp(s, 'corgi', e, { ip: '10.0.0.' + i });
    const m = s.sent[s.sent.length - 1];
    await s.call('POST', '/api/notify/confirm', { body: { code: codeIn(m.text, 'confirm') } });
  }
}

test('the owner sends "it\'s here" once the pin is back: confirmed people only, once each, with a stop link', async () => {
  const s = setup();
  await confirmed(s, ['a@example.com', 'b@example.com']);
  await signUp(s, 'corgi', 'never-confirmed@example.com', { ip: '9.9.9.9' });
  const before = s.sent.length;

  // still not available, or the shop is closed: refused, nothing sent
  assert.equal((await pressSend(s, 'corgi')).status, 400);
  await flip(s, 'corgi', true);
  s.g.docs['settings/shop'] = { open: { booleanValue: false } };
  assert.deepEqual(await (await pressSend(s, 'corgi')).json(), { error: 'shop closed' });
  s.g.docs['settings/shop'] = { open: { booleanValue: true } };

  const res = await (await pressSend(s, 'corgi')).json();
  assert.equal(res.sent, 2);
  assert.equal(res.left, 0);
  const batch = s.resendCalls[s.resendCalls.length - 1];
  assert.ok(batch.url.endsWith('/emails/batch'));
  assert.match(batch.headers['Idempotency-Key'], /^its-here-corgi-/);
  const mails = s.sent.slice(before);
  assert.deepEqual(mails.map((m) => m.to[0]).sort(), ['a@example.com', 'b@example.com']);
  for (const m of mails) {
    assert.equal(m.subject, 'the corgi pin is here.');
    assert.ok(m.text.includes('https://x.test/pup-club.html#corgi'));
    assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/x\.test\/api\/notify\/stop\?code=[0-9a-f]{32}\.[0-9a-f]{32}>/);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  }
  // sent slips are thrown away: pressing again sends nothing more. the unconfirmed one stays waiting
  assert.equal((await (await pressSend(s, 'corgi')).json()).sent, 0);
  assert.equal(s.sent.length, before + 2);
  const summary = await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json();
  assert.deepEqual(summary.products.map((p) => [p.slug, p.confirmed, p.pending]), [['corgi', 0, 1]]);
});

test('a big list goes out over more than one day', async () => {
  const s = setup({ limit: 5 });
  await confirmed(s, ['a@example.com', 'b@example.com', 'c@example.com']); // uses 3 of today's 5
  await flip(s, 'corgi', true);
  assert.deepEqual(await (await pressSend(s, 'corgi')).json().then((r) => [r.sent, r.left]), [2, 1]);
  assert.deepEqual(await (await pressSend(s, 'corgi')).json().then((r) => [r.sent, r.left, r.full]), [0, 1, true]);
});

test('the stop link takes an address off every list, from the page or a mail app\'s one-click button', async () => {
  const s = setup({ unavailable: ['corgi', 'poodle'] });
  await signUp(s, 'corgi', 'pup@example.com');
  await signUp(s, 'poodle', 'pup@example.com');
  await signUp(s, 'poodle', 'other@example.com');
  await confirmed(s, []);
  await flip(s, 'corgi', true);
  // confirm corgi, send it, take the stop code from the "it's here" email
  await s.call('POST', '/api/notify/confirm', { body: { code: codeIn(s.sent[0].text, 'confirm') } });
  await pressSend(s, 'corgi');
  const stop = codeIn(s.sent[s.sent.length - 1].text, 'stop');
  assert.equal((await s.call('POST', '/api/notify/stop', { body: { code: stop.slice(0, -1) + 'x' } })).status, 400);
  // one-click from a mail app: a form post, code in the link
  const res = await s.call('POST', '/api/notify/stop?code=' + stop, { form: 'List-Unsubscribe=One-Click' });
  assert.deepEqual(await res.json(), { stopped: true });
  const left = Object.entries(s.g.docs).filter(([k]) => k.startsWith('notify_sandbox/'));
  assert.equal(left.length, 1);
  assert.equal(left[0][1].email.stringValue, 'other@example.com');
});

test('only the owner sees or sends', async () => {
  const s = setup();
  const pup = await sign({ email: 'pup@example.com' });
  assert.equal((await s.call('GET', '/api/admin/notify', { token: pup })).status, 403);
  assert.equal((await s.call('POST', '/api/admin/notify', { token: pup, body: { slug: 'corgi' } })).status, 403);
  assert.equal((await s.call('GET', '/api/admin/notify')).status, 401);
});
