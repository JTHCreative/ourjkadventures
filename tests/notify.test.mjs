// Tests for "email me when it's here": sign-up (with the domain check), the stop link, and the owner's send button.
// Resend is faked: nothing leaves the machine. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { SIGNUPS_PER_DAY, cleanEmail, domainTakesMail } from '../server/notify.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const OWNER = 'owner@example.com';
// a pretend internet address book: which domains take mail
const DNS_ZONES = {
  'example.com': { mx: ['10 mail.example.com.'] },
  'only-address.test': { a: true },           // no mail servers listed, but the domain has an address: mail still works
  'no-mail.test': { mx: ['0 .'] },            // says outright it takes no mail
  'parked.test': {}                            // exists, but no mail servers and no address
};

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
  let dnsCalls = 0;
  const fetchFn = async (url, opts = {}) => {
    if (String(url).startsWith('https://cloudflare-dns.com/dns-query')) {
      dnsCalls++;
      const q = new URL(String(url)).searchParams;
      const name = q.get('name');
      const type = q.get('type');
      if (name === 'dns-down.test') return new Response('busy', { status: 502 });
      const zone = DNS_ZONES[name];
      if (!zone) return Response.json({ Status: 3 });
      if (type === 'MX') return Response.json({ Status: 0, Answer: (zone.mx || []).map((d) => ({ type: 15, data: d })) });
      return Response.json({ Status: 0, Answer: zone.a ? [{ type: 1, data: '192.0.2.1' }] : [] });
    }
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
  // the site's files: products.json, and an email picture for every product except the doodle
  const ASSETS = { fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/assets/img/email/')) return new Response(path.endsWith('/doodle.png') ? 'no' : 'png', { status: path.endsWith('/doodle.png') ? 404 : 200 });
    return Response.json(products);
  } };
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS };
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
  return { ...w, env, call, sent, resendCalls, dns: () => dnsCalls };
}
const signUp = async (s, slug, email, opts = {}) => (await s.call('POST', '/api/notify', { body: { slug, email }, ...opts })).json();
const codeIn = (text, kind) => new RegExp('email\\.html\\?' + kind + '=([^\\s]+)').exec(text)[1];
const waiting = async (s) => (await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json()).products.map((p) => [p.slug, p.waiting]);
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

test('signing up puts the address on the list at once, and sends nothing', async () => {
  const s = setup();
  assert.deepEqual(await signUp(s, 'corgi', 'Pup@Example.com'), { status: 'added' });
  assert.equal(s.sent.length, 0);
  assert.deepEqual(await waiting(s), [['corgi', 1]]);
  // the same address again: already there, still one on the list
  assert.deepEqual(await signUp(s, 'corgi', 'pup@example.com'), { status: 'already' });
  assert.deepEqual(await waiting(s), [['corgi', 1]]);
  assert.equal((await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json()).sentToday, 0);
});

test('the part after the @ has to be a real domain that takes mail', async () => {
  const s = setup();
  assert.deepEqual(await signUp(s, 'corgi', 'pup@gmial-typo.test'), { error: 'domain' });
  assert.deepEqual(await signUp(s, 'corgi', 'pup@no-mail.test'), { error: 'domain' });
  assert.deepEqual(await signUp(s, 'corgi', 'pup@parked.test'), { error: 'domain' });
  assert.deepEqual(await signUp(s, 'corgi', 'pup@only-address.test'), { status: 'added' });
  // if the address book can't be asked just now, nobody is turned away
  assert.deepEqual(await signUp(s, 'corgi', 'pup@dns-down.test'), { status: 'added' });
  assert.deepEqual(await waiting(s), [['corgi', 2]]);
});

test('domainTakesMail answers true, false, or null when it cannot tell', async () => {
  const s = setup();
  assert.equal(await domainTakesMail('example.com', globalThis.fetch), true);
  assert.equal(await domainTakesMail('nowhere.test', globalThis.fetch), false);
  assert.equal(await domainTakesMail('dns-down.test', globalThis.fetch), null);
  assert.ok(s.dns() >= 3);
});

test('the old confirm link is gone', async () => {
  const s = setup();
  assert.equal((await s.call('POST', '/api/notify/confirm', { body: { code: 'x' } })).status, 404);
});

