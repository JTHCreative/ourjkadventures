// j+k adventures: little emails to the owner, so /admin doesn't need checking all day.
//   - "a review is waiting": someone left a review (account or guest), it needs a look before it shows
//   - "a gift card to write": a gift order was just paid, here's the note for the card
//   - "a pin request": someone asked for a pin we don't make yet (server/pin-requests.js)
// Like a bell on the shop door: it rings in the back room, it doesn't do anything by itself.
//
// They go to every address in ADMIN_EMAILS (the same list that may open /admin), in the same letterhead as the
// customer emails (server/email-look.js). An alert never stops what rang it: a review is saved and a payment is
// counted whether or not the bell works. Review alerts stop at REVIEW_ALERTS_PER_DAY, so a burst of reviews can't
// use up the day's emails (they're all still on /admin), and pin requests at PIN_REQUEST_ALERTS_PER_DAY.
// Firestore: owner_alert_days/{YYYY-MM-DD} { reviews, pin_requests }.

import { firestoreGet, firestoreCommit } from './firebase.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml as e } from './email.js';
import { emailPage, para, section, link as linkTo } from './email-look.js';
import { adminEmails } from './admin.js';

export const REVIEW_ALERTS_PER_DAY = 10;
export const PIN_REQUEST_ALERTS_PER_DAY = 10;
const FOOTER = 'sent by the website to the addresses in ADMIN_EMAILS. replies go to support@.';

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }

// review: { slug, noun ("the corgi pin"), name ("juniper h."), rating, text, photos (count), guest }
export function reviewAlertEmail(review, origin) {
  const link = origin + '/admin#admin-reviews-title';
  const subject = 'a review is waiting: ' + review.noun + ', ' + review.rating + (review.rating === 1 ? ' star' : ' stars');
  const who = review.name + (review.guest ? ' (a guest)' : '');
  const photos = review.photos ? review.photos + (review.photos === 1 ? ' photo' : ' photos') : '';
  const lead = who + ' left a review of ' + review.noun + '. it shows on the site once you approve it.';
  const text = subject + '\n\n' + lead + '\n\n' + stars(review.rating) + '\n' + (review.text || '(no words, just stars)') +
    (photos ? '\n(' + photos + ')' : '') + '\n\nlook on /admin: ' + link + '\n\n' + FOOTER;
  const html = emailPage({
    origin, title: 'a review is waiting.', preheader: lead,
    body: [para(e(lead))],
    sections: [section(stars(review.rating), e(review.text || '(no words, just stars)') + (photos ? '<br><span style="color:#6a645e">' + e(photos) + '</span>' : ''))],
    button: { href: link, label: 'look on /admin' },
    signoff: '', footer: e(FOOTER)
  });
  return { subject, text, html };
}

// order: { number, giftNote, name (who it's going to) }
export function giftAlertEmail(order, origin) {
  const link = origin + '/admin#admin-orders-title';
  const subject = 'a gift card to write: order ' + order.number;
  const lead = 'order ' + order.number + ' is a gift going to ' + (order.name || 'someone') + '. write the card before it ships.';
  const note = order.giftNote ? '"' + order.giftNote + '"' : 'a blank card, no note.';
  const text = subject + '\n\n' + lead + '\n\nthe card:\n' + note + '\n\nsee it on /admin: ' + link + '\n\n' + FOOTER;
  const html = emailPage({
    origin, title: 'a gift card to write.', preheader: lead,
    body: [para(e(lead))],
    sections: [section('the card', e(note))],
    button: { href: link, label: 'see it on /admin' },
    signoff: '', footer: e(FOOTER)
  });
  return { subject, text, html };
}

// request: { setName ("pup club"), about, name, email }
export function pinRequestAlertEmail(request, origin) {
  const link = origin + '/admin#admin-requests-title';
  const subject = 'a pin request: ' + request.setName;
  const who = request.name || 'someone';
  const lead = who + ' asked for a ' + request.setName + ' pin we don\'t make yet. it\'s on /admin with the others.';
  const reply = request.email ? 'write back: ' + request.email : 'no email left, so there\'s no one to write back to.';
  const text = subject + '\n\n' + lead + '\n\nwhat they said:\n' + request.about + '\n\n' + reply + '\n\nsee them all on /admin: ' + link + '\n\n' + FOOTER;
  const html = emailPage({
    origin, title: 'a pin request.', preheader: lead,
    body: [para(e(lead))],
    sections: [
      section('what they said', e(request.about).replace(/\n/g, '<br>')),
      section('write back', request.email ? linkTo('mailto:' + request.email, request.email) : e('no email left.'))
    ],
    button: { href: link, label: 'see them all on /admin' },
    signoff: '', footer: e(FOOTER)
  });
  return { subject, text, html };
}

// sends one alert to every owner address. returns how many went, 0 if email isn't set up or the day is used up
async function ring(env, message, key, fetchFn) {
  const to = adminEmails(env);
  if (!emailConfigured(env) || !to.length) return 0;
  if ((await emailsLeftToday(env, fetchFn)) < to.length) return 0;
  return sendBatch(env, to.map((t) => ({ to: t, ...message })), key, fetchFn);
}

// never throws: a missed alert must not lose a review
export async function alertReview(env, origin, review, fetchFn = fetch) {
  if (!emailConfigured(env) || !adminEmails(env).length) return 0;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const doc = 'owner_alert_days/' + day;
    const had = await firestoreGet(env, doc, fetchFn);
    if (had && had.reviews >= REVIEW_ALERTS_PER_DAY) return 0;
    const sent = await ring(env, reviewAlertEmail(review, origin), 'review-' + review.id + '-' + (review.at || day), fetchFn);
    if (sent) await firestoreCommit(env, [{ add: doc, field: 'reviews', data: { day } }], fetchFn);
    return sent;
  } catch (err) {
    console.log('review alert failed', err.message);
    return 0;
  }
}

// throws, so the payment doorbell (server/square-webhook.js) can try again later
export async function alertGift(env, origin, order, fetchFn = fetch) {
  return ring(env, giftAlertEmail(order, origin), 'gift-' + order.id, fetchFn);
}

// never throws: a missed alert must not lose a request. at most PIN_REQUEST_ALERTS_PER_DAY a day
export async function alertPinRequest(env, origin, request, fetchFn = fetch) {
  if (!emailConfigured(env) || !adminEmails(env).length) return 0;
  try {
    const day = new Date().toISOString().slice(0, 10);
    const doc = 'owner_alert_days/' + day;
    const had = await firestoreGet(env, doc, fetchFn);
    if (had && had.pin_requests >= PIN_REQUEST_ALERTS_PER_DAY) return 0;
    const sent = await ring(env, pinRequestAlertEmail(request, origin), 'pin-request-' + request.id, fetchFn);
    if (sent) await firestoreCommit(env, [{ add: doc, field: 'pin_requests', data: { day } }], fetchFn);
    return sent;
  } catch (err) {
    console.log('pin request alert failed', err.message);
    return 0;
  }
}
