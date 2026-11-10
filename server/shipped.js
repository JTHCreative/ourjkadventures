// j+k adventures: orders to ship, and the "your order is on its way" email.
//
// /admin lists the website's paid orders that haven't gone out yet (Square is the record: we ask it each time).
// The owner packs one, types the USPS tracking number and presses "mark shipped". Then, in this order:
//   1. the email goes to the buyer through Resend, with a tracking button. Its idempotency key includes the order
//      and the tracking number, so pressing again after a hiccup doesn't send it twice (Resend remembers for a day)
//   2. the order is marked shipped in Square, with the tracking number on the shipment
// Like writing the address on the parcel before handing it over the counter: if the counter hiccups, you hand
// the same parcel over again, you don't write a second one.
//
// Unlike server/square.js, this file writes to Square: it needs ORDERS_WRITE (a personal access token has it).

import { SQUARE_VERSION, squareHost, squareConfigured, squareMode } from './square.js';
import { configured as firebaseConfigured, firestoreList, firestoreSet, firestoreDelete } from './firebase.js';
import { readLinks, siteProducts, siteKeys } from './catalog.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml } from './email.js';
import { productNoun, productPath } from './notify.js';
import { emailPage, para, section, itemTable, TEXT_SIGNOFF } from './email-look.js';
import { readShopStates } from './interest.js';
import { shopToday, whenWords, prettyDate } from './preorder-words.js';
import { giftMessage } from './ship-to.js';

const OPEN_STEPS = ['PROPOSED', 'RESERVED', 'PREPARED'];
// Square moves a fulfillment along one step at a time: proposed, reserved, prepared, completed (= shipped)
const NEXT = { PROPOSED: 'RESERVED', RESERVED: 'PREPARED', PREPARED: 'COMPLETED' };

