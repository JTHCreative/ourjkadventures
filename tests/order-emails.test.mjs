// Tests for the emails added on 2026-11-09: "thank you for your order" (from Square's payment doorbell), "a new date
// for your pre-order", the owner's alerts, the account emails, and that every email wears the same letterhead.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { squareWebhook, sealFor, thanksEmail } from '../server/square-webhook.js';
import { accountEmailRoute, verifyEmail, resetEmail, changeEmail, PER_ADDRESS } from '../server/account-emails.js';
import { reviewAlertEmail, giftAlertEmail, REVIEW_ALERTS_PER_DAY } from '../server/owner-alerts.js';
import { reviews, _resetReviewCache } from '../server/reviews.js';
import { shippedEmail, movedEmail } from '../server/shipped.js';
import { itsHereEmail } from '../server/notify.js';
import { shopToday } from '../server/preorder-words.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const products = JSON.parse(fs.readFileSync(new URL('../site/products.json', import.meta.url)));
const str = (s) => ({ stringValue: s });
const OWNER = 'owner@example.com';
const KEY = 'sig-key';
const HOOK = 'https://x.test/api/square-webhook';
function inDays(n) {
  const d = new Date(shopToday() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function order(id, extra = {}, details = {}) {
  return {
    id, location_id: 'loc', state: 'OPEN', version: 3, tenders: [{}], created_at: '2026-11-09T10:00:00Z',
    total_money: { amount: 3100, currency: 'USD' },
    line_items: [{ name: 'Large Aussie Pin (Exclusive)', quantity: '2', catalog_object_id: 'V_AUS_L' }],
    fulfillments: [{ uid: 'F1', type: 'SHIPMENT', state: 'PROPOSED', shipment_details: {
      recipient: { display_name: 'pup person', email_address: 'buyer@example.com', address: { address_line_1: '1 main st', locality: 'oakland', administrative_district_level_1: 'CA', postal_code: '94607', country: 'US' } },
      carrier: 'USPS', shipping_type: 'ground', ...details
    } }],
    ...extra
  };
}

function setup({ resend = true, orders = {}, hook = true, oob = {} } = {}) {
  _resetCaches();
  _resetReviewCache();
  const w = fakeWorld();
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L') };
  const sq = { orders: { ...orders }, puts: [] };
  const sent = [];
  const keys = [];
  const links = [];
  const fetchFn = async (url, opts = {}) => {
    url = String(url);
    if (url.startsWith('https://api.resend.com/')) {
      keys.push(opts.headers['Idempotency-Key']);
      for (const m of JSON.parse(opts.body)) sent.push(m);
      return Response.json({ data: [{ id: 'e1' }] });
    }
    if (url.startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [{ type: 15, data: '10 mx.example.com.' }] });
    if (url.endsWith('/accounts:sendOobCode')) {
      const b = JSON.parse(opts.body);
      links.push(b);
      const fail = oob[b.requestType];
      if (fail) return Response.json({ error: { message: fail } }, { status: 400 });
      return Response.json({ email: b.email, oobLink: 'https://jk.firebaseapp.com/__/auth/action?mode=' + b.requestType + '&oobCode=abc' });
    }
    if (url.endsWith('/v2/orders/search')) return Response.json({ orders: Object.values(sq.orders) });
    const m = /\/v2\/orders\/([A-Za-z0-9_-]+)$/.exec(url);
    if (m) {
      const o = sq.orders[m[1]];
      if (!o) return Response.json({ errors: [{ code: 'NOT_FOUND' }] }, { status: 404 });
      if ((opts.method || 'GET') === 'GET') return Response.json({ order: o });
      const body = JSON.parse(opts.body);
      sq.puts.push(body);
      if (body.order.version !== o.version) return Response.json({ errors: [{ code: 'VERSION_MISMATCH' }] }, { status: 400 });
      const ch = body.order.fulfillments[0];
      if (ch.state) o.fulfillments[0].state = ch.state;
      if (ch.shipment_details) Object.assign(o.fulfillments[0].shipment_details, ch.shipment_details);
      o.version += 1;
      return Response.json({ order: o });
    }
    return w.fetchFn(url, opts);
  };
  const env = {
    ...baseEnv, ADMIN_EMAILS: OWNER, ASSETS: { fetch: async () => Response.json(products) },
    ...(resend ? { RESEND_API_KEY: 're_test' } : {}), ...(hook ? { SQUARE_WEBHOOK_SIGNATURE_KEY: KEY } : {})
  };
  const ring = async (event, { seal } = {}) => {
    const body = JSON.stringify(event);
    return squareWebhook(new Request(HOOK, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': seal || (await sealFor(KEY, HOOK, body)) }, body
    }), env, fetchFn);
  };
  const paid = (orderId, type = 'payment.updated') => ({
    type, event_id: 'ev-' + orderId, data: { type: 'payment', id: 'P1', object: { payment: { id: 'P1', order_id: orderId, status: 'COMPLETED', location_id: 'loc' } } }
  });
  const adminCall = async (method, body) => admin(new Request('https://x.test/api/admin/orders', {
    method, headers: { Authorization: 'Bearer ' + (await sign({ email: OWNER })), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  }), env, fetchFn);
  const accountCall = async (kind, body, claims, ip = '1.2.3.4') => accountEmailRoute(new Request('https://x.test/api/account/email/' + kind, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(claims ? { Authorization: 'Bearer ' + (await sign(claims)) } : {}) },
    body: JSON.stringify(body || {})
  }), env, fetchFn);
  return { ...w, sq, sent, keys, links, env, fetchFn, ring, paid, adminCall, accountCall };
}

