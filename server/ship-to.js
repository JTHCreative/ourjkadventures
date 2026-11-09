// j+k adventures: where an order goes, and the gift note that rides with it.
//
// We ship to the 50 U.S. states and D.C. only, for now. The bag asks for the address on our own site, the server
// checks it here, and checkout hands it to Square already filled in on the order (Square's own address form is
// switched off), so nobody can swap in an address abroad on Square's page. Like a mail clerk who reads the label
// before it goes in the bin: the state has to be one of ours, and the zip code has to belong to that state.
//
// A gift: the buyer ticks "this is a gift" and writes a short note. We write it by hand on a card. The note goes on
// the Square order (the shipping note and the payment note) and into Firestore gifts/<square order id>, which
// /admin lists once the order is paid, with the buyer's email and the address it ships to.

import { firestoreSet, firestoreList, firestoreDelete } from './firebase.js';
import { cleanEmail } from './notify.js';
import { SQUARE_VERSION, squareHost } from './square.js';

// about two short lines on a small card. was 200 until 2026-11-09
export const GIFT_MAX = 100;

// the first three digits of each state's zip codes (USPS). a few towns near a state line share a prefix
// with the neighbour, so those prefixes are listed under both
const R = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };
export const STATES = [
  ['AL', 'alabama', R(350, 369)], ['AK', 'alaska', R(995, 999)], ['AZ', 'arizona', R(850, 865)],
  ['AR', 'arkansas', [...R(716, 729), 755]], ['CA', 'california', R(900, 961)], ['CO', 'colorado', R(800, 816)],
  ['CT', 'connecticut', R(60, 69)], ['DE', 'delaware', R(197, 199)], ['DC', 'district of columbia', [...R(200, 205), 569]],
  ['FL', 'florida', R(320, 349)], ['GA', 'georgia', [...R(300, 319), 398, 399]], ['HI', 'hawaii', R(967, 968)],
  ['ID', 'idaho', R(832, 838)], ['IL', 'illinois', R(600, 629)], ['IN', 'indiana', R(460, 479)],
  ['IA', 'iowa', R(500, 528)], ['KS', 'kansas', R(660, 679)], ['KY', 'kentucky', R(400, 427)],
  ['LA', 'louisiana', R(700, 714)], ['ME', 'maine', R(39, 49)], ['MD', 'maryland', R(206, 219)],
  ['MA', 'massachusetts', [...R(10, 27), 55]], ['MI', 'michigan', R(480, 499)], ['MN', 'minnesota', R(550, 567)],
  ['MS', 'mississippi', R(386, 397)], ['MO', 'missouri', R(630, 658)], ['MT', 'montana', R(590, 599)],
  ['NE', 'nebraska', R(680, 693)], ['NV', 'nevada', R(889, 898)], ['NH', 'new hampshire', R(30, 38)],
  ['NJ', 'new jersey', R(70, 89)], ['NM', 'new mexico', R(870, 884)], ['NY', 'new york', [5, ...R(100, 149), 63]],
  ['NC', 'north carolina', R(270, 289)], ['ND', 'north dakota', R(580, 588)], ['OH', 'ohio', R(430, 459)],
  ['OK', 'oklahoma', R(730, 749)], ['OR', 'oregon', R(970, 979)], ['PA', 'pennsylvania', R(150, 196)],
  ['RI', 'rhode island', R(28, 29)], ['SC', 'south carolina', R(290, 299)], ['SD', 'south dakota', R(570, 577)],
  ['TN', 'tennessee', R(370, 385)], ['TX', 'texas', [...R(750, 799), 733, 885]], ['UT', 'utah', R(840, 847)],
  ['VT', 'vermont', R(50, 59)], ['VA', 'virginia', [...R(220, 246), 201]], ['WA', 'washington', R(980, 994)],
  ['WV', 'west virginia', R(247, 268)], ['WI', 'wisconsin', R(530, 549)], ['WY', 'wyoming', [...R(820, 831), 834]]
];
const BY_CODE = Object.fromEntries(STATES.map(([code, name, zips]) => [code, { name, zips: new Set(zips) }]));

// for the bag's state list: [{ code, name }]
export function stateList() { return STATES.map(([code, name]) => ({ code, name })); }

