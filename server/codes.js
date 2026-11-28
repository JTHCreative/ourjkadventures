// j+k adventures: code cards. Every pin we sell goes out with a little card, and on the card is a code. Typing the
// code in (or scanning the card's QR code) puts that pin in the buyer's collection and adds one to their Collector's
// Path. Like a raffle ticket stub: it proves a real pin left our hands, and it only works once.
//
// A code is 8 characters, like AUS7K2M9. The first three say which pin (AUS = the aussie, the "code" in
// products.json). The other five are drawn at random from LETTERS: no vowels, so a card can't spell a word by
// accident, and no 0, 1 or L, which look like other characters in print. That's about 17 million codes per pin.
//
//   POST /api/codes/register   { code }   (signed in, email confirmed)
//        -> { status: "registered", pin, charges, counted, reached? }   it's yours now. reached: the step this
//                                                    pin just got them to ("early", "gift" or "pin")
//           { status: "yours", pin }                 you registered this card before
//           { status: "taken" }                      someone else registered it first
//           { status: "unknown" }                    no such card (or a cancelled one). counts as a wrong try
//           { status: "limit" }                      too many wrong tries this hour
//           { error: "code" } (400), { error: "signed out" } (401), { error: "confirm" } (403: email not confirmed)
//   GET  /api/collection                  (signed in) -> { charges, pins: [{ id, slug, name, size, at, on, x, y, r, z }] },
//                                         newest first. "my collection": the pins someone has registered, and where
//                                         each sits on their own pin board (on: false means still in the tray)
//   POST /api/collection/board { pins: [{ id, x, y, r, z } | { id, off: true }] }   (signed in) -> { saved: n }
//        where they've put their pins. x and y are the pin's middle, as a share of the board's width and height
//        (0 to 1), so the board looks the same on a phone and a desk. r is the turn in degrees, z which pin is on
//        top. Only pins already in their collection can be moved: the board never adds or removes a pin.
//   (owner, through server/admin.js) codeCards, makeBatch, batchCodes, lookUp, setCancelled, collectors
//
// Firestore, server only (firestore.rules blocks browsers):
//   codes/{CODE}                     { slug, size, batch, createdAt, claimedBy?, claimedAt?, cancelled?, free? }
//                                    free: the card for a pin on us. it joins the collection without a step
//   code_claims/{CODE}               { uid, at }   made once, by whoever registers the card first. this is the lock:
//                                                  Firestore refuses to make it twice, so two people can't both win
//   code_batches/{id}                { slug, size, count, claimed, createdAt, createdBy }   one print run
//   code_tries/{uid}_{hour}          { count }     wrong guesses by one account in one hour
//   users/{uid}/collection/{CODE}    { slug, size, at, on?, x?, y?, r?, z? }   the pins someone has registered, kept
//                                    for good, and where each sits on their board
//   users/{uid}                      charges, lifetimeCharges go up by one (only ever here, on the server)
// Codes are kept as they are, not scrambled: the owner needs to download a print run again, and with only five
// random characters a scrambled copy could be unscrambled by trying them all anyway. See docs/decisions.md.

import {
  configured, userFromRequest, firestoreGet, firestoreList, firestoreQuery, firestoreCommit, firestoreUpdate
} from './firebase.js';
import { siteProducts } from './catalog.js';
import { userPath } from './account.js';

// the collector's path: what each count brings (docs/pricing-and-loyalty.md). every reward adds something; none of
// them is ever money off. the first look and the little extra happen once per person; the pin repeats every ten
export const PATH = { early: 3, gift: 6, pin: 10 };

// What an account should say, worked out from its count: the fields to change, or null when it's already right.
// Like a punch card checked against its own punches: it can be run any number of times and lands in the same place.
//   earlyAccess        true from 3, for good
//   gift6Awarded       true from 6, for good. pendingGift6 is true until the extra has gone out with an order
//   freePinAvailable   true while the count is 10 or more (using the pin takes ten off: server/checkout.js)
export function rewardChanges(me) {
  const count = (me && me.charges) || 0;
  const to = {};
  if (count >= PATH.early && me.earlyAccess !== true) to.earlyAccess = true;
  if (count >= PATH.gift && me.gift6Awarded !== true) { to.gift6Awarded = true; to.pendingGift6 = true; }
  if ((count >= PATH.pin) !== (me.freePinAvailable === true)) to.freePinAvailable = count >= PATH.pin;
  return Object.keys(to).length ? to : null;
}
// reads the account, brings its rewards up to date, and returns it with what just changed (`reached`)
export async function settleRewards(env, uid, fetchFn = fetch) {
  const me = (await firestoreGet(env, userPath(uid), fetchFn)) || {};
  const to = rewardChanges(me);
  if (to) await firestoreUpdate(env, userPath(uid), to, fetchFn);
  return { ...me, ...(to || {}), reached: to || {} };
}
function rewardView(me) {
  return {
    early: me.earlyAccess === true,
    gift: me.pendingGift6 === true ? 'coming' : me.gift6Awarded === true ? 'sent' : '',
    pin: me.freePinAvailable === true
  };
}