/* ---------- the doorbell and "thank you for your order" ---------- */
test('webhook: a message without Square\'s seal is turned away, and nothing is read or sent', async () => {
  const s = setup({ orders: { ORD1: order('ORD1') } });
  const r = await s.ring(s.paid('ORD1'), { seal: 'bm90IHRoZSBzZWFs' });
  assert.equal(r.status, 403);
  assert.equal(s.sent.length, 0);
  // not set up yet: 503, so Square keeps trying until it is
  const off = setup({ hook: false });
  assert.equal((await off.ring(off.paid('ORD1'))).status, 503);
});

test('webhook: a paid website order gets one thank-you, however many times Square rings', async () => {
  const s = setup({ orders: { ORD1: order('ORD1') } });
  const r = await s.ring(s.paid('ORD1', 'payment.created'));
  assert.equal(r.status, 200);
  assert.equal((await r.json()).thanked, true);
  assert.equal(s.sent.length, 1);
  const m = s.sent[0];
  assert.deepEqual(m.to, ['buyer@example.com']);
  assert.equal(m.subject, 'thank you for your order');
  assert.equal(m.reply_to, 'support@ourjkadventures.com');
  assert.match(m.text, /hi pup,/);
  assert.match(m.text, /2 × large aussie pin/);
  assert.match(m.text, /total paid \$31\.00/);
  assert.match(m.text, /tracking number the day it ships/);
  assert.match(m.html, /assets\/img\/email\/aussie\.png/);
  assert.equal(s.keys[0], 'thanks-ORD1');
  // Square rings again (payment.updated, or a retry): no second email
  assert.equal((await (await s.ring(s.paid('ORD1'))).json()).skipped, 'already');
  assert.equal(s.sent.length, 1);
});

test('webhook: booth sales, unpaid orders, other events and other locations are left alone', async () => {
  const s = setup({ orders: { BOOTH: order('BOOTH', { fulfillments: [] }), UNPAID: order('UNPAID', { tenders: [] }), ELSE: order('ELSE', { location_id: 'other' }) } });
  assert.equal((await (await s.ring(s.paid('BOOTH'))).json()).skipped, 'not a website order');
  assert.equal((await (await s.ring(s.paid('UNPAID'))).json()).skipped, 'not paid');
  assert.equal((await (await s.ring(s.paid('ELSE'))).json()).skipped, 'not ours');
  const pending = s.paid('BOOTH');
  pending.data.object.payment.status = 'APPROVED';
  assert.equal((await (await s.ring(pending)).json()).ignored, true);
  assert.equal((await (await s.ring({ type: 'refund.created', data: {} })).json()).ignored, true);
  // Square's "send test event" names an order that doesn't exist: a 200, so it isn't sent again and again
  const t = await s.ring(s.paid('MADEUP'));
  assert.equal(t.status, 200);
  assert.equal((await t.json()).skipped, 'no such order');
  assert.equal(s.sent.length, 0);
});

