// j+k adventures: "email me when it's here", for products that are not in the shop yet.
// Like leaving your name at the counter: you write it down, and when the pin arrives the owner presses one button on
// /admin and everyone waiting gets one email. Then the slip is thrown away.
//
//   POST /api/notify          { slug, email }  -> { status: "added" | "already" | "limit" } or { error: "email" | "domain" }
//   POST /api/notify/stop     { code }         the stop link (also one-click from mail apps) -> { stopped: true }
//   (owner, through server/admin.js) notifySummary and sendItsHere
//
// There's no "is this you?" email. Instead the address is checked on the spot: it has to look like an email, and
// the part after the @ has to be a real domain that takes mail (asked of the internet's address book, DNS). That
// catches typos like "gmial.com" and made-up domains. It can't tell whose address it is, so someone could put a
// friend's address down: the friend gets one "it's here" email, with a stop link. The browser also offers
// "did you mean ...@gmail.com?" for common slips before anything is sent.
//
// Firestore, server only. "<mode>" is the Square mode, so practising never touches the real list:
//   notify_<mode>/{slug}_{who}    { slug, email, who, createdAt }
//                                 who = the email scrambled (HMAC), so one address is on a pin's list once
//   notify_ips_<mode>/{h}         sign-ups from one connection on one day (scrambled with the day, like the votes)
// Rules that keep this from being used to bother people:
//   - at most SIGNUPS_PER_DAY sign-ups a day from one connection
//   - nothing is ever sent at sign-up. "it's here" goes out only when the owner presses send, once per address per pin

import { configured, firestoreGet, firestoreSet, firestoreQuery, firestoreCommit } from './firebase.js';
import { squareMode } from './square.js';
import { readAvailability, isAvailable, scramble } from './interest.js';
import { readShopSwitch } from './shop.js';
import { emailConfigured, emailsLeftToday, sentToday, dailyLimit, sendBatch } from './email.js';

export const SIGNUPS_PER_DAY = 5;
const BATCH = 100;
const DNS = 'https://cloudflare-dns.com/dns-query';

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

// Does this domain take email? Asks Cloudflare's public DNS (1.1.1.1), which is free and needs no key.
// true: it has mail servers (or, the old way, just an address). false: no such domain, or it says "no mail here".
// null: we couldn't ask just now. Then the sign-up goes through: a hiccup on our side shouldn't turn anyone away.
async function lookup(name, type, fetchFn) {
  const res = await fetchFn(DNS + '?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) throw new Error('dns ' + res.status);
  return res.json();
}
export async function domainTakesMail(domain, fetchFn = fetch) {
  try {
    const mx = await lookup(domain, 'MX', fetchFn);
    if (mx.Status === 3) return false; // NXDOMAIN: there's no such domain
    if (mx.Status !== 0) return null;
    const servers = (mx.Answer || []).filter((a) => a.type === 15).map((a) => String(a.data).trim());
    if (servers.length) return !servers.every((d) => /^\d+\s+\.$/.test(d)); // "0 ." means "this domain takes no mail"
    // no mail servers listed: mail can still go to the domain's own address, if it has one
    const a = await lookup(domain, 'A', fetchFn);
    return a.Status === 0 && (a.Answer || []).some((x) => x.type === 1);
  } catch (e) {
    console.log('dns lookup failed', e.message);
    return null;
  }
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
export function itsHereEmail(p, link, stop) {
  return {
    subject: 'the ' + productNoun(p) + ' is here.',
    text: 'hello.\n\n' +
      'you asked us to tell you when the ' + productNoun(p) + " arrived. it's in the shop now:\n" + link + '\n\n' +
      "this is the only email we'll send about it. thank you for waiting.\n\n" +
      'j+k adventures\nourjkadventures.com\n\n' +
      "if you didn't ask for this, or want no more of these emails: " + stop
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
  if (await firestoreGet(env, path, fetchFn)) return [{ status: 'already' }];

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipPath = ips(env) + '/' + (await scramble(env, 'notify-ip|' + day + '|' + ip));
  const fromHere = await firestoreGet(env, ipPath, fetchFn);
  if (fromHere && fromHere.count >= SIGNUPS_PER_DAY) return [{ status: 'limit' }];

  if ((await domainTakesMail(email.split('@')[1], fetchFn)) === false) return [{ error: 'domain' }, 400];

  await firestoreSet(env, path, { slug: p.slug, email, who, createdAt: new Date() }, fetchFn);
  await firestoreCommit(env, [{ add: ipPath, field: 'count', data: { day } }], fetchFn);
  return [{ status: 'added' }];
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
    rows[d.slug] = (rows[d.slug] || 0) + 1;
  }
  const out = items.filter((p) => rows[p.slug]).map((p) => {
    const preview = itsHereEmail(p, origin + productPath(p), origin + '/email.html?stop=...');
    return { slug: p.slug, name: productNoun(p), available: isAvailable(availability, p.slug), waiting: rows[p.slug], preview };
  }).sort((a, b) => b.waiting - a.waiting);
  return {
    configured: emailConfigured(env),
    limit: dailyLimit(env),
    sentToday: await sentToday(env, fetchFn),
    products: out
  };
}

// one press of "send": up to today's allowance (and 100 at a time). sent slips are thrown away
export async function sendItsHere(env, origin, slug, fetchFn = fetch) {
  if (!emailConfigured(env)) return { error: 'email not set up', status: 503 };
  const p = (await products(env, origin)).find((x) => x.slug === slug);
  if (!p) return { error: 'unknown product' };
  // "it's in the shop now" has to be true when it lands
  if (!isAvailable(await readAvailability(env, fetchFn), slug)) return { error: 'not available' };
  if (!(await readShopSwitch(env, fetchFn)).open) return { error: 'shop closed' };

  const waiting = await firestoreQuery(env, list(env), { slug }, 5000, fetchFn);
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
