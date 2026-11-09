// j+k adventures: /api/reviews. Star ratings and short notes on the pins.
//   GET    /api/reviews?slug=corgi   approved reviews for one pin and their average. With a ticket, also your own.
//   GET    /api/reviews?featured=1   approved 4 and 5 star reviews with words, newest first, for the home page
//   POST   /api/reviews              { slug, rating, text }: leave or replace your review. Needs a confirmed email.
//                                    Without a ticket, a guest review: { slug, rating, text, name, email }
//   DELETE /api/reviews?slug=corgi   remove your review (and its photos)
//   GET    /api/reviews/photo?id=…   one review photo. Anyone, once its review is approved. Before that, only the
//                                    writer (with their ticket and &slug=) or the owner (/api/admin/photo)
// A POST may carry photos: [{ keep: "<id>" } | { jpeg: "<base64>" }], at most 4 (server/photos.js). Leaving
// "photos" out keeps the ones the review had. Photos wait for the owner with the rest of the review.
// One review per person per pin, stored as reviews/{slug}_{uid}.
// Guests (no account): one review per email per pin, stored as reviews/{slug}_g{who} (who = the email scrambled),
// with the email kept so the review can join their account later. Never shown: only "first l." is. The email has
// to look right and its domain has to take mail; at most GUEST_PER_DAY guest reviews a day from one connection.
// When someone signs in with a confirmed email (POST /api/account), any guest reviews left with that email move
// into their account (claimGuestReviews), so a guest who ticked "create an account" finds them there. Every new or changed review is "pending"
// until the owner approves it on /admin (or hides it: kept, never shown). See docs/setup/reviews.md.
// The ratings shown are never filtered by stars: only the home page picks out the 4 and 5 star ones.

import { configured, userFromRequest, firestoreGet, firestoreSet, firestoreUpdate, firestoreQuery, firestoreDelete, firestoreCommit } from './firebase.js';
import { scramble } from './interest.js';
import { cleanEmail, domainTakesMail, productNoun } from './notify.js';
import { alertReview } from './owner-alerts.js';
import { photosOn, parsePhotos, photoString, planPhotos, storePhotos, deletePhotos, photoResponse, isPhotoId } from './photos.js';

const MAX_TEXT = 600;
export const GUEST_PER_DAY = 5;
const FEATURED = 6;
const MAX_BODY = 4 * 1024 * 1024; // four photos as text, with room to spare
const CACHE_MS = 10 * 60 * 1000; // approved reviews are re-read at most every 10 minutes per server

let approvedCache = { list: null, until: 0 };

function json(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }
  });
}

// the note: no control characters (newlines are fine) or angle brackets, at most three lines in a row
export function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f<>]/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_TEXT);
}

export function reviewId(slug, uid) { return slug + '_' + uid; }

// what anyone may see: never the uid
function publicView(r) {
  return {
    slug: r.slug, rating: r.rating, text: r.text || '', name: r.name || 'a collector', date: String(r.createdAt || '').slice(0, 10),
    photos: parsePhotos(r.photos)
  };
}

// "juniper h." from the account's first and last name
function displayName(doc) {
  const first = String((doc && (doc.firstName || doc.displayName)) || '').trim().split(' ')[0];
  const last = String((doc && doc.lastName) || '').trim();
  if (!first) return 'a collector';
  return last ? first + ' ' + last[0] + '.' : first;
}

async function approved(env, fetchFn) {
  if (approvedCache.list && Date.now() < approvedCache.until) return approvedCache.list;
  const list = (await firestoreQuery(env, 'reviews', { status: 'approved' }, 1000, fetchFn))
    .filter((r) => r.rating >= 1 && r.rating <= 5)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  approvedCache = { list, until: Date.now() + CACHE_MS };
  return list;
}

// one pin's approved reviews and their average, for the hidden product card on its own page (server/pup-pages.js).
// null when reviews aren't set up
export async function pinReviews(env, slug, fetchFn = fetch) {
  if (!configured(env)) return null;
  const list = (await approved(env, fetchFn)).filter((r) => r.slug === slug);
  const sum = list.reduce((n, r) => n + r.rating, 0);
  return { count: list.length, average: list.length ? Math.round((sum / list.length) * 10) / 10 : null, reviews: list.map(publicView) };
}

