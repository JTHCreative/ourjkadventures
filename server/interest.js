// j+k adventures: "i'm interested", for products that are not in the shop yet.
// The owner marks each product available or not on /admin. A product that is not available is never for sale
// (even if it is linked to Square and has stock); instead it shows an "i'm interested" button, open or closed.
// Each tap adds one to that product's tally, and the tallies are shown in public.
//
//   POST   /api/interest   { slug }   -> { counted: true, count }
//                                     or { counted: false, reason: "already" | "limit", count }
//   DELETE /api/interest   { slug }   tapped again: take this browser's vote back
//                                     -> { removed: true, count } or { removed: false, reason: "not counted", count }
//
// One vote each, as best a website can tell without asking people to sign in. Two checks, like a coat check
// (your ticket) and a doorman (who counts heads from each door):
//   1. a ticket: a small random cookie, jka_voter, set on the first tap. one vote per pin per ticket.
//   2. a door count: at most IP_DAILY_CAP votes per pin per day from one internet connection (IP address).
//      a cap rather than one vote per connection, because a whole household, office or craft fair can share one.
// Neither the ticket nor the IP address is stored as it is: both are scrambled first with a key only the server
// has (a one-way HMAC), and the IP is scrambled together with the day, so it can't be matched up across days.
//
// Firestore, all server only (firestore.rules blocks browsers). "<mode>" is the Square mode, so practising in the
// sandbox never touches the real tallies:
//   settings/available_<mode>          { aussie: true, corgi: false, ... }   missing means available
//   settings/preorder_<mode>           { corgi: true, ... }                   missing means not on pre-order
//   settings/preorder_dates_<mode>     { corgi: "2026-12-15", ... }           when a pre-order pin is expected in
//   interest_<mode>/{slug}             { slug, count }                        the public tally
//   interest_votes_<mode>/{slug}_{h}   { slug, at, ipDoc }                    one per ticket per pin. ipDoc says which
//                                                                             door count to give back if it's taken back
//   interest_ips_<mode>/{slug}_{h}     { slug, day, count }                   votes from one connection on one day

import { configured, firestoreGet, firestoreSet, firestoreList, firestoreCommit } from './firebase.js';
import { squareMode } from './square.js';

export const IP_DAILY_CAP = 10;
const COOKIE = 'jka_voter';
const YEAR = 365 * 24 * 60 * 60;

function availableDoc(env) { return 'settings/available_' + squareMode(env); }
function preorderDoc(env) { return 'settings/preorder_' + squareMode(env); }
function preorderDatesDoc(env) { return 'settings/preorder_dates_' + squareMode(env); }
function tallies(env) { return 'interest_' + squareMode(env); }
function votes(env) { return 'interest_votes_' + squareMode(env); }
function ips(env) { return 'interest_ips_' + squareMode(env); }

