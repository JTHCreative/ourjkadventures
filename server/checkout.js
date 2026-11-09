// j+k adventures: checkout. Three ways in, all built on the same order, put together here from our own catalog:
//
//   POST /api/checkout/quote  the checkout page's order summary: each line, shipping, Square's sales tax, the tip
//                             and the total. no address needed: tax is each item's own (the booth's), not by state
//   POST /api/checkout/pay    the checkout page's "pay" button: the card (or Apple Pay / Google Pay) was turned
//                             into a one-time token by Square's own form in the browser (the Web Payments SDK), so
//                             no card number ever reaches us. we make the Square order and charge the token for it
//   POST /api/checkout        Square's hosted payment page (a payment link), kept as the fallback while the
//                             embedded form isn't set up (SQUARE_APPLICATION_ID missing)
//
// Like a till where the customer only says what they want and which shipping: the till looks up every price itself.
// The browser sends keys ("aussie", "aussie:large"), quantities, a shipping choice, the address, a gift note and a
// tip choice. Prices come from Square, shipping from products.json, tax from Square. A tip is the buyer's own choice
// on top (5, 10 or 15 percent of the items, or an amount of their own, at most TIP_MAX_CENTS); percentages are
// worked out here from Square's prices. Never a discount: nothing here takes anything off.

import { noteOrder } from './account.js';
import { configured as firebaseConfigured, userFromRequest } from './firebase.js';
import { getCatalog, shippingCharge } from './catalog.js';
import { stockCounts, squareHost, SQUARE_VERSION } from './square.js';
import { cleanShipTo, cleanGift, squareAddress, addressLine, noteGift } from './ship-to.js';
import { shopToday, whenWords } from './preorder-words.js';