export const LETTERS = '23456789BCDFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const TRIES_PER_HOUR = 10;
export const BATCH_MAX = 200;
const BATCHES_SHOWN = 300;
const COLLECTION_MAX = 300;

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// what someone typed, tidied: capitals, and no spaces or dashes ("aus-7k2m9" is AUS7K2M9). null if it can't be a code
export function cleanCode(s) {
  if (typeof s !== 'string' || s.length > 40) return null;
  const code = s.toUpperCase().replace(/[\s\-_.]/g, '');
  if (code.length !== CODE_LENGTH || !/^[A-Z]{3}/.test(code)) return null;
  for (const ch of code.slice(3)) if (!LETTERS.includes(ch)) return null;
  return code;
}

// the pins that have code cards: [{ slug, name, prefix, sizes }]
export function codePins(products) {
  return (products.items || []).filter((p) => p.kind === 'pin' && typeof p.code === 'string' && /^[A-Z]{3}$/.test(p.code))
    .map((p) => ({ slug: p.slug, name: p.slug === 'golden' ? 'goldie' : p.name, prefix: p.code, sizes: p.sizes || ['standard'] }));
}

// five random characters. bytes that would make some characters likelier than others are thrown back
export function randomTail() {
  let out = '';
  const fair = 256 - (256 % LETTERS.length);
  while (out.length < CODE_LENGTH - 3) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < fair && out.length < CODE_LENGTH - 3) out += LETTERS[b % LETTERS.length];
    }
  }
  return out;
}

function pinView(pins, slug, size) {
  const p = pins.find((x) => x.slug === slug);
  return { slug, size: size || 'standard', name: p ? p.name : slug.replace(/-/g, ' ') };
}