/* ---------- available or not (set by the owner) ---------- */
// { corgi: false, ... }. Anything not saved as false counts as available, so new products behave as before.
export async function readAvailability(env, fetchFn = fetch) {
  const doc = (await firestoreGet(env, availableDoc(env), fetchFn)) || {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (typeof v === 'boolean') out[k] = v;
  return out;
}
export function isAvailable(availability, slug) { return !availability || availability[slug] !== false; }

export async function setAvailable(env, slug, available, fetchFn = fetch) {
  const doc = await readAvailability(env, fetchFn);
  doc[slug] = available === true;
  await firestoreSet(env, availableDoc(env), doc, fetchFn);
}

/* ---------- pre-order (set by the owner) ---------- */
// Between "not in the shop yet" and "in the shop": the pin is being made. It can be bought now and ships when it
// arrives (since 2026-11-09), nothing left to vote on. Pre-order wins over the available switch.
// { corgi: true, ... }
export async function readPreorder(env, fetchFn = fetch) {
  const doc = (await firestoreGet(env, preorderDoc(env), fetchFn)) || {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (v === true) out[k] = true;
  return out;
}
export function isPreorder(preorder, slug) { return !!preorder && preorder[slug] === true; }

export async function setPreorder(env, slug, on, fetchFn = fetch) {
  const doc = await readPreorder(env, fetchFn);
  if (on === true) doc[slug] = true;
  else delete doc[slug];
  await firestoreSet(env, preorderDoc(env), doc, fetchFn);
}

/* ---------- the pre-order date (set by the owner) ---------- */
// when a pin on pre-order is expected in stock and ready to ship: "2026-12-15". { corgi: "2026-12-15", ... }
// kept even while pre-order is off, so switching it back on brings the date back
export function cleanDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s ? s : null;
}
export async function readPreorderDates(env, fetchFn = fetch) {
  const doc = (await firestoreGet(env, preorderDatesDoc(env), fetchFn)) || {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (cleanDate(v)) out[k] = v;
  return out;
}
// date: "YYYY-MM-DD", or null to clear it
export async function setPreorderDate(env, slug, date, fetchFn = fetch) {
  const doc = await readPreorderDates(env, fetchFn);
  if (date) doc[slug] = date;
  else delete doc[slug];
  await firestoreSet(env, preorderDatesDoc(env), doc, fetchFn);
}

// what the shop goes by: both switches together, and the pre-order dates. available here means for sale outright,
// so a pre-order pin counts as false. { available: { corgi: false, ... }, preorder: { corgi: true, ... }, dates: { corgi: "2026-12-15" } }
export async function readShopStates(env, fetchFn = fetch) {
  const [availability, preorder, dates] = await Promise.all([readAvailability(env, fetchFn), readPreorder(env, fetchFn), readPreorderDates(env, fetchFn)]);
  const available = { ...availability };
  for (const slug of Object.keys(preorder)) available[slug] = false;
  return { available, preorder, dates };
}

/* ---------- the tallies ---------- */
// { corgi: 12, ... }
export async function readInterest(env, fetchFn = fetch) {
  const out = {};
  for (const d of await firestoreList(env, tallies(env), 300, fetchFn)) {
    if (typeof d.count === 'number' && d.count > 0) out[d.id] = d.count;
  }
  return out;
}

/* ---------- scrambling ---------- */
// The key is made from the Firebase service account (already a secret in Cloudflare), so there is nothing new to set up.
let keyCache = { key: null, from: null };
async function hmacKey(env) {
  if (keyCache.key && keyCache.from === env.FIREBASE_SERVICE_ACCOUNT) return keyCache.key;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const seed = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('jka-interest|' + (sa.private_key || '')));
  const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  keyCache = { key, from: env.FIREBASE_SERVICE_ACCOUNT };
  return key;
}
export async function scramble(env, text) {
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(env), new TextEncoder().encode(text)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readTicket(request) {
  const m = new RegExp('(?:^|;\\s*)' + COOKIE + '=([0-9a-f-]{36})(?:;|$)').exec(request.headers.get('Cookie') || '');
  return m ? m[1] : null;
}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extraHeaders || {}) }
  });
}

async function productSlugs(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
  if (!res.ok) throw new Error('products.json ' + res.status);
  return ((await res.json()).items || []).map((p) => p.slug);
}