test('webhook: a gift says so to the buyer, and the owner gets the card to write', async () => {
  const s = setup({ orders: { G1: order('G1', { metadata: { gift: 'yes', gift_note: 'happy birthday, mo' } }) } });
  const res = await (await s.ring(s.paid('G1'))).json();
  assert.equal(res.thanked, true);
  assert.equal(res.alerted, true);
  const buyer = s.sent.find((m) => m.to[0] === 'buyer@example.com');
  assert.equal(buyer.subject, 'thank you for your gift order');
  assert.match(buyer.text, /hi there,/);
  assert.match(buyer.text, /write your note on a card by hand/);
  assert.match(buyer.text, /"happy birthday, mo"/);
  const owner = s.sent.find((m) => m.to[0] === OWNER);
  assert.equal(owner.subject, 'a gift card to write: order G1');
  assert.match(owner.text, /happy birthday, mo/);
  assert.match(owner.html, /admin#admin-orders-title/);
  await s.ring(s.paid('G1'));
  assert.equal(s.sent.length, 2);
});

test('webhook: a pre-order thank-you says when the whole order ships', async () => {
  const date = inDays(30);
  const s = setup({ orders: { PRE: order('PRE', { metadata: { preorder: 'yes' } }, { expected_shipped_at: date + 'T17:00:00Z' }) } });
  await s.ring(s.paid('PRE'));
  assert.match(s.sent[0].text, /has a pre-order in it, so everything ships together around [a-z]+ \d+/);
});

test('webhook: a hiccup sending the email answers 500, so Square tries again', async () => {
  const s = setup({ orders: { ORD1: order('ORD1') } });
  const broken = async (url, opts) => (String(url).startsWith('https://api.resend.com/') ? new Response('down', { status: 500 }) : s.fetchFn(url, opts));
  const body = JSON.stringify(s.paid('ORD1'));
  const r = await squareWebhook(new Request(HOOK, { method: 'POST', headers: { 'x-square-hmacsha256-signature': await sealFor(KEY, HOOK, body) }, body }), s.env, broken);
  assert.equal(r.status, 500);
  assert.equal((await (await s.ring(s.paid('ORD1'))).json()).thanked, true);
});

/* ---------- a pre-order's date moved ---------- */
function preorderWorld(paidFor, nowDate) {
  const line = { name: 'Large Aussie Pin (Exclusive)', quantity: '1', catalog_object_id: 'V_AUS_L', note: 'pre-order. expected to ship around then' };
  const s = setup({ orders: { PRE: order('PRE', { metadata: { preorder: 'yes' }, line_items: [line] },
    { expected_shipped_at: paidFor + 'T17:00:00Z', shipping_note: 'pre-order: the whole order ships together around december 15 / gift. blank card, no note' }) } });
  s.g.docs['settings/preorder_sandbox'] = { aussie: { booleanValue: true } };
  s.g.docs['settings/preorder_dates_sandbox'] = { aussie: str(nowDate) };
  return s;
}

test('orders to ship: a pre-order paid for before its date moved is flagged, with the email to send', async () => {
  const s = preorderWorld(inDays(20), inDays(45));
  const o = (await (await s.adminCall('GET')).json()).orders[0];
  assert.deepEqual({ from: o.moved.from, to: o.moved.to, pins: o.moved.pins }, { from: inDays(20), to: inDays(45), pins: ['aussie pin'] });
  assert.equal(o.moved.preview.subject, 'a new date for your pre-order');
  assert.match(o.moved.preview.text, /taking a little longer than we planned/);
  // its date unchanged: no flag
  const same = preorderWorld(inDays(20), inDays(20));
  assert.equal((await (await same.adminCall('GET')).json()).orders[0].moved, undefined);
  // the pin arrived (pre-order off): nothing holds the order up, no flag
  const here = preorderWorld(inDays(20), inDays(45));
  here.g.docs['settings/preorder_sandbox'] = {};
  assert.equal((await (await here.adminCall('GET')).json()).orders[0].moved, undefined);
});

test('email the new date: one email, then the date moves on the Square order and the flag goes', async () => {
  const s = preorderWorld(inDays(20), inDays(45));
  const res = await (await s.adminCall('POST', { id: 'PRE', moved: true })).json();
  assert.equal(res.emailed, true);
  assert.equal(res.date, inDays(45));
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].subject, 'a new date for your pre-order');
  assert.equal(s.keys[0], 'moved-PRE-' + inDays(45));
  const d = s.sq.orders.PRE.fulfillments[0].shipment_details;
  assert.equal(d.expected_shipped_at, inDays(45) + 'T17:00:00Z');
  assert.match(d.shipping_note, /^pre-order: the whole order ships together around [a-z]+ \d+(, \d{4})? \/ gift\. blank card, no note$/);
  assert.equal(d.recipient.email_address, 'buyer@example.com');
  assert.equal(res.orders[0].moved, undefined);
  // pressed again: nothing to do
  const again = await s.adminCall('POST', { id: 'PRE', moved: true });
  assert.equal(again.status, 409);
  assert.equal(s.sent.length, 1);
});

