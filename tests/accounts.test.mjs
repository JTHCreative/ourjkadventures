// Tests for sign-in tickets and /api/account, with Google and Firestore faked.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdToken, _resetCaches } from '../server/firebase.js';
import { account, cleanName, cleanPhone, noteOrder } from '../server/account.js';
import { PROJECT, enc, stranger, sign, fakeGoogle, env } from './helpers.mjs';

const req = (method, token, body, path = '/api/account') => new Request('https://x.test' + path, {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : undefined
});

test('a real ticket is accepted', async () => {
  _resetCaches();
  const c = await verifyIdToken(await sign({}), PROJECT, fakeGoogle().fetchFn);
  assert.equal(c.sub, 'uid123');
});

test('forged, expired, wrong project and malformed tickets are refused', async () => {
  const { fetchFn } = fakeGoogle();
  const t = Math.floor(Date.now() / 1000);
  const bad = [
    await sign({}, { key: stranger.privateKey }),
    await sign({ exp: t - 3600 }),
    await sign({ aud: 'someone-else' }),
    await sign({ iss: 'https://securetoken.google.com/someone-else' }),
    await sign({ sub: '' }),
    await sign({ iat: t + 3600 }),
    await sign({}, { kid: 'unknown' }),
    await sign({}, { alg: 'none' }),
    'not.a.token', '', null
  ];
  for (const tok of bad) assert.equal(await verifyIdToken(tok, PROJECT, fetchFn), null, String(tok).slice(0, 40));
  // tampering with the claims breaks the signature
  const good = await sign({});
  const [h, , s] = good.split('.');
  assert.equal(await verifyIdToken(h + '.' + enc({ sub: 'admin', aud: PROJECT }) + '.' + s, PROJECT, fetchFn), null);
});

test('google keys are cached between requests', async () => {
  _resetCaches();
  const g = fakeGoogle();
  await verifyIdToken(await sign({}), PROJECT, g.fetchFn);
  await verifyIdToken(await sign({}), PROJECT, g.fetchFn);
  assert.equal(g.calls.filter((c) => c.includes('securetoken')).length, 1);
});

test('first sign-in creates the folder; the second returns it unchanged', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const tok = await sign({});
  const r1 = await account(req('POST', tok, { firstName: '  juniper  ' }), env, g.fetchFn);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.firstName, 'juniper');
  assert.equal(j1.email, 'pup@example.com');
  assert.equal(j1.charges, 0);
  assert.deepEqual(g.docs['users/uid123'].charges, { integerValue: '0' });

  const r2 = await account(req('POST', tok, { firstName: 'someone else' }), env, g.fetchFn);
  assert.equal((await r2.json()).firstName, 'juniper');
});

test('google sign-ups take first and last name from the ticket', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const r = await account(req('POST', await sign({ name: 'Kai Lee Park' })), env, g.fetchFn);
  const j = await r.json();
  assert.equal(j.firstName, 'Kai');
  assert.equal(j.lastName, 'Lee Park');
});

test('older folders with only displayName still show a first name', async () => {
  _resetCaches();
  const g = fakeGoogle();
  g.docs['users/uid123'] = { email: { stringValue: 'pup@example.com' }, displayName: { stringValue: 'Juniper' } };
  assert.equal((await (await account(req('POST', await sign({})), env, g.fetchFn)).json()).firstName, 'Juniper');
});

test('details can be changed; a bad phone is refused; charges cannot be', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const tok = await sign({});
  await account(req('POST', tok, { firstName: 'kai' }), env, g.fetchFn);
  const r = await account(req('PATCH', tok, { firstName: 'Kai', lastName: ' Park ', phone: '(415) 555-0134', charges: 99 }), env, g.fetchFn);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual([j.firstName, j.lastName, j.phone, j.charges], ['Kai', 'Park', '(415) 555-0134', 0]);
  assert.equal((await account(req('PATCH', tok, { phone: 'call me maybe' }), env, g.fetchFn)).status, 400);
  assert.equal((await account(req('PATCH', tok, { charges: 99 }), env, g.fetchFn)).status, 400);
  const cleared = await (await account(req('PATCH', tok, { phone: '' }), env, g.fetchFn)).json();
  assert.equal(cleared.phone, '');
});

