// j+k adventures: /api/square-webhook, Square's doorbell, and the "thank you for your order" email.
//
// When someone pays, Square sends a message here ("payment 123 for order 456 is completed"). That's how the
// website knows an order was paid: the checkout page belongs to Square, so the website never sees the payment
// happen. Then:
//   1. the buyer gets "thank you for your order" (once per order, however many times Square rings)
//   2. on a gift order, the owner gets "a gift card to write" (server/owner-alerts.js)
// and when the owner refunds an order in Square, the buyer gets "your refund is on its way" (server/refunds.js)
// Square's own receipt still goes out too, with the prices; ours is the friendly note from justin and kitty.
//
// Anyone could send a message to this address, so each one is checked first: Square signs it with a key only
// Square and we know (HMAC-SHA256 of the notification URL and the message, in x-square-hmacsha256-signature).
// Like a wax seal on a letter: no seal, or the wrong one, and it goes in the bin unread.
// The order itself is then read fresh from Square, so nothing in the message is trusted beyond its order id.
//
// Square tries again (for up to three days) if we don't answer 200, so a hiccup sending the email answers 500 and
// the next try picks it up. What already went out is noted in Firestore order_mail_<mode>/{order id}
// { thanks, giftAlert }, and Resend's idempotency key covers two rings arriving at once.
//
// Cloudflare settings (docs/setup/square.md, "payment webhook"):
//   SQUARE_WEBHOOK_SIGNATURE_KEY  secret, from Square Developer > Webhooks > the subscription's "signature key"
//   SQUARE_WEBHOOK_URL            optional, the notification URL exactly as typed in Square. default: this address
// The access token needs ORDERS_READ (it already reads orders for /admin).

import { configured, firestoreGet, firestoreSet } from './firebase.js';
import { squareConfigured, squareMode } from './square.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml as e } from './email.js';
import { emailPage, para, section, itemTable, TEXT_SIGNOFF } from './email-look.js';
import { square, shipmentOf, isPaid, namer, view, hello, whereLines, itemLines, orderFooter } from './shipped.js';
import { alertGift } from './owner-alerts.js';
import { refundStarted } from './refunds.js';
import { shopToday, whenWords } from './preorder-words.js';

const EVENTS = ['payment.created', 'payment.updated'];
const REFUND_EVENTS = ['refund.created', 'refund.updated'];

function reply(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function money(cents) { return '$' + (cents / 100).toFixed(2); }

/* ---------- the seal ---------- */
async function hmacBase64(key, text) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text)));
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}
// the same answer in the same time whether the first or the last letter is wrong
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function sealIsGood(key, url, body, signature) {
  return sameText(await hmacBase64(key, url + body), signature);
}
// for tests: seal a message the way Square does
export async function sealFor(key, url, body) { return hmacBase64(key, url + body); }

/* ---------- the email ---------- */
export function thanksEmail(order, origin) {
  const today = shopToday();
  const hi = hello(order);
  const subject = order.gift ? 'thank you for your gift order' : 'thank you for your order';
  const how = order.shipping ? 'usps ' + order.shipping : 'usps';
  const when = order.preorder && order.expected
    ? 'your order has a pre-order in it, so everything ships together ' + whenWords(order.expected.slice(0, 10), today) +
      ". we'll email you again the day it's on its way."
    : "we'll pack it up by hand and send it by " + how + ", and we'll email you the tracking number the day it ships.";
  const lead = order.gift
    ? 'thank you so much for your order! we got it, and your gift is in good hands.'
    : 'thank you so much for your order! we got it, and we can\'t wait to send it your way.';
  const card = order.gift
    ? (order.giftNote ? "we'll write your note on a card by hand, tuck it in, and leave the receipt out of the box."
      : "we'll tuck in a blank card and leave the receipt out of the box.")
    : '';
  const total = order.total !== null && order.total !== undefined ? 'total paid ' + money(order.total) + '. square sends the receipt with the details.' : '';
  const where = whereLines(order);
  const text = subject + '\n\n' + hi + '\n\n' + lead + '\n\n' + when + (card ? '\n\n' + card : '') + '\n\n' +
    "what's in your order:\n" + itemLines(order).map((l) => '- ' + l).join('\n') + (total ? '\n' + total : '') + '\n\n' +
    'going to:\n' + where.join('\n') + '\n\n' +
    (order.gift ? 'the card:\n' + (order.giftNote ? '"' + order.giftNote + '"' : 'blank, no note') + '\n\n' : '') +
    orderFooter(order) + '\n\n' +
    'thank you for supporting our little shop.\n' + TEXT_SIGNOFF;
  const sections = [
    section("what's in your order", itemTable(order.items, origin) + (total ? '<div style="margin-top:8px;font-size:15px;color:#6a645e">' + e(total) + '</div>' : '')),
    section('going to', where.map(e).join('<br>'))
  ];
  if (order.gift) sections.push(section('the card', e(order.giftNote ? '"' + order.giftNote + '"' : 'blank, no note')));
  const html = emailPage({
    origin, title: subject + '.', preheader: lead,
    body: [para(e(hi)), para(e(lead)), para(e(when))].concat(card ? [para(e(card))] : []),
    sections,
    signoff: para('thank you for supporting our little shop.') + para('justin and kitty<br>j+k adventures', 'margin-top:16px'),
    footer: e(orderFooter(order))
  });
  return { subject, text, html };
}

