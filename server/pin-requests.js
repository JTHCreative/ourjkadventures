// j+k adventures: pin requests. "don't see your pup here? tell us which breed you'd like to see!"
// Like the suggestion jar on the craft fair table: anyone can drop a slip in, nobody else reads it, and the owner
// empties it on /admin. Nothing is sent back to the person who asked (there's no promise a pin will be made).
//
//   POST /api/pin-request   { set, about, name?, email?, website? }
//        -> { status: "added" | "limit" } or { error: "set" | "about" | "name" | "email" | "domain" }
//   (owner, through server/admin.js) listRequests and removeRequest
//
// set: which pin set it's for, one of SETS (the same series names as products.json). about: what they'd like to see,
// in their own words. name and email are both optional: the email is only there so we can write back if we want to.
// It's checked the same way as the "email me when it's here" list (looks like an email, and the domain takes mail).
// website: a box people can't see. a person leaves it empty; a spam robot fills in every box it finds, so a request
// with it filled in is thanked and quietly dropped.
//
// Firestore, server only. "<mode>" is the Square mode, so practising never touches the real list:
//   pin_requests_<mode>/{random id}   { set, about, name, email, createdAt }
//   pin_request_ips_<mode>/{h}        requests from one connection on one day (scrambled with the day, like the votes)
// The owner gets "a pin request" at ADMIN_EMAILS (server/owner-alerts.js), at most a few a day.

import { configured, firestoreGet, firestoreSet, firestoreList, firestoreCommit } from './firebase.js';
import { squareMode } from './square.js';
import { scramble } from './interest.js';
import { cleanEmail, domainTakesMail } from './notify.js';
import { fromOurSite } from './same-site.js';
import { alertPinRequest } from './owner-alerts.js';

// the pin sets someone can ask for, in the order the page lists them
export const SETS = { 'pup-club': 'pup club', hometown: 'hometown series', zodiac: 'chinese zodiac' };
export const REQUESTS_PER_DAY = 5;
export const MAX_ABOUT = 1000;
export const MAX_NAME = 60;
// how many the owner's list shows at once (the oldest past this wait until newer ones are removed)
const LIST_MAX = 300;

function list(env) { return 'pin_requests_' + squareMode(env); }
function ips(env) { return 'pin_request_ips_' + squareMode(env); }

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

// one line or a few paragraphs of plain words: no control characters, runs of blank lines squeezed to one
function cleanWords(s, max, keepLines) {
  if (typeof s !== 'string') return '';
  let t = s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  t = keepLines ? t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n') : t.replace(/\s+/g, ' ');
  t = t.trim();
  return t.length > max ? null : t;
}

// { value: { set, about, name, email } } or { error }
export function cleanRequest(body) {
  const b = body || {};
  if (typeof b.set !== 'string' || !Object.prototype.hasOwnProperty.call(SETS, b.set)) return { error: 'set' };
  const about = cleanWords(b.about, MAX_ABOUT, true);
  if (!about || about.length < 2) return { error: 'about' };
  const name = cleanWords(b.name === undefined ? '' : b.name, MAX_NAME, false);
  if (name === null) return { error: 'name' };
  let email = '';
  if (typeof b.email === 'string' && b.email.trim()) {
    email = cleanEmail(b.email);
    if (!email) return { error: 'email' };
  }
  return { value: { set: b.set, about, name, email } };
}

/* ---------- the public side ---------- */
export async function pinRequestRoute(request, env, fetchFn = fetch) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  if (!fromOurSite(request)) return json({ error: 'origin' }, 403);
  let body = {};
  try { body = (await request.json()) || {}; } catch (e) { return json({ error: 'bad request' }, 400); }
  try {
    return json(...(await addRequest(env, request, body, fetchFn)));
  } catch (e) {
    console.log('pin request error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

async function addRequest(env, request, body, fetchFn) {
  const clean = cleanRequest(body);
  if (clean.error) return [{ error: clean.error }, 400];
  // the hidden box was filled in: a robot. it hears the same "thank you" a person would, and nothing is kept
  if (typeof body.website === 'string' && body.website.trim()) return [{ status: 'added' }];

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipPath = ips(env) + '/' + (await scramble(env, 'pin-request-ip|' + day + '|' + ip));
  const fromHere = await firestoreGet(env, ipPath, fetchFn);
  if (fromHere && fromHere.count >= REQUESTS_PER_DAY) return [{ status: 'limit' }];

  const r = clean.value;
  // an ordinary answer, not an error: a mistyped email isn't a broken request
  if (r.email && (await domainTakesMail(r.email.split('@')[1], fetchFn)) === false) return [{ error: 'domain' }];

  const id = crypto.randomUUID().replace(/-/g, '');
  const createdAt = new Date();
  await firestoreSet(env, list(env) + '/' + id, { ...r, createdAt }, fetchFn);
  await firestoreCommit(env, [{ add: ipPath, field: 'count', data: { day } }], fetchFn);
  // a bell in the back room. never stops the request: it's saved and on /admin either way
  await alertPinRequest(env, new URL(request.url).origin, { id, setName: SETS[r.set], ...r }, fetchFn);
  return [{ status: 'added' }];
}

/* ---------- the owner's side (server/admin.js has already checked who is asking) ---------- */
// newest first: { requests: [{ id, set, setName, about, name, email, at }], sets }
export async function listRequests(env, fetchFn = fetch) {
  const rows = await firestoreList(env, list(env), LIST_MAX, fetchFn);
  const requests = rows.map((d) => ({
    id: d.id, set: d.set, setName: SETS[d.set] || d.set, about: d.about || '', name: d.name || '', email: d.email || '',
    at: d.createdAt ? new Date(d.createdAt).toISOString() : ''
  }));
  requests.sort((a, b) => b.at.localeCompare(a.at));
  return { requests, sets: SETS };
}

// { removed: true } or { error, status }
export async function removeRequest(env, id, fetchFn = fetch) {
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/.test(id)) return { error: 'id', status: 400 };
  const path = list(env) + '/' + id;
  if (!(await firestoreGet(env, path, fetchFn))) return { error: 'no such request', status: 404 };
  await firestoreCommit(env, [{ remove: path, any: true }], fetchFn);
  return { removed: true };
}