const MAX_LINES = 30;
const MAX_QTY = 20;
export const TIP_PERCENTS = [5, 10, 15];
export const TIP_MAX_CENTS = 10000;

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export async function checkoutRoute(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return json({ error: 'not configured' }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad request' }, 400);
  if (url.pathname === '/api/checkout/quote') return quote(request, env, url, body);
  if (url.pathname === '/api/checkout/pay') return pay(request, env, url, body);
  return paymentLink(request, env, url, body);
}

async function square(env, path, body) {
  let res;
  try {
    res = await fetch(squareHost(env) + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (e) {
    return { ok: false, status: 0, data: {} };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// the tip: none, one of the three percentages of the items, or an amount of their own in cents
export function cleanTip(raw, itemsCents) {
  if (raw === undefined || raw === null || raw === 0) return { cents: 0 };
  if (typeof raw !== 'object') return { error: 'tip' };
  if (raw.percent !== undefined) {
    if (!TIP_PERCENTS.includes(raw.percent)) return { error: 'tip' };
    return { cents: Math.round(itemsCents * raw.percent / 100), percent: raw.percent };
  }
  const c = raw.cents;
  if (!Number.isInteger(c) || c < 0 || c > TIP_MAX_CENTS) return { error: 'tip' };
  return { cents: c };
}

// Everything every checkout shares: read the items, the shelf, shipping, the address and the gift, and put the
// Square order together. addressNeeded: false for the quote (the summary shows before the address is typed).
// Returns { res } (an answer to send back now) or the pieces of the order.
async function prepare(request, env, url, body, addressNeeded) {
  const wanted = Array.isArray(body.items) ? body.items : [];
  if (!wanted.length || wanted.length > MAX_LINES) return { res: json({ error: 'bad items' }, 400) };

  // which Square item each key is, and its price, come from our own catalog (server/catalog.js), never the browser
  let catalog;
  try { catalog = await getCatalog(env, url); } catch (e) { return { res: json({ error: 'catalog' }, 500) }; }
  // the open sign (settings/shop in Firestore, flipped on /admin). closed, or unreadable, means nobody checks out
  if (!catalog.open) return { res: json({ error: 'shop closed' }, 403) };

  // the shipping choice: the browser names one (ground, priority, express), the price is ours (products.json).
  // no choice at all (a bag opened before the choice existed) means the first one, ground
  const shipOptions = catalog.shipping || [];
  if (!shipOptions.length) return { res: json({ error: 'shipping' }, 500) };
  const shipId = body.shipping === undefined ? shipOptions[0].id : body.shipping;
  const ship = shipOptions.find((o) => o.id === shipId);
  if (!ship) return { res: json({ error: 'bad shipping' }, 400) };

  // where it goes: u.s. states and d.c. only, checked here (server/ship-to.js), never trusted from the browser.
  // the field tells the page which box needs another look
  let address = null;
  if (addressNeeded) {
    const shipTo = cleanShipTo(body.ship_to);
    if (!shipTo.ok) return { res: json({ error: 'address', field: shipTo.field, reason: shipTo.error }, 400) };
    address = shipTo.value;
  }
  // a gift: a short note we write by hand on a card. null when it isn't one
  const gift = addressNeeded ? cleanGift(body.gift) : null;
  if (gift && gift.error) return { res: json({ error: 'gift', reason: gift.error }, 400) };

  const qtyByKey = {};
  for (const w of wanted) {
    const key = w && w.key;
    const qty = Math.floor(Number(w && w.qty));
    if (typeof key !== 'string' || !catalog.byKey[key] || !(qty >= 1) || qty > MAX_QTY) return { res: json({ error: 'bad item' }, 400) };
    qtyByKey[key] = (qtyByKey[key] || 0) + qty;
    if (qtyByKey[key] > MAX_QTY) return { res: json({ error: 'bad item' }, 400) };
  }

  // a fresh look at the shelf, not the one-minute-old list, so we never sell what the booth just sold.
  // pre-order pins aren't on the shelf yet: they're limited only by how many one order may hold (MAX_QTY)
  const keys = Object.keys(qtyByKey);
  const preorderKeys = keys.filter((k) => catalog.byKey[k].preorder);
  const shelfKeys = keys.filter((k) => !catalog.byKey[k].preorder);
  let onShelf = {};
  if (shelfKeys.length) {
    try { onShelf = await stockCounts(env, shelfKeys.map((k) => catalog.byKey[k].variation_id)); } catch (e) {
      console.log('stock check failed', e.message);
      return { res: json({ error: 'square unreachable' }, 502) };
    }
  }
  // the "sold out" tick in the Square dashboard counts as none on the shelf
  const left = (k) => (catalog.byKey[k].preorder ? MAX_QTY : catalog.byKey[k].marked_sold_out ? 0 : onShelf[catalog.byKey[k].variation_id] || 0);
  const short = keys.filter((k) => qtyByKey[k] > left(k));
  if (short.length) return { res: json({ error: 'stock', items: short.map((k) => ({ key: k, stock: left(k) })) }, 409) };

  // a pre-order in the bag: the whole order waits and ships together once the last pre-order pin arrives, around
  // the latest of their dates. a pin is only on sale as a pre-order with its date, so every one has one
  const today = shopToday();
  const dateOf = (k) => catalog.items.find((p) => p.slug === catalog.byKey[k].slug).preorder_date;
  const pinWords = (k) => 'pre-order. expected to ship ' + whenWords(dateOf(k), today);
  const shipDate = preorderKeys.length ? preorderKeys.map(dateOf).sort().pop() : null;
  const preorderWords = preorderKeys.length ? 'pre-order: the whole order ships together ' + whenWords(shipDate, today) : '';

  // pointing at the Square item (not typing a name and price) is what lets Square lower the stock count
  const lines = keys.map((k) => ({
    uid: k, catalog_object_id: catalog.byKey[k].variation_id, quantity: String(qtyByKey[k]),
    ...(catalog.byKey[k].preorder ? { note: pinWords(k) } : {})
  }));
  const currency = catalog.currency;
  const itemsCents = keys.reduce((n, k) => n + catalog.byKey[k].price_cents * qtyByKey[k], 0);

  const shipWords = ship.name + ' shipping' + (ship.days ? ' (' + ship.days + ')' : '');
  const giftWords = gift ? (gift.message ? 'gift. write on the card: "' + gift.message + '"' : 'gift. blank card, no note') : '';
  const order = { location_id: env.SQUARE_LOCATION_ID, line_items: lines };
  // the address rides on the order itself, so it shows in the Square dashboard with the order and its buyer
  if (address) {
    order.fulfillments = [{
      type: 'SHIPMENT',
      state: 'PROPOSED',
      shipment_details: {
        recipient: { display_name: address.name, email_address: address.email, address: squareAddress(address) },
        carrier: 'USPS',
        shipping_type: ship.name,
        ...(shipDate ? { expected_shipped_at: shipDate + 'T17:00:00Z' } : {}),
        ...(gift || preorderKeys.length ? { shipping_note: [preorderWords, giftWords].filter(Boolean).join(' / ') } : {})
      }
    }];
  }
  // the card note rides on the order itself, where /admin reads it (our own gift record keeps no personal details)
  if (gift) order.metadata = { gift: 'yes', ...(gift.message ? { gift_note: gift.message } : {}) };
  if (preorderKeys.length) order.metadata = { ...(order.metadata || {}), preorder: 'yes' };
  // sales tax: Square applies each item's own tax, the same one the booth uses (today "Millbrae Sales Tax"), so
  // web and booth sales sit under one tax in Square's reports and the rate lives in one place. the shipping line
  // is marked not taxable. (TAX_PERCENT in Cloudflare is no longer read: setting it can't add tax twice)
  order.pricing_options = { auto_apply_taxes: true };

  // the shipping price is a line on the order itself (a "service charge"), not Square's shipping_fee option: see
  // docs/decisions.md. Not taxed. free ground (pins over $40): no line, and a note on the payment says how to send it
  const charge = shippingCharge(ship, keys.map((k) => ({ kind: catalog.byKey[k].kind, price_cents: catalog.byKey[k].price_cents, qty: qtyByKey[k] })));
  const notes = [];
  if (preorderKeys.length) notes.push(preorderWords);
  if (charge.free) {
    notes.push('free ' + shipWords);
  } else {
    order.service_charges = [{
      uid: 'shipping', name: shipWords, amount_money: { amount: charge.cents, currency: currency },
      calculation_phase: 'TOTAL_PHASE', taxable: false
    }];
  }
  // the payment note shows on the payment in the Square dashboard: a gift says so, with where it goes
  if (gift) notes.push(giftWords + ' ship to: ' + addressLine(address));

  return {
    catalog, keys, qtyByKey, order, address, gift, ship, charge, shipDate, currency, itemsCents,
    // Square takes at most 500 characters here; the full note and address are on the shipment too
    paymentNote: notes.length ? notes.join(' / ').slice(0, 500) : null
  };
}

// a signed-in buyer: their account, so the order can go on their order history. a missing or bad ticket just
// means a signed-out checkout
async function buyerOf(request, env) {
  if (!firebaseConfigured(env)) return null;
  try { return await userFromRequest(request, env); } catch (e) { return null; }
}

// after an order is made: the signed-in buyer's order history and the owner's list of cards to write.
// neither ever blocks checkout: the order and its notes are in Square either way
async function afterOrder(env, buyer, gift, orderId) {
  if (buyer && orderId) {
    try { await noteOrder(env, buyer.sub, orderId); } catch (e) { console.log('order note failed', e.message); }
  }
  if (gift && orderId && firebaseConfigured(env)) {
    try { await noteGift(env, orderId, fetch); } catch (e) { console.log('gift note failed', e.message); }
  }
}

function thankYou(url, shipDate) {
  return url.origin + '/thank-you.html' + (shipDate ? '?preorder=' + shipDate : '');
}

const amountOf = (m) => (m && Number.isInteger(m.amount) ? m.amount : 0);

/* ---------- the order summary ---------- */

async function quote(request, env, url, body) {
  const p = await prepare(request, env, url, body, false);
  if (p.res) return p.res;
  const tip = cleanTip(body.tip, p.itemsCents);
  if (tip.error) return json({ error: 'tip' }, 400);
  // Square works the order out exactly as it will charge it, tax and all, without making it
  const r = await square(env, '/v2/orders/calculate', { order: p.order });
  const o = r.data && r.data.order;
  if (!r.ok || !o) {
    console.log('square calculate error', r.status, JSON.stringify(r.data && r.data.errors));
    return json({ error: 'square' }, 502);
  }
  const byUid = {};
  (o.line_items || []).forEach((l) => { byUid[l.uid] = l; });
  const lines = p.keys.map((k) => ({
    key: k, qty: p.qtyByKey[k],
    cents: byUid[k] ? amountOf(byUid[k].gross_sales_money) || amountOf(byUid[k].base_price_money) * p.qtyByKey[k] : p.catalog.byKey[k].price_cents * p.qtyByKey[k]
  }));
  const total = amountOf(o.total_money);
  return json({
    currency: p.currency,
    lines,
    items_cents: lines.reduce((n, l) => n + l.cents, 0),
    shipping: { id: p.ship.id, cents: p.charge.cents, free: p.charge.free },
    tax_cents: amountOf(o.total_tax_money),
    tip_cents: tip.cents,
    total_cents: total + tip.cents,
    ...(p.shipDate ? { preorder_date: p.shipDate } : {})
  });
}

/* ---------- paying on our own page ---------- */

async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// what a card problem means for the buyer: the page has the words. anything we don't know is "declined"
const CARD_PROBLEMS = {
  CVV_FAILURE: 'cvv', VERIFY_CVV_FAILURE: 'cvv', INVALID_EXPIRATION: 'expiry', INVALID_EXPIRATION_DATE: 'expiry',
  ADDRESS_VERIFICATION_FAILURE: 'zip', VERIFY_AVS_FAILURE: 'zip', INVALID_POSTAL_CODE: 'zip',
  INSUFFICIENT_FUNDS: 'funds', CARD_EXPIRED: 'expiry', INVALID_CARD: 'card', INVALID_CARD_DATA: 'card',
  CARD_NOT_SUPPORTED: 'card', CARD_DECLINED_VERIFICATION_REQUIRED: 'verify'
};

async function pay(request, env, url, body) {
  if (!env.SQUARE_APPLICATION_ID) return json({ error: 'not configured' }, 503);
  const source = body.source_id;
  if (typeof source !== 'string' || !source || source.length > 500) return json({ error: 'payment' }, 400);
  // one "pay" press: the page keeps the same id while it retries after a dropped connection, so a second press
  // can't make a second order or charge twice. a fresh one after a declined card
  const attempt = body.attempt;
  if (typeof attempt !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(attempt)) return json({ error: 'bad request' }, 400);

  const p = await prepare(request, env, url, body, true);
  if (p.res) return p.res;
  const tip = cleanTip(body.tip, p.itemsCents);
  if (tip.error) return json({ error: 'tip' }, 400);
  const buyer = await buyerOf(request, env);
  if (buyer) p.order.metadata = { ...(p.order.metadata || {}), uid: buyer.sub };
  if (tip.cents) p.order.metadata = { ...(p.order.metadata || {}), tip: String(tip.cents) };

  const made = await square(env, '/v2/orders', {
    idempotency_key: 'jka-' + (await sha(attempt + JSON.stringify(p.order))),
    order: p.order
  });
  const order = made.data && made.data.order;
  if (!made.ok || !order || !order.id) {
    console.log('square order error', made.status, JSON.stringify(made.data && made.data.errors));
    return json({ error: 'square' }, 502);
  }
  const total = amountOf(order.total_money);
  if (!(total > 0)) return json({ error: 'square' }, 502);

  const paid = await square(env, '/v2/payments', {
    // Square allows at most 45 characters here
    idempotency_key: (await sha(attempt + '|' + source + '|' + order.id + '|' + tip.cents)).slice(0, 44),
    source_id: source,
    order_id: order.id,
    location_id: env.SQUARE_LOCATION_ID,
    // the order's own total, as Square worked it out; the tip goes on top of it
    amount_money: { amount: total, currency: p.currency },
    ...(tip.cents ? { tip_money: { amount: tip.cents, currency: p.currency } } : {}),
    autocomplete: true,
    buyer_email_address: p.address.email,
    shipping_address: squareAddress(p.address),
    ...(p.paymentNote ? { note: p.paymentNote } : {})
  });
  const payment = paid.data && paid.data.payment;
  if (!paid.ok || !payment || !['COMPLETED', 'APPROVED'].includes(payment.status)) {
    const codes = ((paid.data && paid.data.errors) || []).map((e) => e && e.code).filter(Boolean);
    console.log('square payment error', paid.status, codes.join(','));
    if (paid.status >= 400 && paid.status < 500 && paid.status !== 401 && paid.status !== 429) {
      const reason = codes.map((c) => CARD_PROBLEMS[c]).find(Boolean) || 'declined';
      return json({ error: 'declined', reason }, 402);
    }
    return json({ error: 'square' }, 502);
  }
  await afterOrder(env, buyer, p.gift, order.id);
  return json({ ok: true, url: thankYou(url, p.shipDate) });
}

/* ---------- Square's hosted payment page (the fallback) ---------- */

async function paymentLink(request, env, url, body) {
  const p = await prepare(request, env, url, body, true);
  if (p.res) return p.res;
  const buyer = await buyerOf(request, env);
  if (buyer) p.order.metadata = { ...(p.order.metadata || {}), uid: buyer.sub };
  // the uids are only for reading the quote back; the hosted page doesn't need them
  p.order.line_items.forEach((l) => { delete l.uid; });

  const options = {
    // the thank-you page says when a pre-order ships
    redirect_url: thankYou(url, p.shipDate),
    // Square's own address form is off: the address can't be changed to one we don't ship to
    ask_for_shipping_address: false,
    // no discounts, ever (CLAUDE.md): no "add coupon" box and no loyalty rewards to redeem on Square's page,
    // whatever the Square account's own checkout settings say
    enable_coupon: false,
    enable_loyalty: false,
    // Apple Pay on Square's checkout page. Square's page lives on Square's own web address, so we need no domain file
    accepted_payment_methods: { apple_pay: true }
  };
  if (env.SUPPORT_EMAIL) options.merchant_support_email = env.SUPPORT_EMAIL;
  // no pre_populated_data: Square refuses a pre-filled email alongside the order's shipment ("Only one of
  // [fulfillment, buyer_email] fields should be set"). The buyer's email is already on the shipment's recipient

  const r = await square(env, '/v2/online-checkout/payment-links', {
    idempotency_key: crypto.randomUUID(),
    order: p.order,
    checkout_options: options,
    ...(p.paymentNote ? { payment_note: p.paymentNote } : {})
  });
  if (r.status === 0) return json({ error: 'square unreachable' }, 502);
  const link = r.data && r.data.payment_link;
  const target = link && (link.url || link.long_url);
  if (!r.ok || !target) {
    console.log('square error', r.status, JSON.stringify(r.data && r.data.errors));
    return json({ error: 'square' }, 502);
  }
  await afterOrder(env, buyer, p.gift, link.order_id);
  return json({ url: target });
}