test('one connection can sign up at most SIGNUPS_PER_DAY addresses a day', async () => {
  const s = setup();
  for (let i = 0; i < SIGNUPS_PER_DAY; i++) assert.equal((await signUp(s, 'corgi', 'p' + i + '@example.com')).status, 'added');
  assert.deepEqual(await signUp(s, 'corgi', 'more@example.com'), { status: 'limit' });
  assert.equal((await signUp(s, 'corgi', 'more@example.com', { ip: '5.6.7.8' })).status, 'added');
});

async function onList(s, emails, slug = 'corgi') {
  for (const [i, e] of emails.entries()) await signUp(s, slug, e, { ip: '10.0.0.' + i });
}

test('the owner sends "it\'s here" once the pin is back: everyone waiting, once each, with a stop link', async () => {
  const s = setup();
  await onList(s, ['a@example.com', 'b@example.com']);

  // still not available, or the shop is closed: refused, nothing sent
  assert.equal((await pressSend(s, 'corgi')).status, 400);
  await flip(s, 'corgi', true);
  s.g.docs['settings/shop'] = { open: { booleanValue: false } };
  assert.deepEqual(await (await pressSend(s, 'corgi')).json(), { error: 'shop closed' });
  s.g.docs['settings/shop'] = { open: { booleanValue: true } };
  assert.equal(s.sent.length, 0);

  const res = await (await pressSend(s, 'corgi')).json();
  assert.equal(res.sent, 2);
  assert.equal(res.left, 0);
  const batch = s.resendCalls[s.resendCalls.length - 1];
  assert.ok(batch.url.endsWith('/emails/batch'));
  assert.match(batch.headers['Idempotency-Key'], /^its-here-corgi-/);
  assert.deepEqual(s.sent.map((m) => m.to[0]).sort(), ['a@example.com', 'b@example.com']);
  for (const m of s.sent) {
    assert.equal(m.subject, 'the corgi pin is here!');
    assert.equal(m.reply_to, 'support@ourjkadventures.com');
    assert.ok(m.text.includes('https://x.test/pup-club/corgi'));
    assert.ok(m.text.includes("didn't ask, or want no more of these?"));
    assert.equal(m.text, m.text.toLowerCase());
    // the designed version: logo, the pin's picture, a button to it, and the stop link
    assert.ok(m.html.includes('<img src="https://x.test/assets/img/email/logo.png"'));
    assert.ok(m.html.includes('<img src="https://x.test/assets/img/email/corgi.png"'));
    assert.ok(m.html.includes('alt="the corgi pin"'));
    assert.ok(m.html.includes('href="https://x.test/pup-club/corgi"'));
    assert.ok(m.html.includes('>go see the corgi</a>'));
    assert.match(m.html, /href="https:\/\/x\.test\/email\.html\?stop=[0-9a-f]{32}\.[0-9a-f]{32}"/);
    assert.ok(!m.html.includes('<script'));
    assert.match(m.headers['List-Unsubscribe'], /^<https:\/\/x\.test\/api\/notify\/stop\?code=[0-9a-f]{32}\.[0-9a-f]{32}>/);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  }
  // sent slips are thrown away: pressing again sends nothing more
  assert.equal((await (await pressSend(s, 'corgi')).json()).sent, 0);
  assert.equal(s.sent.length, 2);
  assert.deepEqual(await waiting(s), []);
});

test('a big list goes out over more than one day', async () => {
  const s = setup({ limit: 2 });
  await onList(s, ['a@example.com', 'b@example.com', 'c@example.com']);
  await flip(s, 'corgi', true);
  assert.deepEqual(await (await pressSend(s, 'corgi')).json().then((r) => [r.sent, r.left]), [2, 1]);
  assert.deepEqual(await (await pressSend(s, 'corgi')).json().then((r) => [r.sent, r.left, r.full]), [0, 1, true]);
});