// one line of an address: no control characters or angle brackets, spaces squeezed, at most `max` long
function line(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// { ok: true, value } or { error, field } for the bag to point at the box that needs another look
export function cleanShipTo(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const name = line(r.name, 80);
  if (!name) return { error: 'name', field: 'name' };
  const email = cleanEmail(r.email);
  if (!email) return { error: 'email', field: 'email' };
  const line1 = line(r.line1, 100);
  if (!line1) return { error: 'street', field: 'line1' };
  const line2 = line(r.line2, 100);
  const city = line(r.city, 60);
  if (!city) return { error: 'city', field: 'city' };
  const state = typeof r.state === 'string' ? r.state.trim().toUpperCase() : '';
  if (!BY_CODE[state]) return { error: 'we ship to u.s. states only', field: 'state' };
  const zip = typeof r.zip === 'string' ? r.zip.trim() : '';
  if (!/^\d{5}(-?\d{4})?$/.test(zip)) return { error: 'zip', field: 'zip' };
  if (!BY_CODE[state].zips.has(Number(zip.slice(0, 3)))) return { error: 'zip not in state', field: 'zip' };
  const zipOut = zip.length > 5 ? zip.slice(0, 5) + '-' + zip.slice(-4) : zip;
  return { ok: true, value: { name, email, line1, line2, city, state, zip: zipOut } };
}

// the gift tick and its note. not a gift: null. a gift with no note is fine: a blank card
export function cleanGift(raw) {
  if (!raw || typeof raw !== 'object' || raw.gift !== true) return null;
  const message = typeof raw.message === 'string'
    ? raw.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    : '';
  if (message.length > GIFT_MAX) return { error: 'gift note too long' };
  return { message };
}

// Square's address shape, for the order's shipment
export function squareAddress(a) {
  return {
    address_line_1: a.line1,
    ...(a.line2 ? { address_line_2: a.line2 } : {}),
    locality: a.city,
    administrative_district_level_1: a.state,
    postal_code: a.zip,
    country: 'US'
  };
}

// one line for notes: "pup person, 1 main st, apt 2, oakland, CA 94607"
export function addressLine(a) {
  return [a.name, a.line1, a.line2, a.city, a.state + ' ' + a.zip].filter(Boolean).join(', ');
}

/* ---------- the owner's list of gift cards to write (/admin) ---------- */

// noted at checkout, before payment. /admin only shows the ones Square says were paid
export async function noteGift(env, orderId, shipTo, gift, shipping, fetchFn = fetch) {
  await firestoreSet(env, 'gifts/' + orderId, {
    createdAt: new Date(), message: gift.message, shipping,
    email: shipTo.email, name: shipTo.name, line1: shipTo.line1, line2: shipTo.line2,
    city: shipTo.city, state: shipTo.state, zip: shipTo.zip
  }, fetchFn);
}

// gift orders that were paid, newest first. ones never paid (a checkout left half way) are left out,
// and dropped from the list after two days so it doesn't fill up
const UNPAID_KEEP_MS = 2 * 24 * 3600 * 1000;
export async function giftList(env, fetchFn = fetch) {
  const notes = await firestoreList(env, 'gifts', 300, fetchFn);
  if (!notes.length) return [];
  const orders = {};
  for (let i = 0; i < notes.length; i += 100) {
    const res = await fetchFn(squareHost(env) + '/v2/orders/batch-retrieve', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: env.SQUARE_LOCATION_ID, order_ids: notes.slice(i, i + 100).map((n) => n.id) })
    });
    if (!res.ok) throw new Error('square orders ' + res.status);
    for (const o of (await res.json()).orders || []) orders[o.id] = o;
  }
  const out = [];
  for (const n of notes) {
    const o = orders[n.id];
    const paid = o && o.tenders && o.tenders.length && o.state !== 'CANCELED';
    if (!paid) {
      const age = Date.now() - new Date(n.createdAt || 0).getTime();
      if (age > UNPAID_KEEP_MS) { try { await firestoreDelete(env, 'gifts/' + n.id, fetchFn); } catch (e) { /* next time */ } }
      continue;
    }
    out.push({
      id: n.id,
      number: n.id.slice(-6).toUpperCase(),
      date: o.closed_at || o.updated_at || o.created_at || n.createdAt,
      message: n.message || '',
      shipping: n.shipping || '',
      email: n.email, name: n.name,
      address: { line1: n.line1, line2: n.line2 || '', city: n.city, state: n.state, zip: n.zip },
      items: (o.line_items || []).map((l) => ({ name: l.name, qty: Number(l.quantity) || 1 }))
    });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}

// the card is written and in the box: off the list
export async function giftDone(env, id, fetchFn = fetch) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return false;
  await firestoreDelete(env, 'gifts/' + id, fetchFn);
  return true;
}