test('a date that moved sooner is good news', () => {
  const o = { name: 'pup person', gift: false, number: 'ABC123', items: [{ name: 'corgi pin', qty: 1, slug: 'corgi', path: '/pup-club/corgi' }] };
  const m = movedEmail(o, { from: inDays(40), to: inDays(10), pins: ['corgi pin'] }, 'https://x.test');
  assert.match(m.text, /good news: the corgi pin is coming along sooner/);
  assert.ok(!/sorry/.test(m.text));
});

/* ---------- owner alerts ---------- */
test('a new review rings the owner, at most so many a day', async () => {
  const s = setup();
  const leave = async (i) => reviews(new Request('https://x.test/api/reviews', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '9.9.9.' + i },
    body: JSON.stringify({ slug: 'corgi', rating: 4, text: 'love the ears', name: 'juniper hsu', email: 'june' + i + '@example.com' })
  }), s.env, s.fetchFn);
  assert.equal((await (await leave(0)).json()).saved, true);
  assert.equal(s.sent.length, 1);
  const m = s.sent[0];
  assert.deepEqual(m.to, [OWNER]);
  assert.equal(m.subject, 'a review is waiting: the corgi pin, 4 stars');
  assert.match(m.text, /juniper h\. \(a guest\) left a review of the corgi pin/);
  assert.match(m.text, /love the ears/);
  for (let i = 1; i < REVIEW_ALERTS_PER_DAY + 3; i++) await leave(i);
  assert.equal(s.sent.length, REVIEW_ALERTS_PER_DAY);
});

test('no email set up: reviews still save, and no bell rings', async () => {
  const s = setup({ resend: false });
  const r = await reviews(new Request('https://x.test/api/reviews', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'corgi', rating: 5, text: '', name: 'mo', email: 'mo@example.com' })
  }), s.env, s.fetchFn);
  assert.equal((await r.json()).saved, true);
  assert.equal(s.sent.length, 0);
});

/* ---------- account emails ---------- */
test('reset: our own email with Firebase\'s link, and the same answer for an address with no account', async () => {
  const s = setup();
  assert.deepEqual(await (await s.accountCall('reset', { email: 'Pup@Example.com' })).json(), { sent: true });
  assert.equal(s.links[0].requestType, 'PASSWORD_RESET');
  assert.equal(s.links[0].email, 'pup@example.com');
  assert.equal(s.links[0].returnOobLink, true);
  assert.equal(s.links[0].continueUrl, 'https://x.test/sign-in.html');
  assert.equal(s.sent[0].subject, 'choose a new password');
  assert.match(s.sent[0].html, /mode=PASSWORD_RESET&amp;oobCode=abc/);
  assert.match(s.sent[0].html, />choose a new password<\/a>/);
  const none = setup({ oob: { PASSWORD_RESET: 'EMAIL_NOT_FOUND' } });
  assert.deepEqual(await (await none.accountCall('reset', { email: 'nobody@example.com' })).json(), { sent: true });
  assert.equal(none.sent.length, 0);
  assert.equal((await s.accountCall('reset', { email: 'not an email' })).status, 400);
});

test('reset: a few a day to one address (quietly), and a cap per connection', async () => {
  const s = setup();
  for (let i = 0; i < PER_ADDRESS + 2; i++) assert.deepEqual(await (await s.accountCall('reset', { email: 'pup@example.com' }, null, '5.5.5.' + i)).json(), { sent: true });
  assert.equal(s.sent.length, PER_ADDRESS);
  const t = setup();
  let last;
  for (let i = 0; i < 11; i++) last = await t.accountCall('reset', { email: 'p' + i + '@example.com' });
  assert.equal(last.status, 429);
});

test('verify: to the account\'s own address, with its first name; already confirmed sends nothing', async () => {
  const s = setup();
  s.g.docs['users/uid123'] = { firstName: str('Juniper') };
  assert.deepEqual(await (await s.accountCall('verify', {}, { email_verified: false })).json(), { sent: true });
  assert.equal(s.links[0].requestType, 'VERIFY_EMAIL');
  assert.deepEqual(s.sent[0].to, ['pup@example.com']);
  assert.equal(s.sent[0].subject, 'confirm your email');
  assert.match(s.sent[0].text, /hi juniper,/);
  assert.deepEqual(await (await s.accountCall('verify', {}, { email_verified: true })).json(), { status: 'already' });
  assert.equal((await s.accountCall('verify', {})).status, 401);
});

