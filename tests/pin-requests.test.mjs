// Tests for pin requests ("don't see your pup in the pack?"): what the page may send, the daily limit, the hidden
// robot box, the owner's alert, and the list on /admin. Resend and DNS are faked. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { REQUESTS_PER_DAY, MAX_ABOUT, cleanRequest } from '../server/pin-requests.js';
import { PIN_REQUEST_ALERTS_PER_DAY } from '../server/owner-alerts.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const DNS_ZONES = { 'example.com': ['10 mail.example.com.'], 'no-mail.test': ['0 .'] };

function setup({ resend = true } = {}) {
  _resetCaches();
  const w = fakeWorld();
  const sent = [];
  const fetchFn = async (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://cloudflare-dns.com/dns-query')) {
      const q = new URL(u).searchParams;
      const zone = DNS_ZONES[q.get('name')];
      if (!zone) return Response.json({ Status: 3 });
      return Response.json({ Status: 0, Answer: q.get('type') === 'MX' ? zone.map((d) => ({ type: 15, data: d })) : [] });
    }
    if (u.startsWith('https://api.resend.com/')) {
      const list = u.endsWith('/batch') ? JSON.parse(opts.body) : [JSON.parse(opts.body)];
      sent.push(...list);
      return Response.json(u.endsWith('/batch') ? { data: list.map((_, i) => ({ id: 'e' + i })) } : { id: 'e1' });
    }
    return w.fetchFn(url, opts);
  };
  globalThis.fetch = fetchFn;
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  if (resend) env.RESEND_API_KEY = 're_test';
  const call = async (method, path, { token, body, ip = '1.2.3.4', origin } = {}) => {
    const headers = { 'CF-Connecting-IP': ip };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (origin) headers.Origin = origin;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return worker.fetch(new Request('https://x.test' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env);
  };
  return { ...w, env, call, sent };
}
const owner = () => sign({ email: OWNER });
const ask = async (s, body, opts = {}) => (await s.call('POST', '/api/pin-request', { body, ...opts })).json();
const ownerList = async (s) => (await (await s.call('GET', '/api/admin/pin-requests', { token: await owner() })).json()).requests;
const BERNESE = { set: 'pup-club', about: 'a bernese mountain dog!\n\n\n\nblack, white and rust.', name: '  Juniper  H. ', email: 'Pup@Example.com' };

test('a request is tidied and checked before it is kept', () => {
  assert.deepEqual(cleanRequest(BERNESE).value, { set: 'pup-club', about: 'a bernese mountain dog!\n\nblack, white and rust.', name: 'Juniper H.', email: 'pup@example.com' });
  // name and email are optional
  assert.deepEqual(cleanRequest({ set: 'zodiac', about: 'the rabbit' }).value, { set: 'zodiac', about: 'the rabbit', name: '', email: '' });
  assert.equal(cleanRequest({ ...BERNESE, set: 'boards' }).error, 'set');
  assert.equal(cleanRequest({ ...BERNESE, set: 'toString' }).error, 'set');
  assert.equal(cleanRequest({ ...BERNESE, about: '   ' }).error, 'about');
  assert.equal(cleanRequest({ ...BERNESE, about: 'x'.repeat(MAX_ABOUT + 1) }).error, 'about');
  assert.equal(cleanRequest({ ...BERNESE, name: 'x'.repeat(61) }).error, 'name');
  assert.equal(cleanRequest({ ...BERNESE, email: 'pup@' }).error, 'email');
});

test('a request is kept, the owner gets one alert, and it shows on /admin', async () => {
  const s = setup();
  assert.deepEqual(await ask(s, BERNESE), { status: 'added' });
  const rows = await ownerList(s);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].setName, 'pup club');
  assert.equal(rows[0].name, 'Juniper H.');
  assert.equal(rows[0].email, 'pup@example.com');
  assert.match(rows[0].about, /bernese/);
  // only the owner hears about it: nothing goes to the person who asked
  assert.equal(s.sent.length, 1);
  assert.deepEqual(s.sent[0].to, [OWNER]);
  assert.equal(s.sent[0].subject, 'a pin request: pup club');
  assert.match(s.sent[0].text, /bernese/);
  assert.match(s.sent[0].html, /mailto:pup@example\.com/);
});