// every photo on an approved review, newest review first, for the photos section under the pup board
// (server/media.js). [] when reviews aren't set up
export async function approvedReviewPhotos(env, fetchFn = fetch) {
  if (!configured(env)) return [];
  const out = [];
  for (const r of await approved(env, fetchFn)) {
    const view = publicView(r);
    view.photos.forEach((p) => out.push({ ...p, slug: view.slug, name: view.name, date: view.date }));
  }
  return out;
}

// "the corgi pin", for the owner's "a review is waiting" email
async function pinNoun(request, env, slug) {
  try {
    const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
    const p = ((await res.json()).items || []).find((x) => x.slug === slug);
    return p ? 'the ' + productNoun(p) : 'the ' + slug + ' pin';
  } catch (e) { return 'the ' + slug + ' pin'; }
}
// a bell in the back room: the owner hears there's a review to look at. never stops the review being saved
async function ringOwner(request, env, r, fetchFn) {
  await alertReview(env, new URL(request.url).origin, {
    id: r.id, at: r.at, slug: r.slug, noun: await pinNoun(request, env, r.slug), name: r.name, rating: r.rating,
    text: r.text, photos: r.photos, guest: !!r.guest
  }, fetchFn);
}

async function pinSlugs(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
  if (!res.ok) throw new Error('catalog ' + res.status);
  const catalog = await res.json();
  return (catalog.items || []).filter((p) => p.kind === 'pin').map((p) => p.slug);
}