export async function square(env, method, path, body, fetchFn) {
  const res = await fetchFn(squareHost(env) + path, {
    method,
    headers: { Authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'Square-Version': SQUARE_VERSION, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data && data.errors && data.errors[0] && data.errors[0].code;
    const e = new Error('square ' + method + ' ' + path + ' ' + res.status + (code ? ' ' + code : ''));
    e.status = res.status;
    throw e;
  }
  return data;
}

// USPS tracking numbers: letters and digits, spaces dropped. "9400 1000 0000 0000 0000 00" -> "9400100000000000000000"
export function cleanTracking(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{8,40}$/.test(t) ? t : null;
}
export function trackingLink(t) { return 'https://tools.usps.com/go/TrackConfirmAction?tLabels=' + encodeURIComponent(t); }

// the order's shipment (the one checkout made), or null for booth sales and anything else
export function shipmentOf(o) { return (o.fulfillments || []).find((f) => f.type === 'SHIPMENT') || null; }
export function isPaid(o) { return !!(o.tenders && o.tenders.length) && o.state !== 'CANCELED'; }

// how much of an order has been refunded, in cents. refunds Square turned down don't count
export function refundedCents(o) {
  return (o.refunds || []).filter((r) => !['REJECTED', 'FAILED'].includes(r && r.status))
    .reduce((n, r) => n + (r.amount_money && Number.isInteger(r.amount_money.amount) ? r.amount_money.amount : 0), 0);
}
// refunded in full: as much as the order's total, or more (a refund can include the tip, which isn't in the total)
export function refundedAll(o) {
  const total = o.total_money && o.total_money.amount;
  return Number.isInteger(total) && total > 0 && refundedCents(o) >= total;
}
const anyRefund = (o) => (o.refunds || []).some((r) => !['REJECTED', 'FAILED'].includes(r && r.status));

// our own names and pictures for what's in the order: "large aussie pin" rather than Square's "Large Aussie Pin (Exclusive)"
export async function namer(env, origin, fetchFn) {
  const [links, products] = await Promise.all([readLinks(env, fetchFn), siteProducts(env, origin)]);
  const bySlug = Object.fromEntries((products.items || []).map((p) => [p.slug, p]));
  const byVariation = {};
  for (const k of siteKeys(products)) {
    const v = links[k.key];
    if (v && !byVariation[v]) byVariation[v] = { product: bySlug[k.slug], size: k.size };
  }
  return (line) => {
    const hit = byVariation[line.catalog_object_id];
    const qty = Number(line.quantity) || 1;
    if (!hit || !hit.product) return { name: String(line.name || 'item').toLowerCase(), qty, slug: null, path: '/shop' };
    return { name: (hit.size === 'large' ? 'large ' : '') + productNoun(hit.product), qty, slug: hit.product.slug, path: productPath(hit.product) };
  };
}

// one order as /admin shows it, with the email it would get
export function view(o, nameLine, origin, states) {
  const f = shipmentOf(o);
  const d = f.shipment_details || {};
  const r = d.recipient || {};
  const a = r.address || {};
  const meta = o.metadata || {};
  const items = (o.line_items || []).map(nameLine);
  const order = {
    id: o.id,
    number: o.id.slice(-6).toUpperCase(),
    date: o.closed_at || o.updated_at || o.created_at || '',
    version: o.version,
    name: r.display_name || '',
    email: r.email_address || '',
    address: { line1: a.address_line_1 || '', line2: a.address_line_2 || '', city: a.locality || '', state: a.administrative_district_level_1 || '', zip: a.postal_code || '' },
    shipping: d.shipping_type || '',
    note: d.shipping_note || '',
    gift: meta.gift === 'yes',
    giftNote: meta.gift === 'yes' ? giftMessage(o) : '',
    preorder: meta.preorder === 'yes',
    expected: d.expected_shipped_at || '',
    total: o.total_money && typeof o.total_money.amount === 'number' ? o.total_money.amount : null,
    // part of it refunded (one refunded in full isn't in this list): pack only what's still owed
    refunded: anyRefund(o),
    items
  };
  order.preview = shippedEmail(order, 'TRACKING-NUMBER', origin);
  // a pre-order whose date moved since it was paid for: the new date and the email that tells them
  const moved = states && order.preorder ? newShipDate(o, nameLine, states) : null;
  if (moved) order.moved = { ...moved, preview: movedEmail(order, moved, origin) };
  return order;
}

// paid website orders with a shipment that hasn't gone out, oldest first (first in, first out). one refunded in full
// isn't here: there's nothing to send, and it shows in the order history as refunded
export async function ordersToShip(env, origin, fetchFn = fetch) {
  const body = {
    location_ids: [env.SQUARE_LOCATION_ID],
    limit: 200,
    query: {
      filter: {
        state_filter: { states: ['OPEN'] },
        fulfillment_filter: { fulfillment_types: ['SHIPMENT'], fulfillment_states: OPEN_STEPS }
      },
      sort: { sort_field: 'CREATED_AT', sort_order: 'ASC' }
    }
  };
  const data = await square(env, 'POST', '/v2/orders/search', body, fetchFn);
  const nameLine = await namer(env, origin, fetchFn);
  const orders = (data.orders || []).filter((o) => isPaid(o) && shipmentOf(o) && OPEN_STEPS.includes(shipmentOf(o).state) && !refundedAll(o));
  // the pre-order switches and dates, to spot a pre-order whose date moved. unreadable: no flags, the list still shows
  let states = null;
  if (orders.some((o) => (o.metadata || {}).preorder === 'yes')) {
    try { states = await readShopStates(env, fetchFn); } catch (e) { console.log('orders: pre-order dates ' + e.message); }
  }
  return orders.map((o) => view(o, nameLine, origin, states));
}

/* ---------- order history: website orders already shipped, and ones refunded in full before they shipped ---------- */
// one shipped order as the history shows it: what went, to whom, when, and its tracking number. no email preview
export function pastView(o, nameLine) {
  const f = shipmentOf(o);
  const d = f.shipment_details || {};
  const r = d.recipient || {};
  const a = r.address || {};
  const meta = o.metadata || {};
  return {
    id: o.id,
    number: o.id.slice(-6).toUpperCase(),
    date: o.created_at || '',
    shippedAt: d.shipped_at || o.closed_at || '',
    name: r.display_name || '',
    email: r.email_address || '',
    address: { line1: a.address_line_1 || '', line2: a.address_line_2 || '', city: a.locality || '', state: a.administrative_district_level_1 || '', zip: a.postal_code || '' },
    shipping: d.shipping_type || '',
    tracking: cleanTracking(d.tracking_number) || '',
    gift: meta.gift === 'yes',
    giftNote: meta.gift === 'yes' ? giftMessage(o) : '',
    preorder: meta.preorder === 'yes',
    shipped: f.state === 'COMPLETED',
    // any refund at all, and whether it was the whole order
    refunded: anyRefund(o),
    refundedAll: refundedAll(o),
    total: o.total_money && typeof o.total_money.amount === 'number' ? o.total_money.amount : null,
    items: (o.line_items || []).map(nameLine)
  };
}

// paid website orders whose shipment has gone out, or that were refunded in full before it did, newest first, a page
// at a time. read from Square each time
// (nothing is kept in Firestore); `cursor` is Square's own bookmark for the next page
export const HISTORY_PAGE = 20;
export async function orderHistory(env, origin, cursor, fetchFn = fetch) {
  const body = {
    location_ids: [env.SQUARE_LOCATION_ID],
    limit: HISTORY_PAGE,
    query: {
      filter: {
        state_filter: { states: ['OPEN', 'COMPLETED'] },
        fulfillment_filter: { fulfillment_types: ['SHIPMENT'], fulfillment_states: [...OPEN_STEPS, 'COMPLETED'] }
      },
      sort: { sort_field: 'CREATED_AT', sort_order: 'DESC' }
    }
  };
  if (cursor) body.cursor = cursor;
  const [data, hidden] = await Promise.all([square(env, 'POST', '/v2/orders/search', body, fetchFn), hiddenOrderIds(env, fetchFn)]);
  const nameLine = await namer(env, origin, fetchFn);
  const orders = (data.orders || []).filter((o) => isPaid(o) && shipmentOf(o) && (shipmentOf(o).state === 'COMPLETED' || refundedAll(o)) && !hidden.has(o.id));
  return { orders: orders.map((o) => pastView(o, nameLine)), cursor: data.cursor || null };
}

/* ---------- orders taken out of the history (/admin only) ---------- */
// Square won't delete a paid order (it's part of the sales and tax records), so "remove from history" only hides it
// on /admin, like crossing a page out of a receipt book rather than tearing it out. Firestore hidden_orders_<mode>/<id>
// keeps just the order id and when, nothing about the buyer. the order stays in Square and its reports
const hiddenCollection = (env) => 'hidden_orders_' + squareMode(env);
const ORDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
export const HIDDEN_MAX = 300;

// the ids hidden from the history. unreadable (or no Firestore): nothing is hidden, the history still shows
export async function hiddenOrderIds(env, fetchFn = fetch) {
  if (!firebaseConfigured(env)) return new Set();
  try { return new Set((await firestoreList(env, hiddenCollection(env), HIDDEN_MAX, fetchFn)).map((d) => d.id)); } catch (e) {
    console.log('hidden orders: ' + e.message);
    return new Set();
  }
}

// hide one (hidden: true) or put it back (false). { ok } or { error, status }
export async function hideOrder(env, id, hidden, fetchFn = fetch) {
  if (typeof id !== 'string' || !ORDER_ID.test(id) || typeof hidden !== 'boolean') return { error: 'bad request', status: 400 };
  if (!firebaseConfigured(env)) return { error: 'not configured', status: 503 };
  if (hidden) await firestoreSet(env, hiddenCollection(env) + '/' + id, { createdAt: new Date() }, fetchFn);
  else await firestoreDelete(env, hiddenCollection(env) + '/' + id, fetchFn);
  return { ok: true };
}

// the hidden ones, read from Square as the history shows them, newest first
export async function hiddenHistory(env, origin, fetchFn = fetch) {
  const ids = [...(await hiddenOrderIds(env, fetchFn))];
  if (!ids.length) return [];
  const found = [];
  for (let i = 0; i < ids.length; i += 100) {
    const data = await square(env, 'POST', '/v2/orders/batch-retrieve', { location_id: env.SQUARE_LOCATION_ID, order_ids: ids.slice(i, i + 100) }, fetchFn);
    found.push(...(data.orders || []));
  }
  const nameLine = await namer(env, origin, fetchFn);
  return found.filter((o) => shipmentOf(o)).map((o) => pastView(o, nameLine))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

/* ---------- the email ---------- */
// "pup person" -> "hi pup,". a gift's name is the person it's going to, so a gift says "hi there,"
export function hello(order) {
  const first = (order.name || '').trim().split(/\s+/)[0] || '';
  return order.gift || !first ? 'hi there,' : 'hi ' + first + ',';
}
export function whereLines(order) {
  const a = order.address;
  return [order.name, a.line1, a.line2, a.city + ', ' + a.state + ' ' + a.zip].filter((x) => x && x.trim());
}
export function itemLines(order) { return order.items.map((it) => (it.qty > 1 ? it.qty + ' × ' : '') + it.name); }
// the footer every order email shares
export function orderFooter(order) { return 'order ' + order.number + ". anything look off? just reply to this email and we'll sort it out."; }

export function shippedEmail(order, tracking, origin) {
  const link = trackingLink(tracking);
  const where = whereLines(order);
  const how = order.shipping ? 'usps ' + order.shipping : 'usps';
  // "your pins are packed" only when it's all pins; a board makes it "your order"
  const allPins = order.items.length > 0 && order.items.every((it) => / pin$/.test(it.name));
  const subject = order.gift ? 'your gift is on its way' : 'your order is on its way';
  const hi = hello(order);
  const lead = order.gift
    ? 'your gift is packed and on its way to ' + (order.name || 'them') + ' by ' + how + '. we tucked your note in on a card, written by hand, and left the receipt out of the box.'
    : allPins
      ? 'your pins are packed and on their way to you by ' + how + '. we hope they make you smile when you open the box!'
      : 'your order is packed and on its way to you by ' + how + '. we hope it makes you smile when you open the box!';
  const text = subject + '\n\n' + hi + '\n\n' + lead + '\n\n' +
    'track it here: ' + link + '\n(usps tracking number ' + tracking + ')\n\n' +
    "what's inside:\n" + itemLines(order).map((l) => '- ' + l).join('\n') + '\n\n' +
    'going to:\n' + where.join('\n') + '\n\n' +
    orderFooter(order) + '\n\n' +
    'thank you for supporting our little shop.\n' + TEXT_SIGNOFF;
  const e = escapeHtml;
  const html = emailPage({
    origin, title: subject + '.', preheader: lead,
    body: [para(e(hi)), para(e(lead))],
    button: { href: link, label: 'track your package' },
    small: 'usps tracking number ' + e(tracking),
    sections: [section("what's inside", itemTable(order.items, origin)), section('going to', where.map(e).join('<br>'))],
    signoff: para('thank you for supporting our little shop.') + para('justin and kitty<br>j+k adventures', 'margin-top:16px'),
    footer: e(orderFooter(order))
  });
  return { subject, text, html };
}

/* ---------- a pre-order's date moved ---------- */
// A paid order with a pre-order in it was told "ships together around <date>" (its expected ship date in Square).
// If the owner later moves a pin's date on /admin, that order's date is out of step: /admin flags it in "orders to
// ship" with the email to send, and pressing the button emails the buyer and moves the date on the Square order.
// Like a note on the fridge: we only rewrite it once we've told the people who read it.
//
// The pre-order pins in an order are the lines checkout wrote a "pre-order." note on. The new date is the latest
// date among those that are still on pre-order (one that has arrived since no longer holds the order up).
export function newShipDate(o, nameLine, states) {
  const pre = (o.line_items || []).filter((l) => /^pre-order\b/.test(l.note || ''));
  const waitingFor = pre.map(nameLine).filter((it) => it.slug && states.preorder[it.slug] && states.dates[it.slug]);
  if (!waitingFor.length) return null;
  const to = waitingFor.map((it) => states.dates[it.slug]).sort().pop();
  const from = ((shipmentOf(o).shipment_details || {}).expected_shipped_at || '').slice(0, 10);
  if (!from || to === from) return null;
  return { from, to, pins: [...new Set(waitingFor.map((it) => it.name.replace(/^large /, '')))] };
}

export function movedEmail(order, moved, origin) {
  const today = shopToday();
  const later = moved.to > moved.from;
  const names = moved.pins.length ? listWords(moved.pins.map((n) => 'the ' + n)) : 'your pre-order';
  const subject = 'a new date for your pre-order';
  const hi = hello(order);
  const lead = later
    ? names + (moved.pins.length > 1 ? ' are' : ' is') + ' taking a little longer than we planned, so your order now ships together ' +
      whenWords(moved.to, today) + ' (we said ' + prettyDate(moved.from, today) + ' before). we\'re sorry for the wait, and thank you for your patience.'
    : 'good news: ' + names + (moved.pins.length > 1 ? ' are' : ' is') + ' coming along sooner than we thought, so your order now ships together ' +
      whenWords(moved.to, today) + ' (we said ' + prettyDate(moved.from, today) + ' before).';
  const after = later
    ? "we'll email you again the day it's on its way. if you'd rather not wait, just reply and we'll sort it out."
    : "we'll email you again the day it's on its way.";
  const text = subject + '\n\n' + hi + '\n\n' + lead + '\n\n' + after + '\n\n' +
    "what's in your order:\n" + itemLines(order).map((l) => '- ' + l).join('\n') + '\n\n' +
    orderFooter(order) + '\n\n' + TEXT_SIGNOFF;
  const e = escapeHtml;
  const html = emailPage({
    origin, title: subject + '.', preheader: 'your order now ships together ' + whenWords(moved.to, today) + '.',
    body: [para(e(hi)), para(e(lead)), para(e(after))],
    sections: [section("what's in your order", itemTable(order.items, origin))],
    footer: e(orderFooter(order))
  });
  return { subject, text, html };
}
// "the corgi pin", "the corgi pin and the pug pin", "a, b and c"
function listWords(xs) { return xs.length < 2 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1]; }

// { ok, emailed, date } or { error, status }
export async function sendMoved(env, origin, orderId, fetchFn = fetch) {
  if (!squareConfigured(env)) return { error: 'square not set up', status: 503 };
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { error: 'bad order', status: 400 };
  const o = (await square(env, 'GET', '/v2/orders/' + orderId, null, fetchFn)).order;
  const f = o && shipmentOf(o);
  if (!o || o.location_id !== env.SQUARE_LOCATION_ID || !f || !isPaid(o)) return { error: 'not a paid website order', status: 404 };
  if (!OPEN_STEPS.includes(f.state)) return { error: 'already shipped', status: 409 };
  const nameLine = await namer(env, origin, fetchFn);
  const moved = newShipDate(o, nameLine, await readShopStates(env, fetchFn));
  if (!moved) return { error: 'not moved', status: 409 };

  // 1. the email, once per order and new date however many times this is pressed
  let emailed = false;
  const order = view(o, nameLine, origin);
  if (emailConfigured(env) && order.email) {
    if ((await emailsLeftToday(env, fetchFn)) < 1) return { error: 'email limit', status: 429 };
    const m = movedEmail(order, moved, origin);
    await sendBatch(env, [{ to: order.email, subject: m.subject, text: m.text, html: m.html }], 'moved-' + orderId + '-' + moved.to, fetchFn);
    emailed = true;
  }
  // 2. Square: the order's expected ship date, and the words in its shipping note
  const note = (f.shipment_details || {}).shipping_note || '';
  const newNote = note.replace(/(pre-order: the whole order ships together )around [a-z]+ \d+(, \d{4})?/, '$1' + whenWords(moved.to));
  await square(env, 'PUT', '/v2/orders/' + orderId, {
    idempotency_key: 'moved-' + orderId + '-' + moved.to,
    order: {
      location_id: o.location_id,
      version: o.version,
      fulfillments: [{ uid: f.uid, shipment_details: { expected_shipped_at: moved.to + 'T17:00:00Z', ...(newNote !== note ? { shipping_note: newNote } : {}) } }]
    }
  }, fetchFn);
  return { ok: true, emailed, date: moved.to };
}

/* ---------- mark shipped ---------- */
// { ok, emailed } or { error, status }
export async function markShipped(env, origin, orderId, rawTracking, fetchFn = fetch) {
  if (!squareConfigured(env)) return { error: 'square not set up', status: 503 };
  if (typeof orderId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(orderId)) return { error: 'bad order', status: 400 };
  const tracking = cleanTracking(rawTracking);
  if (!tracking) return { error: 'tracking', status: 400 };

  let o = (await square(env, 'GET', '/v2/orders/' + orderId, null, fetchFn)).order;
  const f = o && shipmentOf(o);
  if (!o || o.location_id !== env.SQUARE_LOCATION_ID || !f || !isPaid(o)) return { error: 'not a paid website order', status: 404 };
  if (!OPEN_STEPS.includes(f.state)) return { error: 'already shipped', status: 409 };

  // 1. the email, sent once per order and tracking number however many times this is pressed
  let emailed = false;
  const nameLine = await namer(env, origin, fetchFn);
  const order = view(o, nameLine, origin);
  if (emailConfigured(env) && order.email) {
    if ((await emailsLeftToday(env, fetchFn)) < 1) return { error: 'email limit', status: 429 };
    const m = shippedEmail(order, tracking, origin);
    await sendBatch(env, [{ to: order.email, subject: m.subject, text: m.text, html: m.html }], 'shipped-' + orderId + '-' + tracking, fetchFn);
    emailed = true;
  }

  // 2. Square: step the shipment along to completed, with the tracking number on it
  let state = f.state;
  while (state !== 'COMPLETED') {
    const next = NEXT[state];
    const done = next === 'COMPLETED';
    const res = await square(env, 'PUT', '/v2/orders/' + orderId, {
      idempotency_key: 'ship-' + orderId + '-' + next + '-' + tracking,
      order: {
        location_id: o.location_id,
        version: o.version,
        fulfillments: [{
          uid: f.uid,
          state: next,
          ...(done ? { shipment_details: { carrier: 'USPS', tracking_number: tracking, tracking_url: trackingLink(tracking), shipped_at: new Date().toISOString() } } : {})
        }]
      }
    }, fetchFn);
    o = res.order;
    state = next;
  }
  return { ok: true, emailed, tracking };
}