test('the words are escaped in the owner email', async () => {
  const s = setup();
  await ask(s, { set: 'hometown', about: '<b>oakland</b>' });
  assert.ok(!s.sent[0].html.includes('<b>oakland'));
  assert.ok(s.sent[0].html.includes('&lt;b&gt;oakland'));
});

test('without email set up, the request is still kept', async () => {
  const s = setup({ resend: false });
  assert.deepEqual(await ask(s, BERNESE), { status: 'added' });
  assert.equal((await ownerList(s)).length, 1);
  assert.equal(s.sent.length, 0);
});

test('bad requests are turned away, and nothing is kept', async () => {
  const s = setup();
  assert.deepEqual(await ask(s, { ...BERNESE, set: 'nope' }), { error: 'set' });
  assert.deepEqual(await ask(s, { ...BERNESE, about: '' }), { error: 'about' });
  assert.deepEqual(await ask(s, { ...BERNESE, email: 'pup@no-mail.test' }), { error: 'domain' });
  assert.deepEqual(await ask(s, { ...BERNESE, email: 'pup@made-up.test' }), { error: 'domain' });
  assert.equal((await s.call('GET', '/api/pin-request')).status, 405);
  // from another website: no
  assert.equal((await s.call('POST', '/api/pin-request', { body: BERNESE, origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await ownerList(s)).length, 0);
});

test('a robot that fills in the hidden box is thanked and dropped', async () => {
  const s = setup();
  assert.deepEqual(await ask(s, { ...BERNESE, website: 'http://spam.test' }), { status: 'added' });
  assert.equal((await ownerList(s)).length, 0);
  assert.equal(s.sent.length, 0);
});

test('one connection can send at most REQUESTS_PER_DAY a day', async () => {
  const s = setup();
  for (let i = 0; i < REQUESTS_PER_DAY; i++) assert.equal((await ask(s, { set: 'zodiac', about: 'the ox ' + i })).status, 'added');
  assert.deepEqual(await ask(s, { set: 'zodiac', about: 'one more' }), { status: 'limit' });
  // another connection is fine
  assert.equal((await ask(s, { set: 'zodiac', about: 'the tiger' }, { ip: '5.6.7.8' })).status, 'added');
  assert.equal((await ownerList(s)).length, REQUESTS_PER_DAY + 1);
});

test('owner alerts stop at PIN_REQUEST_ALERTS_PER_DAY, the requests keep coming in', async () => {
  const s = setup();
  const n = PIN_REQUEST_ALERTS_PER_DAY + 2;
  for (let i = 0; i < n; i++) await ask(s, { set: 'pup-club', about: 'pup ' + i }, { ip: '10.0.0.' + i });
  assert.equal(s.sent.length, PIN_REQUEST_ALERTS_PER_DAY);
  assert.equal((await ownerList(s)).length, n);
});

test('only the owner sees and removes requests', async () => {
  const s = setup();
  await ask(s, BERNESE);
  assert.equal((await s.call('GET', '/api/admin/pin-requests')).status, 401);
  assert.equal((await s.call('GET', '/api/admin/pin-requests', { token: await sign({ email: 'someone@example.com' }) })).status, 403);
  const [r] = await ownerList(s);
  assert.equal((await s.call('DELETE', '/api/admin/pin-requests', { token: await sign({ email: 'someone@example.com' }), body: { id: r.id } })).status, 403);
  assert.equal((await s.call('DELETE', '/api/admin/pin-requests', { token: await owner(), body: { id: 'x' } })).status, 400);
  assert.equal((await s.call('DELETE', '/api/admin/pin-requests', { token: await owner(), body: { id: 'f'.repeat(32) } })).status, 404);
  const res = await s.call('DELETE', '/api/admin/pin-requests', { token: await owner(), body: { id: r.id } });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).requests, []);
});

test('the pup club board has its "request a breed" link, and the page sends what the server expects', () => {
  const board = fs.readFileSync(new URL('../site/pup-club.html', import.meta.url), 'utf8');
  assert.match(board, /<div class="card clean pup-request" data-pin-request>[\s\S]*href="\/pin-request\?set=pup-club"/);
  const page = fs.readFileSync(new URL('../site/pin-request.html', import.meta.url), 'utf8');
  const sets = [...page.matchAll(/<option value="([a-z-]+)">/g)].map((m) => m[1]);
  assert.deepEqual(sets, ['pup-club', 'hometown', 'zodiac']);
  for (const s of sets) assert.ok(cleanRequest({ set: s, about: 'hi' }).value, s);
});