test('the stop link takes an address off every list, from the page or a mail app\'s one-click button', async () => {
  const s = setup({ unavailable: ['corgi', 'doodle'] });
  await signUp(s, 'corgi', 'pup@example.com');
  await signUp(s, 'doodle', 'pup@example.com');
  await signUp(s, 'doodle', 'other@example.com');
  await flip(s, 'corgi', true);
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

test('a product without an email picture still gets its email, just without the picture', async () => {
  const s = setup({ unavailable: ['doodle'] });
  await signUp(s, 'doodle', 'pup@example.com');
  await flip(s, 'doodle', true);
  assert.equal((await (await pressSend(s, 'doodle')).json()).sent, 1);
  const m = s.sent[0];
  assert.equal(m.subject, 'the doodle pin is here!');
  assert.ok(m.html.includes('email/logo.png'));
  assert.ok(!m.html.includes('email/doodle.png'));
});

test('the owner\'s preview is the real email, with a goldie by that name', async () => {
  const s = setup({ unavailable: ['golden'] });
  await signUp(s, 'golden', 'pup@example.com');
  const r = (await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json()).products[0];
  assert.equal(r.preview.subject, 'the goldie pin is here!');
  assert.ok(r.preview.html.includes('>go see the goldie</a>'));
  assert.ok(r.preview.html.includes('email/golden.png'));
});

test('every product has an email picture, and there is a logo', () => {
  for (const p of products.items) assert.ok(fs.existsSync(new URL('../site/assets/img/email/' + p.slug + '.png', import.meta.url)), p.slug);
  assert.ok(fs.existsSync(new URL('../site/assets/img/email/logo.png', import.meta.url)));
});

test('only the owner sees or sends', async () => {
  const s = setup();
  const pup = await sign({ email: 'pup@example.com' });
  assert.equal((await s.call('GET', '/api/admin/notify', { token: pup })).status, 403);
  assert.equal((await s.call('POST', '/api/admin/notify', { token: pup, body: { slug: 'corgi' } })).status, 403);
  assert.equal((await s.call('GET', '/api/admin/notify')).status, 401);
});

test('the pin board gets "email me when it\'s here" too, sent from /admin like a pin', async () => {
  const slug = 'bay-area-pin-board';
  const s = setup({ unavailable: [slug] });
  assert.equal((await signUp(s, slug, 'a@example.com')).status, 'added');
  assert.deepEqual(await waiting(s), [[slug, 1]]);
  await flip(s, slug, true);
  assert.equal((await (await pressSend(s, slug)).json()).sent, 1);
  const m = s.sent[0];
  assert.equal(m.subject, 'the bay area pin board is here!');
  assert.ok(m.html.includes('<img src="https://x.test/assets/img/email/bay-area-pin-board.png"'));
  assert.ok(m.html.includes('href="https://x.test/bay-area-pin-board"'));
  assert.deepEqual(await waiting(s), []);
});

test('the owner sees each address on a list, oldest first; no one else does', async () => {
  const s = setup();
  await signUp(s, 'corgi', 'First@Example.com');
  await new Promise((r) => setTimeout(r, 5));
  await signUp(s, 'corgi', 'second@example.com', { ip: '9.9.9.9' });
  const row = (await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json()).products[0];
  assert.deepEqual(row.people.map((p) => p.email), ['first@example.com', 'second@example.com']);
  assert.ok(row.people.every((p) => !isNaN(new Date(p.at))));
  assert.equal((await s.call('GET', '/api/admin/notify', { token: await sign({ email: 'pup@example.com' }) })).status, 403);
  // the public catalog never carries them
  assert.ok(!JSON.stringify(await (await s.call('GET', '/api/catalog')).json()).includes('example.com'));
});

test('the owner can take an address off a list by hand, and undo puts it back with its sign-up day', async () => {
  const s = setup();
  assert.equal((await signUp(s, 'corgi', 'test@example.com')).status, 'added');
  assert.equal((await signUp(s, 'corgi', 'keep@example.com')).status, 'added');
  const before = (await (await s.call('GET', '/api/admin/notify', { token: await owner() })).json()).products[0].people;
  const at = before.find((p) => p.email === 'test@example.com').at;

  const r = await s.call('DELETE', '/api/admin/notify/person', { token: await owner(), body: { slug: 'corgi', email: 'Test@Example.com' } });
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.deepEqual(res.removed, { slug: 'corgi', email: 'test@example.com', at });
  assert.deepEqual(res.products[0].people.map((p) => p.email), ['keep@example.com']);
  // gone means gone: removing again says so
  assert.equal((await s.call('DELETE', '/api/admin/notify/person', { token: await owner(), body: { slug: 'corgi', email: 'test@example.com' } })).status, 404);

  // undo: back on the list, with the day they first signed up
  const u = await (await s.call('PUT', '/api/admin/notify/person', { token: await owner(), body: { slug: 'corgi', email: 'test@example.com', at } })).json();
  assert.equal(u.restored, true);
  const back = u.products[0].people.find((p) => p.email === 'test@example.com');
  assert.equal(back.at, at);
  assert.deepEqual(await waiting(s), [['corgi', 2]]);
  // and signing up again still says "already": it's the same slip as before
  assert.equal((await signUp(s, 'corgi', 'test@example.com')).status, 'already');
});

test('only the owner can remove or put back an address, and only on a real product', async () => {
  const s = setup();
  await signUp(s, 'corgi', 'test@example.com');
  const stranger = await sign({ email: 'someone@example.com' });
  assert.equal((await s.call('DELETE', '/api/admin/notify/person', { token: stranger, body: { slug: 'corgi', email: 'test@example.com' } })).status, 403);
  assert.equal((await s.call('PUT', '/api/admin/notify/person', { token: stranger, body: { slug: 'corgi', email: 'x@example.com' } })).status, 403);
  assert.equal((await s.call('DELETE', '/api/admin/notify/person', { body: { slug: 'corgi', email: 'test@example.com' } })).status, 401);
  assert.equal((await s.call('PUT', '/api/admin/notify/person', { token: await owner(), body: { slug: 'nope', email: 'x@example.com' } })).status, 400);
  assert.equal((await s.call('PUT', '/api/admin/notify/person', { token: await owner(), body: { slug: 'corgi', email: 'not an email' } })).status, 400);
  assert.deepEqual(await waiting(s), [['corgi', 1]]);
});

test('sending "it\'s here" to everyone ends that pin\'s round of "i\'m interested": it starts fresh', async () => {
  const s = setup();
  const vote = (cookie, ip) => s.call('POST', '/api/interest', { body: { slug: 'corgi' }, ip }).then(async (r) => ({ r, cookie }));
  await vote(null, '1.1.1.1');
  await vote(null, '2.2.2.2');
  await signUp(s, 'corgi', 'pup@example.com');
  const catalog = async () => (await (await s.call('GET', '/api/catalog')).json()).items.find((p) => p.slug === 'corgi');
  assert.equal((await catalog()).interest, 2);
  assert.equal((await catalog()).interest_round, 0);

  await flip(s, 'corgi', true);
  const sent = await (await s.call('POST', '/api/admin/notify', { token: await owner(), body: { slug: 'corgi' } })).json();
  assert.equal(sent.sent, 1);
  assert.equal(sent.left, 0);

  // the tally is wiped, every vote cleared, and the round moves on; /admin keeps how many asked
  assert.equal(s.g.docs['interest_sandbox/corgi'].count.integerValue, '0');
  assert.equal(Object.keys(s.g.docs).filter((k) => k.startsWith('interest_votes_sandbox/')).length, 0);
  const products = await (await s.call('GET', '/api/admin/products', { token: await owner() })).json();
  assert.deepEqual(products.asked, { corgi: 2 });
  assert.equal(products.interest.corgi, undefined);

  // switched off again later: no one is interested yet, the round number tells browsers to forget old taps,
  // and a new tap counts (the same browser's old vote is gone on the server too)
  await flip(s, 'corgi', false);
  const fresh = await catalog();
  assert.equal(fresh.interest, 0);
  assert.equal(fresh.interest_round, 1);
  const again = await (await s.call('POST', '/api/interest', { body: { slug: 'corgi' }, ip: '1.1.1.1' })).json();
  assert.equal(again.counted, true);
  assert.equal(again.count, 1);
});

test('a send that leaves people waiting (the day\'s emails ran out) keeps the round open', async () => {
  const s = setup({ limit: 1 });
  await s.call('POST', '/api/interest', { body: { slug: 'corgi' } });
  await signUp(s, 'corgi', 'a@example.com');
  await signUp(s, 'corgi', 'b@example.com', { ip: '9.9.9.9' });
  await flip(s, 'corgi', true);
  const sent = await (await s.call('POST', '/api/admin/notify', { token: await owner(), body: { slug: 'corgi' } })).json();
  assert.equal(sent.left, 1);
  assert.equal(s.g.docs['interest_sandbox/corgi'].count.integerValue, '1');
});
