// j+k adventures: "email me when it's here", for products that are not in the shop yet.
// Like leaving your name at the counter: you write it down, we check it's really you (a confirm link), and when the
// pin arrives the owner presses one button on /admin and everyone waiting gets one email. Then the slip is thrown away.
//
//   POST /api/notify          { slug, email }  -> { status: "sent" | "already" | "limit" | "busy" }
//   POST /api/notify/confirm  { code }         the link in the "is this you?" email  -> { confirmed: true, name }
//   POST /api/notify/stop     { code }         the stop link (also one-click from mail apps) -> { stopped: true }
//   (owner, through server/admin.js) notifySummary and sendItsHere
//
// Firestore, server only. "<mode>" is the Square mode, so practising never touches the real list:
//   notify_<mode>/{slug}_{who}    { slug, email, who, status: "pending"|"confirmed", token, createdAt, sentAt, confirmedAt }
//                                 who = the email scrambled (HMAC), so one address is on a pin's list once
//   notify_ips_<mode>/{h}         sign-ups from one connection on one day (scrambled with the day, like the votes)
// Rules that keep this from being used to bother people:
//   - nobody gets more than the one "is this you?" email unless they ask again, and not twice in ten minutes
//   - at most SIGNUPS_PER_DAY sign-ups a day from one connection
//   - only confirmed addresses are ever sent "it's here", and only when the owner presses send

import { configured, firestoreGet, firestoreSet, firestoreUpdate, firestoreQuery, firestoreCommit } from './firebase.js';
import { squareMode } from './square.js';
import { readAvailability, isAvailable, scramble } from './interest.js';
import { readShopSwitch } from './shop.js';
import { emailConfigured, emailsLeftToday, sentToday, dailyLimit, sendOne, sendBatch } from './email.js';

export const SIGNUPS_PER_DAY = 5;
const RESEND_AFTER_MS = 10 * 60 * 1000;
const BATCH = 100;

function list(env) { return 'notify_' + squareMode(env); }
function ips(env) { return 'notify_ips_' + squareMode(env); }

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function cleanEmail(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

async function products(env, origin) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', origin)));
  if (!res.ok) throw new Error('products.json ' + res.status);
  return (await res.json()).items || [];
}
// "the corgi pin", "the bay area pin board"
export function productNoun(p) {
  const name = p.slug === 'golden' ? 'goldie' : p.name;
  return p.kind === 'board' ? name : name + ' pin';
}
// where a product lives on the site
export function productPath(p) {
  if (p.kind === 'board') return p.slug === 'bay-area-pin-board' ? '/bay-area-pin-board.html' : '/pin-boards.html';
  if (p.series === 'pup-club') return '/pup-club.html#' + encodeURIComponent(p.slug);
  return { hometown: '/hometown-series.html', zodiac: '/chinese-zodiac.html' }[p.series] || '/shop.html';
}

/* ---------- the words ---------- */
export function confirmEmail(p, link) {
  return {
    subject: 'is this you? the ' + productNoun(p) + '.',
    text: 'hello.\n\n' +
      'someone, hopefully you, asked us to write to this address when the ' + productNoun(p) + ' is in the shop. ' +
      'if that was you, say yes here:\n' + link + '\n\n' +
      "if it wasn't you, there's nothing to do. we won't write again.\n\n" +
      'j+k adventures\nourjkadventures.com'
  };
}
export function itsHereEmail(p, link, stop) {
  return {
    subject: 'the ' + productNoun(p) + ' is here.',
    text: 'hello.\n\n' +
      'you asked us to tell you when the ' + productNoun(p) + " arrived. it's in the shop now:\n" + link + '\n\n' +
      "this is the only email we'll send about it. thank you for waiting.\n\n" +
      'j+k adventures\nourjkadventures.com\n\n' +
      'to stop all of these emails: ' + stop
  };
}

// the stop link proves we made it (an HMAC of the scrambled address), so it needs nothing stored and can't be guessed
async function stopCode(env, who) { return who + '.' + (await scramble(env, 'stop|' + who)); }
function stopLink(origin, code) { return origin + '/email.html?stop=' + code; }

