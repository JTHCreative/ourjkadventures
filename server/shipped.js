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

import { SQUARE_VERSION, squareHost, squareConfigured } from './square.js';
import { readLinks, siteProducts, siteKeys } from './catalog.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml } from './email.js';
import { productNoun, productPath, emailImages } from './notify.js';

const OPEN_STEPS = ['PROPOSED', 'RESERVED', 'PREPARED'];
// Square moves a fulfillment along one step at a time: proposed, reserved, prepared, completed (= shipped)
const NEXT = { PROPOSED: 'RESERVED', RESERVED: 'PREPARED', PREPARED: 'COMPLETED' };

async function square(env, method, path, body, fetchFn) {
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
function shipmentOf(o) { return (o.fulfillments || []).find((f) => f.type === 'SHIPMENT') || null; }
function isPaid(o) { return !!(o.tenders && o.tenders.length) && o.state !== 'CANCELED'; }

// our own names and pictures for what's in the order: "large aussie pin" rather than Square's "Large Aussie Pin (Exclusive)"
async function namer(env, origin, fetchFn) {
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
function view(o, nameLine, origin) {
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
    preorder: meta.preorder === 'yes',
    expected: d.expected_shipped_at || '',
    items
  };
  order.preview = shippedEmail(order, 'TRACKING-NUMBER', origin);
  return order;
}

// paid website orders with a shipment that hasn't gone out, oldest first (first in, first out)
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
  return (data.orders || [])
    .filter((o) => isPaid(o) && shipmentOf(o) && OPEN_STEPS.includes(shipmentOf(o).state))
    .map((o) => view(o, nameLine, origin));
}

/* ---------- the email ---------- */
// Colors are the site's tokens written out (see itsHereEmail in server/notify.js): mail apps can't read css variables.
export function shippedEmail(order, tracking, origin) {
  const pictures = emailImages(origin);
  const link = trackingLink(tracking);
  const first = (order.name || '').trim().split(/\s+/)[0] || '';
  const a = order.address;
  const where = [order.name, a.line1, a.line2, a.city + ', ' + a.state + ' ' + a.zip].filter((x) => x && x.trim());
  const how = order.shipping ? 'usps ' + order.shipping : 'usps';
  // "your pins are packed" only when it's all pins; a board makes it "your order"
  const allPins = order.items.length > 0 && order.items.every((it) => / pin$/.test(it.name));
  const subject = order.gift ? 'your gift is on its way' : 'your order is on its way';
  const hello = order.gift ? 'hi there,' : first ? 'hi ' + first + ',' : 'hi there,';
  const lead = order.gift
    ? 'your gift is packed and on its way to ' + (order.name || 'them') + ' by ' + how + '. we tucked your note in on a card, written by hand, and left the receipt out of the box.'
    : allPins
      ? 'your pins are packed and on their way to you by ' + how + '. we hope they make you smile when you open the box!'
      : 'your order is packed and on its way to you by ' + how + '. we hope it makes you smile when you open the box!';
  const list = order.items.map((it) => (it.qty > 1 ? it.qty + ' × ' : '') + it.name);
  const text = subject + '\n\n' + hello + '\n\n' + lead + '\n\n' +
    'track it here: ' + link + '\n(usps tracking number ' + tracking + ')\n\n' +
    "what's inside:\n" + list.map((l) => '- ' + l).join('\n') + '\n\n' +
    'going to:\n' + where.join('\n') + '\n\n' +
    'order ' + order.number + '. anything look off? just reply to this email and we\'ll sort it out.\n\n' +
    'thank you for supporting our little shop.\njustin and kitty\nj+k adventures\nourjkadventures.com';

  const e = escapeHtml;
  const font = "Georgia,'EB Garamond','Times New Roman',serif";
  const p = (s, style) => '<p style="margin:0;' + (style || '') + '">' + s + '</p>';
  const rows = order.items.map((it) => {
    const pic = it.slug
      ? '<img src="' + e(pictures.product(it.slug)) + '" width="64" height="64" alt="" style="display:block;border:0;width:64px;height:64px;object-fit:contain">'
      : '';
    return '<tr>' +
      '<td width="76" style="padding:8px 12px 8px 0;vertical-align:middle">' + pic + '</td>' +
      '<td style="padding:8px 0;vertical-align:middle;font-family:' + font + ';font-size:18px;line-height:24px;color:#3a3532">' +
        '<a href="' + e(origin + it.path) + '" style="color:#3a3532;text-decoration:none">' + e(it.name) + '</a></td>' +
      '<td align="right" style="padding:8px 0;vertical-align:middle;font-family:' + font + ';font-size:17px;color:#6a645e">' + (it.qty > 1 ? '× ' + it.qty : '') + '</td>' +
    '</tr>';
  }).join('');
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>' + e(subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#efe6dd">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + e(lead) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#efe6dd"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#f9f9f7;border-radius:16px">' +
    '<tr><td style="padding:28px 24px 8px"><a href="' + e(origin) + '/" style="text-decoration:none"><img src="' + e(pictures.logo) +
      '" width="180" height="99" alt="j+k adventures" style="display:block;margin:0 auto;border:0;width:180px;height:auto"></a></td></tr>' +
    '<tr><td style="padding:16px 24px 0;font-family:' + font + ';color:#3a3532;text-align:center">' +
      p(e(subject) + '.', 'font-size:32px;line-height:38px') +
    '</td></tr>' +
    '<tr><td style="padding:16px 24px 0;font-family:' + font + ';font-size:18px;line-height:27px;color:#3a3532">' +
      p(e(hello)) + p(e(lead), 'margin-top:12px') +
    '</td></tr>' +
    '<tr><td align="center" style="padding:24px 24px 4px">' +
      '<a href="' + e(link) + '" style="display:inline-block;padding:14px 28px;background:#bf5249;color:#ffffff;font-family:' + font +
      ';font-size:18px;line-height:22px;text-decoration:none;border-radius:999px">track your package</a>' +
    '</td></tr>' +
    '<tr><td align="center" style="padding:4px 24px 0;font-family:' + font + ';font-size:15px;line-height:22px;color:#6a645e">' +
      'usps tracking number ' + e(tracking) + '</td></tr>' +
    '<tr><td style="padding:24px 24px 0">' +
      '<div style="border-top:1.5px solid #e2d8cd;padding-top:16px;font-family:' + font + ';font-size:16px;color:#6a645e">what\'s inside</div>' +
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 24px 0;font-family:' + font + ';font-size:17px;line-height:25px;color:#3a3532">' +
      '<div style="border-top:1.5px solid #e2d8cd;padding-top:16px;font-size:16px;color:#6a645e">going to</div>' +
      p(where.map(e).join('<br>'), 'margin-top:6px') +
    '</td></tr>' +
    '<tr><td style="padding:24px 24px 28px;font-family:' + font + ';font-size:17px;line-height:26px;color:#3a3532;text-align:center">' +
      p('thank you for supporting our little shop.') +
      p('justin and kitty<br>j+k adventures', 'margin-top:16px') +
    '</td></tr>' +
    '</table>' +
    '<p style="max-width:520px;margin:16px auto 0;font-family:' + font + ';font-size:13px;line-height:19px;color:#6a645e;text-align:center">' +
      'order ' + e(order.number) + '. anything look off? just reply to this email and we\'ll sort it out.</p>' +
    '</td></tr></table></body></html>';
  return { subject, text, html };
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