/* ---------- the customer's side ---------- */
export async function codesRoute(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  const isCollection = url.pathname === '/api/collection';
  const isBoard = url.pathname === '/api/collection/board';
  if (request.method !== (isCollection ? 'GET' : 'POST')) return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  let user;
  try { user = await userFromRequest(request, env, fetchFn); } catch (e) {
    console.log('token check failed', e.message);
    return json({ error: 'unavailable' }, 503);
  }
  if (!user) return json({ error: 'signed out' }, 401);
  try {
    const pins = codePins(await siteProducts(env, url.origin));
    if (isCollection) return json(await collection(env, user.sub, pins, fetchFn));
    if (isBoard) {
      let layout = {};
      try { layout = (await request.json()) || {}; } catch (e) {}
      const out = await saveBoard(env, user.sub, layout, fetchFn);
      return out.error ? json({ error: out.error }, out.status) : json(out);
    }
    // an email nobody has confirmed could be anyone's, so it can't collect yet
    if (user.email_verified !== true) return json({ error: 'confirm' }, 403);
    let body = {};
    try { body = (await request.json()) || {}; } catch (e) {}
    const code = cleanCode(body.code);
    if (!code) return json({ error: 'code' }, 400);
    return json(await register(env, user.sub, code, pins, fetchFn));
  } catch (e) {
    console.log('codes error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

async function register(env, uid, code, pins, fetchFn) {
  const hour = new Date().toISOString().slice(0, 13);
  const triesPath = 'code_tries/' + encodeURIComponent(uid + '_' + hour);
  const tries = await firestoreGet(env, triesPath, fetchFn);
  if (tries && tries.count >= TRIES_PER_HOUR) return { status: 'limit' };

  const card = await firestoreGet(env, 'codes/' + code, fetchFn);
  if (!card || card.cancelled === true) {
    await firestoreCommit(env, [{ add: triesPath, field: 'count', data: { hour } }], fetchFn);
    return { status: 'unknown' };
  }
  const pin = pinView(pins, card.slug, card.size);
  if (card.claimedBy) return card.claimedBy === uid ? { status: 'yours', pin } : { status: 'taken' };

  // all of it or none of it: the lock, the card, the collection and the count
  const at = new Date();
  const writes = [
    { create: 'code_claims/' + code, data: { uid, at } },
    { change: 'codes/' + code, data: { claimedBy: uid, claimedAt: at } },
    { create: userPath(uid) + '/collection/' + code, data: { slug: card.slug, size: card.size || 'standard', at } }
  ];
  // the card that goes with a pin on us: the pin joins the collection, but a free pin never earns a step
  if (card.free !== true) writes.push({ add: userPath(uid), fields: ['charges', 'lifetimeCharges'], data: { lastPinAt: at } });
  if (card.batch) writes.push({ add: 'code_batches/' + card.batch, field: 'claimed', data: { lastClaimAt: at } });
  if (!(await firestoreCommit(env, writes, fetchFn))) {
    // someone got there a moment before (or this is a second press of the same button)
    const now = await firestoreGet(env, 'code_claims/' + code, fetchFn);
    return now && now.uid === uid ? { status: 'yours', pin } : { status: 'taken' };
  }
  // the pin is theirs whatever happens next: a hiccup here is put right the next time their collection is opened
  let me = {};
  try { me = await settleRewards(env, uid, fetchFn); } catch (e) { console.log('rewards not settled', e.message); }
  const reached = me.reached || {};
  return {
    status: 'registered', pin, charges: me.charges || 0, counted: card.free !== true,
    // the step this pin just reached, if any: "early" (3), "gift" (6) or "pin" (10)
    ...(reached.freePinAvailable ? { reached: 'pin' } : reached.gift6Awarded ? { reached: 'gift' } : reached.earlyAccess ? { reached: 'early' } : {})
  };
}

async function collection(env, uid, pins, fetchFn) {
  let me;
  try { me = await settleRewards(env, uid, fetchFn); } catch (e) { me = (await firestoreGet(env, userPath(uid), fetchFn)) || {}; }
  const rows = await firestoreList(env, userPath(uid) + '/collection', COLLECTION_MAX, fetchFn);
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const list = rows.map((r) => ({
    id: r.id, ...pinView(pins, r.slug, r.size), at: r.at ? new Date(r.at).toISOString() : '',
    on: r.on === true, x: num(r.x, 0.5), y: num(r.y, 0.5), r: num(r.r, 0), z: num(r.z, 0)
  }));
  list.sort((a, b) => b.at.localeCompare(a.at));
  return { charges: (me && me.charges) || 0, rewards: rewardView(me || {}), pins: list };
}

// one pin's place on the board, tidied. null if it isn't a place
export function cleanPlace(p) {
  if (!p || typeof p !== 'object') return null;
  const id = cleanCode(p.id);
  if (!id || id !== p.id) return null;
  if (p.off === true) return { id, data: { on: false } };
  const ok = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  if (!ok(p.x, 0, 1) || !ok(p.y, 0, 1) || !ok(p.r, -180, 180) || !ok(p.z, 0, 100000)) return null;
  const round = (v, places) => Math.round(v * places) / places;
  return { id, data: { on: true, x: round(p.x, 10000), y: round(p.y, 10000), r: round(p.r, 10), z: Math.round(p.z) } };
}

// { saved: n } or { error, status }. all of it or none of it
async function saveBoard(env, uid, body, fetchFn) {
  const sent = body.pins;
  if (!Array.isArray(sent) || !sent.length || sent.length > COLLECTION_MAX) return { error: 'pins', status: 400 };
  const places = sent.map(cleanPlace);
  if (places.includes(null) || new Set(places.map((p) => p.id)).size !== places.length) return { error: 'pins', status: 400 };
  // "change" only touches a pin that's already there, so nobody can add one to their collection this way
  const done = await firestoreCommit(env, places.map((p) => ({ change: userPath(uid) + '/collection/' + p.id, data: p.data })), fetchFn);
  return done ? { saved: places.length } : { error: 'not yours', status: 404 };
}

// account.js calls this when an account is deleted: the pins come off, the cards stay used
export async function forgetCollection(env, uid, fetchFn = fetch) {
  const rows = await firestoreList(env, userPath(uid) + '/collection', COLLECTION_MAX, fetchFn);
  if (rows.length) await firestoreCommit(env, rows.map((r) => ({ remove: userPath(uid) + '/collection/' + encodeURIComponent(r.id), any: true })), fetchFn);
}

/* ---------- the owner's side (server/admin.js has already checked who is asking) ---------- */
// { pins, batches: [{ id, slug, name, size, count, claimed, at }] }, newest print run first
export async function codeCards(env, origin, fetchFn = fetch) {
  const pins = codePins(await siteProducts(env, origin));
  const rows = await firestoreList(env, 'code_batches', BATCHES_SHOWN, fetchFn);
  const batches = rows.map((b) => ({
    id: b.id, ...pinView(pins, b.slug, b.size), count: b.count || 0, claimed: b.claimed || 0, free: b.free === true,
    at: b.createdAt ? new Date(b.createdAt).toISOString() : ''
  }));
  batches.sort((a, b) => b.at.localeCompare(a.at));
  return { pins, batches, max: BATCH_MAX };
}

// a new print run. { made: id } or { error, status }
export async function makeBatch(env, origin, body, who, fetchFn = fetch) {
  const pins = codePins(await siteProducts(env, origin));
  const pin = pins.find((p) => p.slug === body.slug);
  if (!pin) return { error: 'slug', status: 400 };
  const size = body.size === undefined ? pin.sizes[0] : body.size;
  if (!pin.sizes.includes(size)) return { error: 'size', status: 400 };
  const count = body.count;
  if (!Number.isInteger(count) || count < 1 || count > BATCH_MAX) return { error: 'count', status: 400 };

  // cards for pins on us (the reward at ten): they add the pin to a collection without adding a step
  if (body.free !== undefined && typeof body.free !== 'boolean') return { error: 'free', status: 400 };
  const free = body.free === true;

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  const createdAt = new Date();
  // a code that's already in use would spoil the whole lot, so on that (very rare) day we draw again
  for (let attempt = 0; attempt < 4; attempt++) {
    const codes = new Set();
    while (codes.size < count) codes.add(pin.prefix + randomTail());
    const writes = [...codes].map((code) => ({ create: 'codes/' + code, data: { slug: pin.slug, size, batch: id, createdAt, ...(free ? { free: true } : {}) } }));
    writes.push({ create: 'code_batches/' + id, data: { slug: pin.slug, size, count, claimed: 0, createdAt, createdBy: who || '', ...(free ? { free: true } : {}) } });
    if (await firestoreCommit(env, writes, fetchFn)) return { made: id };
  }
  throw new Error('could not draw fresh codes');
}

function cardView(code, card) {
  return {
    code, status: card.cancelled === true ? 'cancelled' : card.claimedBy ? 'registered' : 'open',
    at: card.claimedAt ? new Date(card.claimedAt).toISOString() : ''
  };
}

// every card in one print run, for the spreadsheet: { batch, codes: [{ code, status, at }] } or { error, status }
export async function batchCodes(env, origin, id, fetchFn = fetch) {
  if (typeof id !== 'string' || !/^[0-9a-f]{20}$/.test(id)) return { error: 'id', status: 400 };
  const b = await firestoreGet(env, 'code_batches/' + id, fetchFn);
  if (!b) return { error: 'no such batch', status: 404 };
  const pins = codePins(await siteProducts(env, origin));
  const rows = await firestoreQuery(env, 'codes', { batch: id }, BATCH_MAX, fetchFn);
  const codes = rows.map((r) => cardView(r.id, r)).sort((a, b2) => a.code.localeCompare(b2.code));
  return { batch: { id, ...pinView(pins, b.slug, b.size), count: b.count || 0, free: b.free === true, at: b.createdAt ? new Date(b.createdAt).toISOString() : '' }, codes };
}

// one card, by its code: { card: { code, status, at, pin, email } } or { error, status }
export async function lookUp(env, origin, typed, fetchFn = fetch) {
  const code = cleanCode(typed);
  if (!code) return { error: 'code', status: 400 };
  const card = await firestoreGet(env, 'codes/' + code, fetchFn);
  if (!card) return { error: 'no such card', status: 404 };
  const pins = codePins(await siteProducts(env, origin));
  let email = '';
  if (card.claimedBy) {
    const who = await firestoreGet(env, userPath(card.claimedBy), fetchFn);
    email = (who && who.email) || '';
  }
  return { card: { ...cardView(code, card), pin: pinView(pins, card.slug, card.size), email, free: card.free === true } };
}

// cancel a card that was lost or misprinted, or put it back. a registered card can't be cancelled: the pin is
// already in someone's collection
export async function setCancelled(env, origin, typed, cancelled, fetchFn = fetch) {
  const found = await lookUp(env, origin, typed, fetchFn);
  if (found.error) return found;
  if (typeof cancelled !== 'boolean') return { error: 'cancelled must be true or false', status: 400 };
  if (found.card.status === 'registered') return { error: 'registered', status: 409 };
  await firestoreCommit(env, [{ change: 'codes/' + found.card.code, data: { cancelled } }], fetchFn);
  return lookUp(env, origin, typed, fetchFn);
}

// who has reached what on the collector's path, for the owner: { early, gift, pin }, each [{ email, name, pins }].
// early: everyone with a first look at new pins. gift: their little extra hasn't gone out yet. pin: a pin on us is
// waiting for their next order
export async function collectors(env, fetchFn = fetch) {
  const who = (rows) => rows.map((u) => ({ email: u.email || '', name: [u.firstName, u.lastName].filter(Boolean).join(' '), pins: u.lifetimeCharges || 0 }))
    .filter((u) => u.email).sort((a, b) => a.email.localeCompare(b.email));
  const [early, gift, pin] = await Promise.all([
    firestoreQuery(env, 'users', { earlyAccess: true }, 500, fetchFn),
    firestoreQuery(env, 'users', { pendingGift6: true }, 500, fetchFn),
    firestoreQuery(env, 'users', { freePinAvailable: true }, 500, fetchFn)
  ]);
  return { early: who(early), gift: who(gift), pin: who(pin), path: PATH };
}