/* ---------- the public side ---------- */
export async function notifyRoute(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'origin' }, 403);

  let body = {};
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) { try { body = (await request.json()) || {}; } catch (e) {} }
  const route = url.pathname.replace(/^\/api\/notify\/?/, '');

  try {
    if (route === 'confirm') return json(...(await confirm(env, request, body.code, fetchFn)));
    // mail apps' one-click button posts a form with the code in the link itself
    if (route === 'stop') return json(...(await stop(env, body.code || url.searchParams.get('code'), fetchFn)));
    if (route !== '') return json({ error: 'not found' }, 404);
    if (!emailConfigured(env)) return json({ error: 'email not set up' }, 503);
    return json(...(await signUp(env, request, body, fetchFn)));
  } catch (e) {
    console.log('notify error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

async function signUp(env, request, body, fetchFn) {
  const email = cleanEmail(body.email);
  if (!email) return [{ error: 'email' }, 400];
  const p = typeof body.slug === 'string' && (await products(env, request.url)).find((x) => x.slug === body.slug);
  if (!p) return [{ error: 'slug' }, 400];
  // only for products that aren't here yet
  if (isAvailable(await readAvailability(env, fetchFn), p.slug)) return [{ error: 'available' }, 409];

  const who = await scramble(env, 'email|' + email);
  const path = list(env) + '/' + encodeURIComponent(p.slug + '_' + who);
  const before = await firestoreGet(env, path, fetchFn);
  if (before && before.status === 'confirmed') return [{ status: 'already' }];
  // asked twice in a row: the first link is still good, so don't send another
  if (before && before.sentAt && Date.now() - Date.parse(before.sentAt) < RESEND_AFTER_MS) return [{ status: 'sent' }];

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipPath = ips(env) + '/' + (await scramble(env, 'notify-ip|' + day + '|' + ip));
  const fromHere = await firestoreGet(env, ipPath, fetchFn);
  if (fromHere && fromHere.count >= SIGNUPS_PER_DAY) return [{ status: 'limit' }];
  if ((await emailsLeftToday(env, fetchFn)) < 1) return [{ status: 'busy' }];

  const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date();
  await firestoreSet(env, path, {
    slug: p.slug, email, who, status: 'pending', token,
    createdAt: before && before.createdAt ? new Date(before.createdAt) : now, sentAt: now
  }, fetchFn);
  const link = new URL(request.url).origin + '/email.html?confirm=' + p.slug + '_' + who + '.' + token;
  if (!(await sendOne(env, { to: email, ...confirmEmail(p, link) }, fetchFn))) return [{ status: 'busy' }];
  await firestoreCommit(env, [{ add: ipPath, field: 'count', data: { day } }], fetchFn);
  return [{ status: 'sent' }];
}

async function confirm(env, request, code, fetchFn) {
  const m = /^([a-z0-9-]{1,40})_([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(typeof code === 'string' ? code : '');
  if (!m) return [{ confirmed: false }, 400];
  const path = list(env) + '/' + encodeURIComponent(m[1] + '_' + m[2]);
  const doc = await firestoreGet(env, path, fetchFn);
  if (!doc || doc.token !== m[3]) return [{ confirmed: false }, 404];
  if (doc.status !== 'confirmed') await firestoreUpdate(env, path, { status: 'confirmed', confirmedAt: new Date() }, fetchFn);
  const p = (await products(env, request.url)).find((x) => x.slug === m[1]);
  return [{ confirmed: true, name: p ? productNoun(p) : m[1] }];
}

async function stop(env, code, fetchFn) {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(typeof code === 'string' ? code : '');
  if (!m || (await stopCode(env, m[1])) !== code) return [{ stopped: false }, 400];
  const mine = await firestoreQuery(env, list(env), { who: m[1] }, 100, fetchFn);
  if (mine.length) await firestoreCommit(env, mine.map((d) => ({ remove: list(env) + '/' + encodeURIComponent(d.id), any: true })), fetchFn);
  return [{ stopped: true }];
}

/* ---------- the owner's side (server/admin.js has already checked who is asking) ---------- */
// who is waiting for what, today's email count, and a preview of each "it's here" email
export async function notifySummary(env, origin, fetchFn = fetch) {
  const items = await products(env, origin);
  const availability = await readAvailability(env, fetchFn);
  const rows = {};
  for (const d of await firestoreQuery(env, list(env), {}, 5000, fetchFn)) {
    const r = rows[d.slug] || (rows[d.slug] = { confirmed: 0, pending: 0 });
    if (d.status === 'confirmed') r.confirmed++; else r.pending++;
  }
  const out = items.filter((p) => rows[p.slug]).map((p) => {
    const preview = itsHereEmail(p, origin + productPath(p), origin + '/email.html?stop=...');
    return { slug: p.slug, name: productNoun(p), available: isAvailable(availability, p.slug), ...rows[p.slug], preview };
  }).sort((a, b) => b.confirmed - a.confirmed);
  return {
    configured: emailConfigured(env),
    limit: dailyLimit(env),
    sentToday: await sentToday(env, fetchFn),
    products: out
  };
}

// one press of "send": up to today's allowance (and 100 at a time), to confirmed addresses only. sent slips are thrown away
export async function sendItsHere(env, origin, slug, fetchFn = fetch) {
  if (!emailConfigured(env)) return { error: 'email not set up', status: 503 };
  const p = (await products(env, origin)).find((x) => x.slug === slug);
  if (!p) return { error: 'unknown product' };
  // "it's in the shop now" has to be true when it lands
  if (!isAvailable(await readAvailability(env, fetchFn), slug)) return { error: 'not available' };
  if (!(await readShopSwitch(env, fetchFn)).open) return { error: 'shop closed' };

  const waiting = await firestoreQuery(env, list(env), { slug, status: 'confirmed' }, 5000, fetchFn);
  const room = Math.min(BATCH, await emailsLeftToday(env, fetchFn));
  const now = waiting.slice(0, room);
  if (!now.length) return { sent: 0, left: waiting.length, full: waiting.length > 0 };

  const link = origin + productPath(p);
  const messages = [];
  for (const d of now) {
    const stopUrl = stopLink(origin, await stopCode(env, d.who));
    messages.push({ to: d.email, ...itsHereEmail(p, link, stopUrl), unsubscribe: origin + '/api/notify/stop?code=' + (await stopCode(env, d.who)) });
  }
  // the same people for the same pin on the same day: a second press after a hiccup isn't sent twice
  const key = 'its-here-' + slug + '-' + (await scramble(env, now.map((d) => d.id).sort().join(','))).slice(0, 24);
  await sendBatch(env, messages, key, fetchFn);
  await firestoreCommit(env, now.map((d) => ({ remove: list(env) + '/' + encodeURIComponent(d.id), any: true })), fetchFn);
  return { sent: now.length, left: waiting.length - now.length };
}