/* ---------- an order was paid ---------- */
function mailDoc(env, orderId) { return 'order_mail_' + squareMode(env) + '/' + encodeURIComponent(orderId); }

// { thanked, alerted } or { skipped: why }. Throws on a hiccup, so Square tries again
export async function orderPaid(env, origin, orderId, fetchFn = fetch) {
  if (!emailConfigured(env)) return { skipped: 'email not set up' };
  let o;
  try { o = (await square(env, 'GET', '/v2/orders/' + orderId, null, fetchFn)).order; } catch (err) {
    // no such order (Square's "send test event" button uses a made-up one): nothing to do, and nothing to retry
    if (err.status === 404) return { skipped: 'no such order' };
    throw err;
  }
  // only the website's own orders: at our location, paid, with the shipment checkout put on it (not booth sales)
  if (!o || o.location_id !== env.SQUARE_LOCATION_ID) return { skipped: 'not ours' };
  if (!shipmentOf(o)) return { skipped: 'not a website order' };
  if (!isPaid(o)) return { skipped: 'not paid' };

  const path = mailDoc(env, orderId);
  const done = (await firestoreGet(env, path, fetchFn)) || {};
  if (done.thanks && (done.giftAlert || (o.metadata || {}).gift !== 'yes')) return { skipped: 'already' };
  const order = view(o, await namer(env, origin, fetchFn), origin);
  const now = new Date().toISOString();
  let thanked = false;
  let alerted = false;

  if (!done.thanks && emailConfigured(env) && order.email) {
    if ((await emailsLeftToday(env, fetchFn)) >= 1) {
      const m = thanksEmail(order, origin);
      await sendBatch(env, [{ to: order.email, subject: m.subject, text: m.text, html: m.html }], 'thanks-' + orderId, fetchFn);
      done.thanks = now;
      thanked = true;
    } else {
      console.log('thank-you email skipped: today\'s emails are used up', orderId);
    }
  }
  if (order.gift && !done.giftAlert && emailConfigured(env)) {
    if (await alertGift(env, origin, order, fetchFn)) { done.giftAlert = now; alerted = true; }
  }
  if (thanked || alerted) await firestoreSet(env, path, done, fetchFn);
  return { thanked, alerted };
}

/* ---------- the doorbell ---------- */
export async function squareWebhook(request, env, fetchFn = fetch) {
  if (request.method !== 'POST') return reply({ error: 'method' }, 405);
  if (!env.SQUARE_WEBHOOK_SIGNATURE_KEY || !squareConfigured(env) || !configured(env)) return reply({ error: 'not configured' }, 503);
  const body = await request.text();
  const url = env.SQUARE_WEBHOOK_URL || request.url;
  if (!(await sealIsGood(env.SQUARE_WEBHOOK_SIGNATURE_KEY, url, body, request.headers.get('x-square-hmacsha256-signature')))) {
    return reply({ error: 'signature' }, 403);
  }
  let event;
  try { event = JSON.parse(body); } catch (err) { return reply({ error: 'bad body' }, 400); }

  // a refund (the owner refunded in Square): "your refund is on its way" (server/refunds.js)
  if (REFUND_EVENTS.includes(event && event.type)) {
    const refund = event.data && event.data.object && event.data.object.refund;
    const refundId = (refund && refund.id) || (event.data && event.data.id);
    if (typeof refundId !== 'string') return reply({ ok: true, ignored: true });
    try {
      return reply({ ok: true, ...(await refundStarted(env, new URL(request.url).origin, refundId, fetchFn)) });
    } catch (err) {
      console.log('square webhook refund', event.event_id, err.message);
      return reply({ error: 'try again' }, 500);
    }
  }

  // later, this is also where the collector's path will count charges (docs/roadmap.md, phase 4)
  const payment = event && event.data && event.data.object && event.data.object.payment;
  if (!EVENTS.includes(event && event.type) || !payment || payment.status !== 'COMPLETED' || typeof payment.order_id !== 'string') {
    return reply({ ok: true, ignored: true });
  }
  if (payment.location_id && payment.location_id !== env.SQUARE_LOCATION_ID) return reply({ ok: true, ignored: true });
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(payment.order_id)) return reply({ ok: true, ignored: true });

  try {
    const result = await orderPaid(env, new URL(request.url).origin, payment.order_id, fetchFn);
    return reply({ ok: true, ...result });
  } catch (err) {
    console.log('square webhook', event.event_id, err.message);
    return reply({ error: 'try again' }, 500);
  }
}