export async function reviews(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (url.pathname === '/api/reviews/photo') return photo(request, env, url, fetchFn);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  if (request.method === 'POST' && Number(request.headers.get('Content-Length') || 0) > MAX_BODY) return json({ error: 'too big' }, 413);

  try {
    if (request.method === 'GET' && url.searchParams.get('featured')) {
      const list = (await approved(env, fetchFn)).filter((r) => r.rating >= 4 && r.text);
      return json({ reviews: list.slice(0, FEATURED).map(publicView) }, 200, 'public, max-age=300');
    }

    const slug = request.method === 'POST' ? null : url.searchParams.get('slug');
    let user = null;
    if (request.headers.get('Authorization')) {
      user = await userFromRequest(request, env, fetchFn);
      if (!user) return json({ error: 'signed out' }, 401);
    }

    if (request.method === 'GET') {
      if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug)) return json({ error: 'slug' }, 400);
      const list = (await approved(env, fetchFn)).filter((r) => r.slug === slug);
      const sum = list.reduce((n, r) => n + r.rating, 0);
      const body = {
        count: list.length,
        average: list.length ? Math.round((sum / list.length) * 10) / 10 : null,
        reviews: list.map(publicView),
        // the photo picker only shows once the photo bucket is set up
        photos: photosOn(env)
      };
      if (!user) return json(body, 200, 'public, max-age=300');
      const mine = await firestoreGet(env, 'reviews/' + encodeURIComponent(reviewId(slug, user.sub)), fetchFn);
      body.mine = mine ? { rating: mine.rating, text: mine.text || '', status: mine.status, photos: parsePhotos(mine.photos) } : null;
      return json(body);
    }

    // no ticket at all: a guest leaving a review
    if (!user && request.method === 'POST') return guestReview(request, env, fetchFn);
    if (!user) return json({ error: 'signed out' }, 401);

    if (request.method === 'DELETE') {
      if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug)) return json({ error: 'slug' }, 400);
      const path = 'reviews/' + encodeURIComponent(reviewId(slug, user.sub));
      const had = await firestoreGet(env, path, fetchFn);
      await firestoreDelete(env, path, fetchFn);
      if (had) await deletePhotos(env, parsePhotos(had.photos).map((p) => p.id));
      approvedCache = { list: null, until: 0 };
      return json({ deleted: true });
    }

    // POST: leave or replace a review
    if (user.email_verified !== true) return json({ error: 'confirm email' }, 403);
    let body = {};
    try { body = await request.json(); } catch (e) {}
    body = body || {};
    const rating = body.rating;
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: 'rating' }, 400);
    if (typeof body.slug !== 'string' || !(await pinSlugs(request, env)).includes(body.slug)) return json({ error: 'slug' }, 400);
    const text = cleanText(body.text);
    const path = 'reviews/' + encodeURIComponent(reviewId(body.slug, user.sub));
    const before = await firestoreGet(env, path, fetchFn);
    const plan = planPhotos(env, body.photos, before && before.photos);
    if (plan.error) return json({ error: plan.error }, 400);
    const profile = await firestoreGet(env, 'users/' + encodeURIComponent(user.sub), fetchFn);
    const now = new Date();
    await storePhotos(env, plan.add);
    try {
      await firestoreSet(env, path, {
        slug: body.slug,
        uid: user.sub,
        rating,
        text,
        photos: photoString(plan.list),
        name: displayName(profile),
        // a changed review goes back to the owner for another look
        status: 'pending',
        createdAt: before && before.createdAt ? new Date(before.createdAt) : now,
        updatedAt: now
      }, fetchFn);
    } catch (e) {
      await deletePhotos(env, plan.add.map((p) => p.id));
      throw e;
    }
    await deletePhotos(env, plan.remove);
    if (before && before.status === 'approved') approvedCache = { list: null, until: 0 };
    await ringOwner(request, env, { id: reviewId(body.slug, user.sub), at: now.toISOString(), slug: body.slug, name: displayName(profile), rating, text, photos: plan.list.length }, fetchFn);
    return json({ saved: true, status: 'pending' });
  } catch (e) {
    console.log('reviews error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

// a guest's name, as typed ("juniper hsu"), becomes "juniper h." like an account's
export function guestName(s) {
  const words = String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40).split(' ').filter(Boolean);
  return displayName({ firstName: words[0] || '', lastName: words.slice(1).join(' ') });
}

async function guestReview(request, env, fetchFn) {
  let body = {};
  try { body = (await request.json()) || {}; } catch (e) {}
  const rating = body.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: 'rating' }, 400);
  if (typeof body.slug !== 'string' || !(await pinSlugs(request, env)).includes(body.slug)) return json({ error: 'slug' }, 400);
  const name = guestName(body.name);
  if (name === 'a collector') return json({ error: 'name' }, 400);
  const email = cleanEmail(body.email);
  if (!email) return json({ error: 'email' }, 400);

  const who = await scramble(env, 'email|' + email);
  const path = 'reviews/' + encodeURIComponent(reviewId(body.slug, 'g' + who));
  // one per email per pin. a guest can't change it later (there's no sign-in to prove it's them): they write to us
  if (await firestoreGet(env, path, fetchFn)) return json({ error: 'already' });

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipPath = 'review_ips/' + (await scramble(env, 'review-ip|' + day + '|' + ip));
  const fromHere = await firestoreGet(env, ipPath, fetchFn);
  if (fromHere && fromHere.count >= GUEST_PER_DAY) return json({ error: 'limit' }, 429);
  // a mistyped domain gets a plain answer, not an error status: it isn't a broken request
  if ((await domainTakesMail(email.split('@')[1], fetchFn)) === false) return json({ error: 'domain' });
  // a guest has nothing to keep: every photo is new
  const plan = planPhotos(env, body.photos === undefined ? [] : body.photos, '');
  if (plan.error) return json({ error: plan.error }, 400);

  const now = new Date();
  await storePhotos(env, plan.add);
  try {
    await firestoreSet(env, path, {
      slug: body.slug, guest: true, who, email, rating, text: cleanText(body.text), photos: photoString(plan.list), name,
      status: 'pending', createdAt: now, updatedAt: now
    }, fetchFn);
  } catch (e) {
    await deletePhotos(env, plan.add.map((p) => p.id));
    throw e;
  }
  await firestoreCommit(env, [{ add: ipPath, field: 'count', data: { day } }], fetchFn);
  await ringOwner(request, env, { id: reviewId(body.slug, 'g' + who), at: now.toISOString(), slug: body.slug, name, rating, text: cleanText(body.text), photos: plan.list.length, guest: true }, fetchFn);
  return json({ saved: true, status: 'pending' });
}