// onCounted(slug, count) lets the catalog's one-minute memory catch up straight away
export async function interestRoute(request, env, fetchFn = fetch, onCounted) {
  if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  // only taps from our own pages: another website can't make its visitors vote
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) return json({ error: 'origin' }, 403);

  let body = {};
  try { body = (await request.json()) || {}; } catch (e) {}
  const slug = body.slug;
  if (typeof slug !== 'string' || !/^[a-z0-9-]{1,40}$/.test(slug)) return json({ error: 'slug' }, 400);

  // taking a vote back needs the ticket that cast it. no ticket, nothing of theirs to take back
  if (request.method === 'DELETE') return takeBack(request, env, slug, fetchFn, onCounted);

  // a fresh ticket for a first-time visitor, kept for a year and only ever sent back to this address
  let ticket = readTicket(request);
  const headers = {};
  if (!ticket) {
    ticket = crypto.randomUUID();
    headers['Set-Cookie'] = COOKIE + '=' + ticket + '; Path=/api/interest; Max-Age=' + YEAR + '; HttpOnly; Secure; SameSite=Lax';
  }

  try {
    if (!(await productSlugs(request, env)).includes(slug)) return json({ error: 'slug' }, 400, headers);
    // a product that's in the shop takes no votes: there's nothing to wait for. nor one that's being made already
    const states = await readShopStates(env, fetchFn);
    if (isPreorder(states.preorder, slug)) return json({ error: 'preorder' }, 409, headers);
    if (isAvailable(states.available, slug)) return json({ error: 'available' }, 409, headers);

    const tallyPath = tallies(env) + '/' + encodeURIComponent(slug);
    const countNow = async () => { const d = await firestoreGet(env, tallyPath, fetchFn); return (d && d.count) || 0; };

    const day = new Date().toISOString().slice(0, 10);
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const ipPath = ips(env) + '/' + encodeURIComponent(slug + '_' + (await scramble(env, 'ip|' + day + '|' + ip)));
    const votePath = votes(env) + '/' + encodeURIComponent(slug + '_' + (await scramble(env, 'ticket|' + ticket)));

    const fromHere = await firestoreGet(env, ipPath, fetchFn);
    if (fromHere && fromHere.count >= IP_DAILY_CAP) return json({ counted: false, reason: 'limit', count: await countNow() }, 200, headers);

    // the vote, the tally and the door count go in together. if this ticket already voted for this pin, none of them do
    const counted = await firestoreCommit(env, [
      { create: votePath, data: { slug, at: new Date(), ipDoc: ipPath } },
      { add: tallyPath, field: 'count', data: { slug } },
      { add: ipPath, field: 'count', data: { slug, day } }
    ], fetchFn);
    const count = await countNow();
    if (!counted) return json({ counted: false, reason: 'already', count }, 200, headers);
    if (onCounted) onCounted(slug, count);
    return json({ counted: true, count }, 200, headers);
  } catch (e) {
    console.log('interest error', e.message);
    return json({ error: 'unavailable' }, 503, headers);
  }
}

// Tapped again: like handing the ticket back at the coat check. The vote, one off the tally, and one off the door
// count it was added to (that day's, even if today is another day) all go together, so the tally can't drift or
// go below zero. Votes from before this existed have no ipDoc: their door count simply runs out at midnight.
async function takeBack(request, env, slug, fetchFn, onCounted) {
  const ticket = readTicket(request);
  try {
    if (!(await productSlugs(request, env)).includes(slug)) return json({ error: 'slug' }, 400);
    const tallyPath = tallies(env) + '/' + encodeURIComponent(slug);
    const countNow = async () => { const d = await firestoreGet(env, tallyPath, fetchFn); return Math.max(0, (d && d.count) || 0); };
    const votePath = ticket && votes(env) + '/' + encodeURIComponent(slug + '_' + (await scramble(env, 'ticket|' + ticket)));
    const vote = votePath && (await firestoreGet(env, votePath, fetchFn));
    if (!vote) return json({ removed: false, reason: 'not counted', count: await countNow() });
    const writes = [{ remove: votePath }, { add: tallyPath, field: 'count', by: -1, data: { slug } }];
    // only a door count this server wrote itself: never a path that could point somewhere else
    if (typeof vote.ipDoc === 'string' && vote.ipDoc.startsWith(ips(env) + '/' + encodeURIComponent(slug + '_'))) {
      writes.push({ add: vote.ipDoc, field: 'count', by: -1, data: { slug } });
    }
    // false here means a second tap beat this one to it: the vote is gone either way
    const removed = await firestoreCommit(env, writes, fetchFn);
    const count = await countNow();
    if (onCounted) onCounted(slug, count);
    return json(removed ? { removed: true, count } : { removed: false, reason: 'not counted', count });
  } catch (e) {
    console.log('interest take back error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}
