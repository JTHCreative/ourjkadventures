// Tests for "orders to ship" on /admin: the list of paid website orders, the "on its way" email, and marking
// an order shipped in Square with its tracking number.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { cleanTracking, shippedEmail } from '../server/shipped.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const OWNER = 'owner@example.com';

function order(id, extra = {}) {
  return {
    id, location_id: 'loc', state: 'OPEN', version: 3, tenders: [{}], created_at: '2026-11-09T10:00:00Z',
    line_items: [{ name: 'Large Aussie Pin (Exclusive)', quantity: '2', catalog_object_id: 'V_AUS_L' }, { name: 'Mystery Thing', quantity: '1', catalog_object_id: 'V_X' }],
    fulfillments: [{ uid: 'F1', type: 'SHIPMENT', state: 'PROPOSED', shipment_details: {
      recipient: { display_name: 'pup person', email_address: 'buyer@example.com', address: { address_line_1: '1 main st', locality: 'oakland', administrative_district_level_1: 'CA', postal_code: '94607', country: 'US' } },
      carrier: 'USPS', shipping_type: 'ground'
    } }],
    ...extra
  };
}

function setup({ resend = true, orders = {} } = {}) {
  _resetCaches();
  const w = fakeWorld();
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L') };
  const sq = { orders: { ...orders }, searches: [], puts: [] };
  const resendCalls = [];
  const fetchFn = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://api.resend.com/')) {
      resendCalls.push({ headers: opts.headers, body: JSON.parse(opts.body) });
      return Response.json({ data: [{ id: 'e1' }] });
    }
    if (url.endsWith('/v2/orders/search')) {
      sq.searches.push(JSON.parse(opts.body));
      return Response.json({ orders: Object.values(sq.orders) });
    }
    const m = /\/v2\/orders\/([A-Za-z0-9_-]+)$/.exec(url);
    if (m) {
      const o = sq.orders[m[1]];
      if (!o) return Response.json({ errors: [{ code: 'NOT_FOUND' }] }, { status: 404 });
      if ((opts.method || 'GET') === 'GET') return Response.json({ order: o });
      const body = JSON.parse(opts.body);
      sq.puts.push(body);
      if (sq.failNextPut) { sq.failNextPut = false; return Response.json({ errors: [{ code: 'INTERNAL_SERVER_ERROR' }] }, { status: 500 }); }
      if (body.order.version !== o.version) return Response.json({ errors: [{ code: 'VERSION_MISMATCH' }] }, { status: 400 });
      const f = o.fulfillments[0];
      const ch = body.order.fulfillments[0];
      f.state = ch.state;
      if (ch.shipment_details) Object.assign(f.shipment_details, ch.shipment_details);
      o.version += 1;
      return Response.json({ order: o });
    }
    return w.fetchFn(url, opts);
  };
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) }, ...(resend ? { RESEND_API_KEY: 're_test' } : {}) };
  const call = async (method, body, token) => admin(new Request('https://x.test/api/admin/orders', {
    method, headers: { Authorization: 'Bearer ' + (token || await sign({ email: OWNER })), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), env, fetchFn);
  return { ...w, sq, resendCalls, env, call };
}

test('tracking numbers: letters and digits, spaces and dashes dropped', () => {
  assert.equal(cleanTracking('9400 1000 0000 0000 0000 00'), '9400100000000000000000');
  assert.equal(cleanTracking('ea123456789us'), 'EA123456789US');
  for (const t of ['', 'short', 'https://evil.example/x', null, 42, 'a'.repeat(41)]) assert.equal(cleanTracking(t), null, String(t));
});

test('the list: paid website orders with a shipment still to go, in our own names', async () => {
  const s = setup({ orders: {
    PAID: order('PAID'),
    UNPAID: order('UNPAID', { tenders: undefined }),
    BOOTH: order('BOOTH', { fulfillments: [] }),
    SENT: order('SENT', { fulfillments: [{ ...order('x').fulfillments[0], state: 'COMPLETED' }] }),
    // refunded in full: nothing to send. partly refunded: still to send, and says so
    BACK: order('BACK', { refunds: [{ id: 'r1', status: 'COMPLETED', amount_money: { amount: 2700, currency: 'USD' } }], total_money: { amount: 2500, currency: 'USD' } }),
    PART: order('PART', { refunds: [{ id: 'r2', status: 'PENDING', amount_money: { amount: 1200, currency: 'USD' } }], total_money: { amount: 3100, currency: 'USD' } })
  } });
  const res = await (await s.call('GET')).json();
  assert.deepEqual(res.orders.map((o) => o.id), ['PAID', 'PART']);
  assert.equal(res.orders[1].refunded, true);
  assert.equal(res.orders[0].refunded, false);
  const o = res.orders[0];
  assert.equal(o.number, 'PAID');
  assert.deepEqual(o.items, [
    { name: 'large aussie pin', qty: 2, slug: 'aussie', path: '/pup-club/aussie' },
    { name: 'mystery thing', qty: 1, slug: null, path: '/shop' }
  ]);
  assert.deepEqual(o.address, { line1: '1 main st', line2: '', city: 'oakland', state: 'CA', zip: '94607' });
  assert.equal(o.email, 'buyer@example.com');
  assert.match(o.preview.html, /track your package/);
  const q = s.sq.searches[0];
  assert.deepEqual(q.location_ids, ['loc']);
  assert.deepEqual(q.query.filter.fulfillment_filter.fulfillment_types, ['SHIPMENT']);
});

test('order history: shipped website orders, newest first, a page at a time, read from Square', async () => {
  const sent = (id, extra = {}) => order(id, { state: 'COMPLETED', fulfillments: [{ ...order('x').fulfillments[0], state: 'COMPLETED',
    shipment_details: { ...order('x').fulfillments[0].shipment_details, tracking_number: '9400 1000 0000', shipped_at: '2026-11-10T18:00:00Z' } }], ...extra });
  const s = setup({ orders: {
    SENT: sent('SENT', { metadata: { gift: 'yes', gift_note: 'happy birthday' }, refunds: [{ id: 'r1' }], total_money: { amount: 3100, currency: 'USD' } }),
    WAITING: order('WAITING'),
    UNPAID: sent('UNPAID', { tenders: undefined }),
    // refunded in full before it shipped: in the history, marked so
    BACK: order('BACK', { refunds: [{ id: 'r2', status: 'COMPLETED', amount_money: { amount: 3100, currency: 'USD' } }], total_money: { amount: 3100, currency: 'USD' } }),
    // a refund Square turned down doesn't count
    TRIED: order('TRIED', { refunds: [{ id: 'r3', status: 'REJECTED', amount_money: { amount: 3100, currency: 'USD' } }], total_money: { amount: 3100, currency: 'USD' } })
  } });
  const get = async (q = '', token) => admin(new Request('https://x.test/api/admin/orders/history' + q, {
    headers: { Authorization: 'Bearer ' + (token || await sign({ email: OWNER })) }
  }), s.env, (url, opts) => {
    if (String(url).endsWith('/v2/orders/search')) {
      s.sq.searches.push(JSON.parse(opts.body));
      return Response.json({ orders: Object.values(s.sq.orders), cursor: 'NEXT_PAGE' });
    }
    return s.fetchFn(url, opts);
  });
  const res = await (await get()).json();
  assert.deepEqual(res.orders.map((o) => o.id), ['SENT', 'BACK']);
  const back = res.orders[1];
  assert.equal(back.shipped, false);
  assert.equal(back.refundedAll, true);
  const o = res.orders[0];
  assert.equal(o.shipped, true);
  assert.equal(o.refundedAll, false);
  assert.equal(o.tracking, '940010000000');
  assert.equal(o.shippedAt, '2026-11-10T18:00:00Z');
  assert.equal(o.gift, true);
  assert.equal(o.giftNote, 'happy birthday');
  assert.equal(o.refunded, true);
  assert.equal(o.total, 3100);
  assert.equal(o.items[0].name, 'large aussie pin');
  assert.equal(o.preview, undefined);
  assert.equal(res.cursor, 'NEXT_PAGE');
  const q = s.sq.searches[0];
  assert.deepEqual(q.location_ids, ['loc']);
  assert.deepEqual(q.query.filter.fulfillment_filter.fulfillment_states, ['PROPOSED', 'RESERVED', 'PREPARED', 'COMPLETED']);
  assert.equal(q.query.sort.sort_order, 'DESC');
  assert.equal(q.limit, 20);
  assert.equal(q.cursor, undefined);
  // the next page passes Square's bookmark back as it came
  await get('?cursor=NEXT_PAGE');
  assert.equal(s.sq.searches[1].cursor, 'NEXT_PAGE');
  assert.equal((await get('?cursor=' + encodeURIComponent('<script>'))).status, 400);
  // owner only
  assert.equal((await get('', await sign({ email: 'someone@example.com' }))).status, 403);
});

test('mark shipped: one email with tracking, then Square steps the shipment to completed', async () => {
  const s = setup({ orders: { ORD1: order('ORD1') } });
  const r = await s.call('POST', { id: 'ORD1', tracking: '9400 1000 0000 0000 0000 00' });
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.equal(res.emailed, true);
  assert.deepEqual(res.orders, []);
  // the email
  assert.equal(s.resendCalls.length, 1);
  const mail = s.resendCalls[0].body[0];
  assert.deepEqual(mail.to, ['buyer@example.com']);
  assert.equal(mail.subject, 'your order is on its way');
  assert.match(mail.text, /hi pup,/);
  assert.match(mail.text, /tLabels=9400100000000000000000/);
  assert.match(mail.html, /large aussie pin/);
  assert.match(mail.html, /assets\/img\/email\/aussie\.png/);
  assert.equal(s.resendCalls[0].headers['Idempotency-Key'], 'shipped-ORD1-9400100000000000000000');
  // Square, one step at a time, each with the version it was given
  assert.deepEqual(s.sq.puts.map((p) => [p.order.fulfillments[0].state, p.order.version]), [['RESERVED', 3], ['PREPARED', 4], ['COMPLETED', 5]]);
  const f = s.sq.orders.ORD1.fulfillments[0];
  assert.equal(f.state, 'COMPLETED');
  assert.equal(f.shipment_details.tracking_number, '9400100000000000000000');
  assert.equal(f.shipment_details.carrier, 'USPS');
  // pressing again: it's already shipped, nothing more is sent
  assert.equal((await s.call('POST', { id: 'ORD1', tracking: '9400100000000000000000' })).status, 409);
  assert.equal(s.resendCalls.length, 1);
});

test('a gift says so, and never greets the buyer by the person getting it', async () => {
  const s = setup({ orders: { G1: order('G1', { metadata: { gift: 'yes' } }) } });
  assert.equal((await s.call('POST', { id: 'G1', tracking: 'EA123456789US' })).status, 200);
  const mail = s.resendCalls[0].body[0];
  assert.equal(mail.subject, 'your gift is on its way');
  assert.match(mail.text, /hi there,/);
  assert.match(mail.text, /on its way to pup person/);
  assert.match(mail.text, /left the receipt out of the box/);
});

test('each gift order to ship carries its card note, read from the Square order', async () => {
  const s = setup({ orders: { G1: order('G1', { metadata: { gift: 'yes', gift_note: 'we love luna!' } }), P1: order('P1') } });
  const res = await (await s.call('GET')).json();
  const byId = Object.fromEntries(res.orders.map((o) => [o.id, o]));
  assert.equal(byId.G1.gift, true);
  assert.equal(byId.G1.giftNote, 'we love luna!');
  assert.equal(byId.P1.giftNote, '');
});

test('marking a gift shipped ticks off its card to write (it went in the box)', async () => {
  const s = setup({ orders: { G1: order('G1', { metadata: { gift: 'yes' } }) } });
  s.g.docs['gifts/G1'] = { message: { stringValue: 'we love luna!' }, email: { stringValue: 'buyer@example.com' } };
  s.g.docs['gifts/OTHER'] = { message: { stringValue: 'not this one' } };
  assert.equal((await s.call('POST', { id: 'G1', tracking: 'EA123456789US' })).status, 200);
  assert.equal(s.g.docs['gifts/G1'], undefined);
  assert.ok(s.g.docs['gifts/OTHER']);
});

test('mark shipped refuses a bad tracking number, an unpaid or unknown order, and customers', async () => {
  const s = setup({ orders: { ORD1: order('ORD1'), UNPAID: order('UNPAID', { tenders: [] }), ELSE: order('ELSE', { location_id: 'other' }) } });
  assert.equal((await s.call('POST', { id: 'ORD1', tracking: 'nope' })).status, 400);
  assert.equal((await s.call('POST', { id: '../x', tracking: 'EA123456789US' })).status, 400);
  assert.equal((await s.call('POST', { id: 'UNPAID', tracking: 'EA123456789US' })).status, 404);
  assert.equal((await s.call('POST', { id: 'ELSE', tracking: 'EA123456789US' })).status, 404);
  assert.equal((await s.call('POST', { id: 'ORD1', tracking: 'EA123456789US' }, await sign({}))).status, 403);
  assert.equal(s.resendCalls.length, 0);
  assert.equal(s.sq.puts.length, 0);
});

test('without email set up, mark shipped still marks it in Square', async () => {
  const s = setup({ resend: false, orders: { ORD1: order('ORD1') } });
  const res = await (await s.call('POST', { id: 'ORD1', tracking: 'EA123456789US' })).json();
  assert.equal(res.emailed, false);
  assert.equal(s.sq.orders.ORD1.fulfillments[0].state, 'COMPLETED');
});

test('if Square hiccups after the email, pressing again sends the same email (Resend drops the repeat)', async () => {
  const s = setup({ orders: { ORD1: order('ORD1') } });
  s.sq.failNextPut = true;
  assert.equal((await s.call('POST', { id: 'ORD1', tracking: 'EA123456789US' })).status, 503);
  assert.equal(s.sq.orders.ORD1.fulfillments[0].state, 'PROPOSED');
  assert.equal((await s.call('POST', { id: 'ORD1', tracking: 'EA123456789US' })).status, 200);
  assert.equal(s.sq.orders.ORD1.fulfillments[0].state, 'COMPLETED');
  // two sends with one key: Resend delivers the first and drops the repeat
  assert.equal(s.resendCalls.length, 2);
  assert.equal(s.resendCalls[0].headers['Idempotency-Key'], s.resendCalls[1].headers['Idempotency-Key']);
});

test('the email reads well without a name, a picture or a shipping choice', () => {
  const m = shippedEmail({ name: '', address: { line1: '1 main st', line2: '', city: 'oakland', state: 'CA', zip: '94607' }, items: [{ name: 'thing', qty: 1, slug: null, path: '/shop' }], number: 'ABC123', shipping: '', gift: false }, 'EA123456789US', 'https://x.test');
  assert.match(m.text, /hi there,/);
  assert.match(m.text, /your order is packed and on its way to you by usps\./);
  assert.ok(!m.html.includes('undefined'));
  assert.ok(m.html.includes('<!doctype html>'));
});

test('remove from history: hidden on /admin only (the order stays in Square), with a list to put it back from', async () => {
  const sent = (id) => order(id, { state: 'COMPLETED', fulfillments: [{ ...order('x').fulfillments[0], state: 'COMPLETED' }] });
  const s = setup({ orders: { KEEP: sent('KEEP'), TEST: sent('TEST') } });
  // Square's search and its look-up by id, like the real ones
  const fetchFn = (url, opts) => {
    url = String(url);
    if (url.endsWith('/v2/orders/search')) return Response.json({ orders: Object.values(s.sq.orders) });
    if (url.endsWith('/v2/orders/batch-retrieve')) {
      const ids = JSON.parse(opts.body).order_ids;
      return Response.json({ orders: ids.map((id) => s.sq.orders[id]).filter(Boolean) });
    }
    return s.fetchFn(url, opts);
  };
  const call = async (method, q = '', body, email = OWNER) => admin(new Request('https://x.test/api/admin/orders/history' + q, {
    method, headers: { Authorization: 'Bearer ' + await sign({ email }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), s.env, fetchFn);
  const ids = async (q) => (await (await call('GET', q)).json()).orders.map((o) => o.id);

  assert.deepEqual(await ids(''), ['KEEP', 'TEST']);
  assert.equal((await call('POST', '', { id: 'TEST', removed: true })).status, 200);
  assert.deepEqual(await ids(''), ['KEEP']);
  assert.deepEqual(await ids('?removed=1'), ['TEST']);
  // only the order id and when are kept: nothing about the buyer
  assert.deepEqual(Object.keys(s.g.docs['hidden_orders_sandbox/TEST']), ['createdAt']);
  // put back
  assert.equal((await call('POST', '', { id: 'TEST', removed: false })).status, 200);
  assert.deepEqual(await ids(''), ['KEEP', 'TEST']);
  assert.deepEqual(await ids('?removed=1'), []);
  // nothing in Square changed
  assert.equal(s.sq.puts.length, 0);
  // checked, and owner only
  assert.equal((await call('POST', '', { id: '../users', removed: true })).status, 400);
  assert.equal((await call('POST', '', { id: 'TEST', removed: 'yes' })).status, 400);
  assert.equal((await call('POST', '', { id: 'TEST', removed: true }, 'someone@example.com')).status, 403);
  assert.equal(s.g.docs['hidden_orders_sandbox/TEST'], undefined);
});