// Someone signed in with a confirmed email: guest reviews left with that address move into their account, as if
// they had written them signed in. Only a confirmed email counts, so nobody can claim reviews with someone else's
// address. If they already have a review of that pin from their account, theirs stays and the guest one goes.
export async function claimGuestReviews(env, user, fetchFn = fetch) {
  if (!user || user.email_verified !== true || typeof user.email !== 'string') return 0;
  const email = cleanEmail(user.email);
  if (!email) return 0;
  const who = await scramble(env, 'email|' + email);
  const left = await firestoreQuery(env, 'reviews', { who }, 100, fetchFn);
  let moved = 0;
  for (const r of left) {
    if (r.guest !== true) continue;
    const from = 'reviews/' + encodeURIComponent(r.id);
    const to = 'reviews/' + encodeURIComponent(reviewId(r.slug, user.sub));
    if (!(await firestoreGet(env, to, fetchFn))) {
      await firestoreSet(env, to, {
        slug: r.slug, uid: user.sub, rating: r.rating, text: r.text || '', photos: r.photos || '', name: r.name, status: r.status,
        createdAt: new Date(r.createdAt), updatedAt: new Date()
      }, fetchFn);
      moved++;
    } else {
      // the account's own review of that pin stays, so the guest copy's photos go with it
      await deletePhotos(env, parsePhotos(r.photos).map((p) => p.id));
    }
    await firestoreDelete(env, from, fetchFn);
  }
  if (moved) approvedCache = { list: null, until: 0 };
  return moved;
}

// account deletion: remove everything this person wrote
export async function deleteReviewsBy(env, uid, fetchFn = fetch) {
  const mine = await firestoreQuery(env, 'reviews', { uid }, 100, fetchFn);
  for (const r of mine) {
    await firestoreDelete(env, 'reviews/' + encodeURIComponent(r.id), fetchFn);
    await deletePhotos(env, parsePhotos(r.photos).map((p) => p.id));
  }
  if (mine.length) approvedCache = { list: null, until: 0 };
}

/* ---------- the owner's side (called from server/admin.js, which has already checked who is asking) ---------- */
export const REVIEW_STATUSES = ['approved', 'hidden'];

// reviews waiting for a look, oldest first, with the id the owner needs to approve or hide one
export async function pendingReviews(env, fetchFn = fetch) {
  const list = await firestoreQuery(env, 'reviews', { status: 'pending' }, 500, fetchFn);
  return list.sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)))
    .map((r) => ({ id: r.id, ...publicView(r), guest: r.guest === true }));
}

// returns false if there is no such review
export async function setReviewStatus(env, id, status, who, fetchFn = fetch) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}_[A-Za-z0-9]{1,128}$/.test(id)) return false;
  if (!REVIEW_STATUSES.includes(status)) return false;
  const path = 'reviews/' + encodeURIComponent(id);
  if (!(await firestoreGet(env, path, fetchFn))) return false;
  await firestoreUpdate(env, path, { status, reviewedAt: new Date(), reviewedBy: who || '' }, fetchFn);
  approvedCache = { list: null, until: 0 };
  return true;
}

// One photo. Once its review is approved anyone may see it (the id is only ever handed out with the review).
// Before that only its writer: their ticket, and &slug= so we know which of their reviews to look in.
// A guest's waiting photos can't be shown back to them, since there's no sign-in to prove it's them.
async function photo(request, env, url, fetchFn) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  const id = url.searchParams.get('id');
  if (!isPhotoId(id) || !photosOn(env) || !configured(env)) return new Response('not found', { status: 404 });
  try {
    const shown = (await approved(env, fetchFn)).some((r) => parsePhotos(r.photos).some((p) => p.id === id));
    if (shown) return photoResponse(env, id, 'public, max-age=3600');
    const slug = url.searchParams.get('slug');
    if (request.headers.get('Authorization') && slug && /^[a-z0-9-]{1,40}$/.test(slug)) {
      const user = await userFromRequest(request, env, fetchFn);
      const mine = user && await firestoreGet(env, 'reviews/' + encodeURIComponent(reviewId(slug, user.sub)), fetchFn);
      if (mine && parsePhotos(mine.photos).some((p) => p.id === id)) return photoResponse(env, id, 'private, no-store');
    }
    return new Response('not found', { status: 404 });
  } catch (e) {
    console.log('review photo error', e.message);
    return new Response('unavailable', { status: 503 });
  }
}

// the owner looks at any review's photos on /admin (server/admin.js has already checked who is asking)
export function ownerPhoto(env, id) { return photoResponse(env, id, 'private, no-store'); }

// for tests
export function _resetReviewCache() { approvedCache = { list: null, until: 0 }; }
