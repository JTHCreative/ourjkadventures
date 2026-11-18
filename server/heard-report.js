// j+k adventures: "where buyers come from" on /admin.
//
// Checkout asks "how did you hear about us?" and tags the answer on the Square order (metadata heard_from, see
// server/heard-from.js). This adds those tags up for a stretch of time: orders and money paid per answer, a count per
// month, and one row per order for a spreadsheet. Like tipping out the jar of "how did you find us?" slips at the end of
// a fair and sorting them into piles. Read from Square each time: nothing is kept in Firestore.
//
// Only website orders count (they're the ones with a shipment; booth sales aren't asked). An unpaid or canceled order
// doesn't count, one refunded in full doesn't count, and a partial refund comes off what was paid.

import { HEARD_FROM } from './heard-from.js';
import { square, isPaid, shipmentOf, refundedAll, refundedCents } from './shipped.js';

export const PERIODS = ['30d', '90d', 'year', 'all'];
const ZONE = 'America/Los_Angeles';
const PAGE = 500;
// at most this many pages of orders (10,000 orders). more than that and the report says it's partial
const MAX_PAGES = 20;

// when a period starts, as an ISO time, or null for all time. "this year" starts at midnight on january 1 in
// california, which is always 08:00 UTC (january is standard time)
export function periodStart(period, now = new Date()) {
  if (period === '30d' || period === '90d') return new Date(now.getTime() - parseInt(period, 10) * 86400000).toISOString();
  if (period === 'year') return now.toLocaleDateString('en-CA', { timeZone: ZONE }).slice(0, 4) + '-01-01T08:00:00.000Z';
  return null;
}
// "2026-11", in california's calendar, so an order at 8pm on october 31 counts in october
const monthOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE }).slice(0, 7);
const dayOf = (iso) => new Date(iso).toLocaleDateString('en-CA', { timeZone: ZONE });

export async function heardReport(env, period, fetchFn = fetch, now = new Date()) {
  const start = periodStart(period, now);
  const filter = {
    state_filter: { states: ['OPEN', 'COMPLETED'] },
    fulfillment_filter: { fulfillment_types: ['SHIPMENT'] }
  };
  if (start) filter.date_time_filter = { created_at: { start_at: start } };

  const orders = [];
  let cursor = null;
  let pages = 0;
  do {
    const body = { location_ids: [env.SQUARE_LOCATION_ID], limit: PAGE, query: { filter, sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' } } };
    if (cursor) body.cursor = cursor;
    const data = await square(env, 'POST', '/v2/orders/search', body, fetchFn);
    orders.push(...(data.orders || []));
    cursor = data.cursor || null;
    pages += 1;
  } while (cursor && pages < MAX_PAGES);

  // a pile per answer on today's list, in the list's order. an answer no longer on the list (a choice taken off
  // later) still gets its own pile, named by its id
  const piles = new Map(HEARD_FROM.map((h) => [h.id, { id: h.id, label: h.label, orders: 0, cents: 0 }]));
  const unasked = { orders: 0, cents: 0 };
  const months = new Map();
  const rows = [];
  for (const o of orders) {
    if (!isPaid(o) || !shipmentOf(o) || refundedAll(o) || !o.created_at) continue;
    const total = o.total_money && Number.isInteger(o.total_money.amount) ? o.total_money.amount : 0;
    const cents = Math.max(0, total - refundedCents(o));
    const id = typeof (o.metadata || {}).heard_from === 'string' ? o.metadata.heard_from : '';
    if (id && !piles.has(id)) piles.set(id, { id, label: id, orders: 0, cents: 0 });
    const pile = id ? piles.get(id) : unasked;
    pile.orders += 1;
    pile.cents += cents;
    const m = monthOf(o.created_at);
    if (!months.has(m)) months.set(m, { month: m, counts: {}, unasked: 0 });
    if (id) months.get(m).counts[id] = (months.get(m).counts[id] || 0) + 1;
    else months.get(m).unasked += 1;
    rows.push({ date: dayOf(o.created_at), number: o.id.slice(-6).toUpperCase(), heard: id ? piles.get(id).label : '', cents });
  }
  const sources = [...piles.values()];
  return {
    period,
    from: start,
    sources,
    asked: sources.reduce((n, s) => n + s.orders, 0),
    unasked,
    // newest month first, like the rows
    months: [...months.values()].sort((a, b) => (a.month < b.month ? 1 : -1)),
    rows,
    partial: !!cursor
  };
}
