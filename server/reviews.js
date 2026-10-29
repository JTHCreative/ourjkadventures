// j+k adventures: /api/reviews. Star ratings and short notes on the pins.
//   GET    /api/reviews?slug=corgi   approved reviews for one pin and their average. With a ticket, also your own.
//   GET    /api/reviews?featured=1   approved 4 and 5 star reviews with words, newest first, for the home page
//   POST   /api/reviews              { slug, rating, text }: leave or replace your review. Needs a confirmed email.
//   DELETE /api/reviews?slug=corgi   remove your review
// One review per person per pin, stored as reviews/{slug}_{uid}. Every new or changed review is "pending"
// until the owner sets its status to "approved" in the Firebase console (docs/setup/reviews.md).
// The ratings shown are never filtered by stars: only the home page picks out the 4 and 5 star ones.

import { configured, userFromRequest, firestoreGet, firestoreSet, firestoreQuery, firestoreDelete } from './firebase.js';

const MAX_TEXT = 600;
const FEATURED = 6;
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
  return { slug: r.slug, rating: r.rating, text: r.text || '', name: r.name || 'a collector', date: String(r.createdAt || '').slice(0, 10) };
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

async function pinSlugs(request, env) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', request.url)));
  if (!res.ok) throw new Error('catalog ' + res.status);
  const catalog = await res.json();
  return (catalog.items || []).filter((p) => p.kind === 'pin').map((p) => p.slug);
}

export async function reviews(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);

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
        reviews: list.map(publicView)
      };
      if (!user) return json(body, 200, 'public, max-age=300');
      const mine = await firestoreGet(env, 'reviews/' + encodeURIComponent(reviewId(slug, user.sub)), fetchFn);
      body.mine = mine ? { rating: mine.rating, text: mine.text || '', status: mine.status } : null;
      return json(body);
    }

    if (!user) return json({ error: 'signed out' }, 401);

    if (request.method === 'DELETE') {
      if (!slug || !/^[a-z0-9-]{1,40}$/.test(slug)) return json({ error: 'slug' }, 400);
      await firestoreDelete(env, 'reviews/' + encodeURIComponent(reviewId(slug, user.sub)), fetchFn);
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
    const profile = await firestoreGet(env, 'users/' + encodeURIComponent(user.sub), fetchFn);
    const now = new Date();
    await firestoreSet(env, path, {
      slug: body.slug,
      uid: user.sub,
      rating,
      text,
      name: displayName(profile),
      // a changed review goes back to the owner for another look
      status: 'pending',
      createdAt: before && before.createdAt ? new Date(before.createdAt) : now,
      updatedAt: now
    }, fetchFn);
    if (before && before.status === 'approved') approvedCache = { list: null, until: 0 };
    return json({ saved: true, status: 'pending' });
  } catch (e) {
    console.log('reviews error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

// account deletion: remove everything this person wrote
export async function deleteReviewsBy(env, uid, fetchFn = fetch) {
  const mine = await firestoreQuery(env, 'reviews', { uid }, 100, fetchFn);
  for (const r of mine) await firestoreDelete(env, 'reviews/' + encodeURIComponent(r.id), fetchFn);
  if (mine.length) approvedCache = { list: null, until: 0 };
}

// for tests
export function _resetReviewCache() { approvedCache = { list: null, until: 0 }; }