test('a changed email is copied into the folder on the next hello', async () => {
  _resetCaches();
  const g = fakeGoogle();
  await account(req('POST', await sign({})), env, g.fetchFn);
  await account(req('POST', await sign({ email: 'new@example.com' })), env, g.fetchFn);
  assert.deepEqual(g.docs['users/uid123'].email, { stringValue: 'new@example.com' });
});

test('order history shows only this person\'s paid orders, newest first', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const tok = await sign({});
  await account(req('POST', tok), env, g.fetchFn);
  for (const id of ['ORD_PAID_OLD', 'ORD_PAID_NEW', 'ORD_UNPAID', 'ORD_SOMEONE_ELSE']) await noteOrder(env, 'uid123', id, g.fetchFn);
  const line = [{ name: 'aussie pin', quantity: '2' }];
  g.squareOrders.ORD_PAID_OLD = { id: 'ORD_PAID_OLD', state: 'COMPLETED', metadata: { uid: 'uid123' }, tenders: [{}], line_items: line, total_money: { amount: 2900, currency: 'USD' }, closed_at: '2026-10-01T10:00:00Z' };
  g.squareOrders.ORD_PAID_NEW = { id: 'ORD_PAID_NEW', state: 'OPEN', metadata: { uid: 'uid123' }, tenders: [{}], line_items: line, total_money: { amount: 2900, currency: 'USD' }, created_at: '2026-10-20T10:00:00Z' };
  g.squareOrders.ORD_UNPAID = { id: 'ORD_UNPAID', state: 'OPEN', metadata: { uid: 'uid123' }, line_items: line };
  g.squareOrders.ORD_SOMEONE_ELSE = { id: 'ORD_SOMEONE_ELSE', state: 'OPEN', metadata: { uid: 'other' }, tenders: [{}], line_items: line };
  const r = await account(req('GET', tok, undefined, '/api/account/orders'), env, g.fetchFn);
  assert.equal(r.status, 200);
  const { orders } = await r.json();
  assert.deepEqual(orders.map((o) => [o.id, o.status]), [['ORD_PAID_NEW', 'paid'], ['ORD_PAID_OLD', 'complete']]);
  assert.deepEqual(orders[0].items, [{ name: 'aussie pin', qty: 2 }]);
  assert.deepEqual(orders[0].total, { cents: 2900, currency: 'USD' });
});

test('no orders means an empty list, without asking Square', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const tok = await sign({});
  const r = await account(req('GET', tok, undefined, '/api/account/orders'), env, g.fetchFn);
  assert.deepEqual(await r.json(), { orders: [] });
  assert.ok(!g.calls.some((c) => c.includes('squareup')));
});

test('no ticket or a bad ticket is turned away', async () => {
  const g = fakeGoogle();
  assert.equal((await account(req('POST'), env, g.fetchFn)).status, 401);
  assert.equal((await account(req('POST', await sign({}, { key: stranger.privateKey })), env, g.fetchFn)).status, 401);
  assert.equal(Object.keys(g.docs).length, 0);
});

test('without Firebase settings the endpoint says so', async () => {
  assert.equal((await account(req('POST', 'x'), {}, fakeGoogle().fetchFn)).status, 503);
});

test('deleting needs a recent sign-in, then removes folder and login', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const t = Math.floor(Date.now() / 1000);
  await account(req('POST', await sign({})), env, g.fetchFn);
  const stale = await account(req('DELETE', await sign({ auth_time: t - 3600 })), env, g.fetchFn);
  assert.equal(stale.status, 403);
  assert.ok(g.docs['users/uid123']);

  await noteOrder(env, 'uid123', 'ORD1', g.fetchFn);
  const ok = await account(req('DELETE', await sign({})), env, g.fetchFn);
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(g.docs), []);
  assert.ok(g.calls.some((c) => c.endsWith('/accounts:delete')));
});

test('names are cleaned', () => {
  assert.equal(cleanName('<b>pip</b>'), 'bpip/b');
  assert.equal(cleanName('a\u0000b'), 'ab');
  assert.equal(cleanName('x'.repeat(60)).length, 40);
  assert.equal(cleanName(5), '');
});

test('phone numbers are checked', () => {
  assert.equal(cleanPhone('+1 415 555 0134'), '+1 415 555 0134');
  assert.equal(cleanPhone(''), '');
  assert.equal(cleanPhone('555'), null);
  assert.equal(cleanPhone('<script>'), null);
  assert.equal(cleanPhone('1'.repeat(20)), null);
});