test('change: to the new address, only after a fresh sign-in, and never to an address that has an account', async () => {
  const s = setup();
  assert.deepEqual(await (await s.accountCall('change', { newEmail: 'new@example.com' }, {})).json(), { sent: true });
  assert.equal(s.links[0].requestType, 'VERIFY_AND_CHANGE_EMAIL');
  assert.equal(s.links[0].newEmail, 'new@example.com');
  assert.deepEqual(s.sent[0].to, ['new@example.com']);
  assert.equal(s.sent[0].subject, 'confirm your new email');
  const old = Math.floor(Date.now() / 1000) - 3600;
  assert.equal((await s.accountCall('change', { newEmail: 'new@example.com' }, { auth_time: old })).status, 403);
  const taken = setup({ oob: { VERIFY_AND_CHANGE_EMAIL: 'EMAIL_EXISTS' } });
  assert.equal((await taken.accountCall('change', { newEmail: 'used@example.com' }, {})).status, 409);
});

test('account emails not set up: 503, so the browser lets Firebase send its own', async () => {
  const s = setup({ resend: false });
  assert.equal((await s.accountCall('reset', { email: 'pup@example.com' })).status, 503);
  assert.equal((await s.accountCall('verify', {}, { email_verified: false })).status, 503);
  // and a hiccup at Firebase is a 503 too
  const t = setup({ oob: { VERIFY_EMAIL: 'INTERNAL_ERROR' } });
  assert.equal((await t.accountCall('verify', {}, { email_verified: false })).status, 503);
});

/* ---------- one letterhead for all ---------- */
test('every email: the same letterhead, lowercase words, a plain-text twin, nothing left blank', () => {
  const origin = 'https://x.test';
  const o = {
    number: 'ABC123', name: 'pup person', email: 'b@example.com', gift: false, giftNote: '', preorder: false, expected: '', total: 1200, shipping: 'ground',
    address: { line1: '1 main st', line2: '', city: 'oakland', state: 'CA', zip: '94607' },
    items: [{ name: 'corgi pin', qty: 1, slug: 'corgi', path: '/pup-club/corgi' }]
  };
  const corgi = products.items.find((p) => p.slug === 'corgi');
  const all = {
    itsHere: itsHereEmail(corgi, origin + '/pup-club/corgi', origin + '/email.html?stop=x', { logo: origin + '/assets/img/email/logo.png', product: null }),
    thanks: thanksEmail(o, origin),
    shipped: shippedEmail(o, '9400100000000000000000', origin),
    moved: movedEmail(o, { from: inDays(10), to: inDays(30), pins: ['corgi pin'] }, origin),
    verify: verifyEmail('https://link.test/v', 'juniper', origin),
    reset: resetEmail('https://link.test/r', origin),
    change: changeEmail('https://link.test/c', '', origin),
    review: reviewAlertEmail({ id: 'r', noun: 'the corgi pin', name: 'mo', rating: 5, text: 'yes', photos: 2 }, origin),
    gift: giftAlertEmail({ id: 'g', number: 'ABC123', name: 'mo', giftNote: '' }, origin)
  };
  for (const [name, m] of Object.entries(all)) {
    assert.equal(m.subject.replace('ABC123', ''), m.subject.replace('ABC123', '').toLowerCase(), name + ' subject');
    assert.ok(!/!/.test(m.subject) || name === 'itsHere', name + ': no exclamation in the subject');
    assert.ok(m.text.length > 40, name + ' text');
    assert.ok(m.html.startsWith('<!doctype html>'), name);
    assert.ok(m.html.includes('src="https://x.test/assets/img/email/logo.png"'), name + ' logo');
    assert.ok(m.html.includes('background:#efe6dd') && m.html.includes('background:#f9f9f7'), name + ' paper');
    assert.ok(m.html.includes("Georgia,'EB Garamond'"), name + ' font');
    assert.ok(!/undefined|null|NaN/.test(m.html + m.text), name + ' nothing blank');
    assert.ok(!/<script/i.test(m.html), name);
    // the words (not the addresses, and not the owner's own setting names) are lowercase
    const words = m.text.replace(/https?:\/\/\S+/g, '').replace(/ADMIN_EMAILS|CA \d{5}|ABC123|\d{10,}/g, '');
    assert.equal(words, words.toLowerCase(), name + ' lowercase');
  }
});
