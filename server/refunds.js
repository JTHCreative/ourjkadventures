// j+k adventures: "your refund is on its way". When the owner refunds a website order in Square (the dashboard or
// the app), Square rings the payment doorbell (server/square-webhook.js) with refund.created, and the buyer gets
// this email in the shop's letterhead: how much, and roughly when it shows up. Square sends its own refund receipt
// too; ours is the friendly note.
//
// Like the thank-you: the message only tells us which refund. The refund itself (amount, status, which order) is read
// fresh from Square, and then the order, so nothing in the message is trusted. Once per refund, however many times
// Square rings (refund.created, then refund.updated when the bank finishes): Firestore refund_mail_<mode>/{refund id},
// plus Resend's idempotency key. A refund Square turned down (REJECTED or FAILED) sends nothing.
// A partial refund says its own amount. Booth sales have no shipment on them, so they never get this email.

import { firestoreGet, firestoreSet } from './firebase.js';
import { squareMode } from './square.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml as e } from './email.js';
import { emailPage, para, section, itemTable, TEXT_SIGNOFF } from './email-look.js';
import { square, shipmentOf, namer, view, hello, itemLines, orderFooter } from './shipped.js';

const SENDING = ['PENDING', 'COMPLETED'];

function money(cents) { return '$' + (cents / 100).toFixed(2); }

// order: as /admin sees it (server/shipped.js view). cents: how much this refund gives back
export function refundEmail(order, cents, origin) {
  const subject = 'your refund is on its way';
  const hi = hello(order);
  const all = order.total !== null && order.total !== undefined && cents >= order.total;
  const lead = 'we\'ve started a refund of ' + money(cents) + (all ? ' for your order' : ' for part of your order') +
    '. it goes back to the card you paid with, and should show up within 5 to 10 business days, depending on your bank.';
  const after = 'square will send you a receipt for the refund too. if anything about it looks off, or you have a question, just reply to this email.';
  const text = subject + '\n\n' + hi + '\n\n' + lead + '\n\n' + after + '\n\n' +
    'your order:\n' + itemLines(order).map((l) => '- ' + l).join('\n') + '\n' +
    'refunded ' + money(cents) + (all || order.total === null || order.total === undefined ? '' : ' of ' + money(order.total)) + '\n\n' +
    orderFooter(order) + '\n\n' + 'thank you for supporting our little shop.\n' + TEXT_SIGNOFF;
  const html = emailPage({
    origin, title: subject + '.', preheader: 'a refund of ' + money(cents) + ' is on its way back to your card.',
    body: [para(e(hi)), para(e(lead)), para(e(after))],
    sections: [section('your order', itemTable(order.items, origin) +
      '<div style="margin-top:8px;font-size:15px;color:#6a645e">refunded ' + e(money(cents)) +
      (all || order.total === null || order.total === undefined ? '' : ' of ' + e(money(order.total))) + '</div>')],
    signoff: para('thank you for supporting our little shop.') + para('justin and kitty<br>j+k adventures', 'margin-top:16px'),
    footer: e(orderFooter(order))
  });
  return { subject, text, html };
}

function mailDoc(env, refundId) { return 'refund_mail_' + squareMode(env) + '/' + encodeURIComponent(refundId); }

// { emailed: true } or { skipped: why }. Throws on a hiccup, so Square tries again
export async function refundStarted(env, origin, refundId, fetchFn = fetch) {
  if (!emailConfigured(env)) return { skipped: 'email not set up' };
  if (typeof refundId !== 'string' || !/^[A-Za-z0-9_-]{1,192}$/.test(refundId)) return { skipped: 'bad refund' };
  if (await firestoreGet(env, mailDoc(env, refundId), fetchFn)) return { skipped: 'already' };

  let refund;
  try { refund = (await square(env, 'GET', '/v2/refunds/' + encodeURIComponent(refundId), null, fetchFn)).refund; } catch (err) {
    // no such refund (Square's "send test event" button uses a made-up one): nothing to do, and nothing to retry
    if (err.status === 404) return { skipped: 'no such refund' };
    throw err;
  }
  if (!refund || !SENDING.includes(refund.status)) return { skipped: 'not refunding' };
  if (refund.location_id && refund.location_id !== env.SQUARE_LOCATION_ID) return { skipped: 'not ours' };
  const cents = refund.amount_money && refund.amount_money.amount;
  if (!Number.isInteger(cents) || cents <= 0 || typeof refund.order_id !== 'string') return { skipped: 'no amount' };

  let o;
  try { o = (await square(env, 'GET', '/v2/orders/' + encodeURIComponent(refund.order_id), null, fetchFn)).order; } catch (err) {
    if (err.status === 404) return { skipped: 'no such order' };
    throw err;
  }
  // only the website's own orders: at our location, with the shipment checkout put on it
  if (!o || o.location_id !== env.SQUARE_LOCATION_ID) return { skipped: 'not ours' };
  if (!shipmentOf(o)) return { skipped: 'not a website order' };
  const order = view(o, await namer(env, origin, fetchFn), origin);
  if (!order.email) return { skipped: 'no email' };
  if ((await emailsLeftToday(env, fetchFn)) < 1) {
    console.log('refund email skipped: today\'s emails are used up', refundId);
    return { skipped: 'email limit' };
  }
  const m = refundEmail(order, cents, origin);
  await sendBatch(env, [{ to: order.email, subject: m.subject, text: m.text, html: m.html }], 'refund-' + refundId, fetchFn);
  await firestoreSet(env, mailDoc(env, refundId), { orderId: o.id, cents, at: new Date() }, fetchFn);
  return { emailed: true };
}
