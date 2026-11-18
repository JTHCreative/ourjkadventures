// Tests for "where buyers come from" on /admin: the "how did you hear about us?" answers on website orders, added up.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { periodStart } from '../server/heard-report.js';
import { fakeWorld, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const usd = (amount) => ({ amount, currency: 'USD' });
function order(id, heard, extra = {}) {
  return {
    id, state: 'OPEN', tenders: [{}], created_at: '2026-11-09T10:00:00Z', total_money: usd(2000),
    fulfillments: [{ type: 'SHIPMENT', state: 'PROPOSED', shipment_details: {} }],
    ...(heard ? { metadata: { heard_from: heard } } : {}),
    ...extra
  };
}

function setup(pages) {
  _resetCaches();
  const w = fakeWorld();
  const searches = [];
  const fetchFn = async (url, opts = {}) => {
    if (String(url).endsWith('/v2/orders/search')) {
      const body = JSON.parse(opts.body);
      searches.push(body);
      const i = body.cursor ? Number(body.cursor) : 0;
      return Response.json({ orders: pages[i], ...(i + 1 < pages.length ? { cursor: String(i + 1) } : {}) });
    }
    return w.fetchFn(url, opts);
  };
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER };
  const get = async (q = '', email = OWNER) => admin(new Request('https://x.test/api/admin/heard-from' + q, {
    headers: { Authorization: 'Bearer ' + await sign({ email }) }
  }), env, fetchFn);
  return { get, searches, env };
}

test('adds up the answers per choice, across pages, leaving out booth sales, unpaid and refunded orders', async () => {
  const s = setup([
    [
      order('A1', 'google'),
      order('A2', 'google', { refunds: [{ status: 'COMPLETED', amount_money: usd(500) }] }),
      order('A3', 'spca', { created_at: '2026-10-31T23:00:00Z' }),
      order('BOOTH', null, { fulfillments: [] }),
      order('UNPAID', 'google', { tenders: undefined }),
      order('BACK', 'etsy', { refunds: [{ status: 'COMPLETED', amount_money: usd(2000) }] })
    ],
    [order('OLD', null, { created_at: '2026-09-02T18:00:00Z' }), order('GONE', 'tiktok')]
  ]);
  const r = await (await s.get('?period=all')).json();
  assert.equal(r.square, true);
  assert.equal(s.searches.length, 2);
  // website orders only, and every page read
  assert.deepEqual(s.searches[0].query.filter.fulfillment_filter.fulfillment_types, ['SHIPMENT']);
  assert.equal(s.searches[0].query.filter.date_time_filter, undefined);
  const by = Object.fromEntries(r.sources.map((x) => [x.id, x]));
  assert.deepEqual(by.google, { id: 'google', label: 'google', orders: 2, cents: 3500 });
  assert.equal(by.spca.orders, 1);
  assert.equal(by.etsy.orders, 0);
  // every choice on the list shows, even with none, and an answer no longer on the list keeps its own pile
  assert.deepEqual(r.sources.map((x) => x.id), ['friends-family', 'word-of-mouth', 'spca', 'etsy', 'google', 'instagram', 'facebook', 'craft-fair', 'tiktok']);
  assert.equal(r.asked, 4);
  assert.deepEqual(r.unasked, { orders: 1, cents: 2000 });
  // months in california's calendar: 11pm UTC on october 31 is 4pm there, so it counts in october
  assert.deepEqual(r.months.map((m) => m.month), ['2026-11', '2026-10', '2026-09']);
  assert.deepEqual(r.months[0].counts, { google: 2, tiktok: 1 });
  assert.equal(r.months[2].unasked, 1);
  assert.equal(r.rows.length, 5);
  assert.deepEqual(r.rows[0], { date: '2026-11-09', number: 'A1', heard: 'google', cents: 2000 });
  assert.equal(r.partial, false);
});

test('a period starts the search there; "this year" starts at midnight on january 1 in california', async () => {
  const now = new Date('2026-11-18T12:00:00Z');
  assert.equal(periodStart('30d', now), '2026-10-19T12:00:00.000Z');
  assert.equal(periodStart('year', now), '2026-01-01T08:00:00.000Z');
  // 5pm on december 31 in california is already january 1 in UTC: still last year there
  assert.equal(periodStart('year', new Date('2027-01-01T01:00:00Z')), '2026-01-01T08:00:00.000Z');
  assert.equal(periodStart('all', now), null);
  const s = setup([[]]);
  const r = await (await s.get()).json();
  assert.equal(r.period, 'year');
  assert.ok(s.searches[0].query.filter.date_time_filter.created_at.start_at.endsWith('-01-01T08:00:00.000Z'));
  assert.equal(r.asked, 0);
  assert.equal((await s.get('?period=forever')).status, 400);
});

test('only the owner sees it', async () => {
  const s = setup([[order('A1', 'google')]]);
  assert.equal((await s.get('?period=all', 'someone@example.com')).status, 403);
  assert.equal(s.searches.length, 0);
});
