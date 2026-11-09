// j+k adventures: the photos section under the pup board. Two kinds of photos, shown together:
//   - the owner's own, uploaded per product on /admin (kept in the REVIEW_PHOTOS bucket under media/, listed in
//     Firestore as media/{photo id}: { slug, photo: "id.WxH", alt, createdAt, by })
//   - every photo on an approved review (server/reviews.js). Those stay where they are; this only lists them.
// Like a shop's photo wall: a few pictures we hung ourselves, then the snapshots customers sent in.
//
//   GET /api/media?slug=corgi   one product's photos: ours first (newest first), then the reviews' (newest review first)
//   GET /api/media              every product's photos, the same order, for the whole pack
//   GET /api/media/photo?id=…   one of the owner's photos (anyone: they're public as soon as they're uploaded)
// The owner's side (upload, remove, list) is called from server/admin.js, which has already checked who is asking.

import { configured, firestoreQuery, firestoreSet, firestoreGet, firestoreDelete } from './firebase.js';
import { photosOn, parsePhotos, photoString, readPhoto, newPhotoId, storePhotos, deletePhotos, photoResponse, isPhotoId } from './photos.js';
import { approvedReviewPhotos } from './reviews.js';

export const MAX_MEDIA_PER_PRODUCT = 50; // was 24 until 2026-11-09
// the whole list is read in one go: 50 a product for all 17 products is 850, so this leaves room for new products
const MAX_LISTED = 2000;
const MAX_ALT = 150;
// each Cloudflare location keeps its own copy of the owner's list, and an upload only refreshes the copy where it
// landed, so the others catch up when theirs runs out: one minute, so a new photo shows everywhere within a minute
// or so. (It began at 10 minutes, and the owner's first uploads didn't show for them.)
const CACHE_MS = 60 * 1000;
const FOLDER = 'media';

let mediaCache = { list: null, until: 0 };

function json(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }
  });
}

// a few words about the photo, read aloud to people who can't see it: plain text, one line
export function cleanAlt(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_ALT);
}

// the owner's photos, newest first: [{ id, w, h, slug, alt, date }]
export async function ownerMedia(env, fetchFn = fetch) {
  if (mediaCache.list && Date.now() < mediaCache.until) return mediaCache.list;
  const rows = await firestoreQuery(env, FOLDER, {}, MAX_LISTED, fetchFn);
  const list = rows.map((r) => {
    const p = parsePhotos(r.photo)[0];
    if (!p || p.id !== r.id || typeof r.slug !== 'string') return null;
    return { ...p, slug: r.slug, alt: r.alt || '', date: String(r.createdAt || '').slice(0, 10), at: String(r.createdAt || '') };
  }).filter(Boolean).sort((a, b) => b.at.localeCompare(a.at)).map(({ at, ...rest }) => rest);
  mediaCache = { list, until: Date.now() + CACHE_MS };
  return list;
}
function forgetMedia() { mediaCache = { list: null, until: 0 }; }

export function mediaPhotoUrl(id) { return '/api/media/photo?id=' + encodeURIComponent(id); }
function reviewPhotoUrl(id) { return '/api/reviews/photo?id=' + encodeURIComponent(id); }

// what the page shows: where each picture is, its size (so nothing jumps while it loads) and who it's from
export async function mediaFor(env, slug, fetchFn = fetch) {
  const ours = photosOn(env) ? await ownerMedia(env, fetchFn) : [];
  const theirs = photosOn(env) ? await approvedReviewPhotos(env, fetchFn) : [];
  const want = (p) => !slug || p.slug === slug;
  return [
    ...ours.filter(want).map((p) => ({ src: mediaPhotoUrl(p.id), w: p.w, h: p.h, slug: p.slug, from: 'shop', alt: p.alt })),
    ...theirs.filter(want).map((p) => ({ src: reviewPhotoUrl(p.id), w: p.w, h: p.h, slug: p.slug, from: 'review', name: p.name, date: p.date }))
  ];
}

export async function mediaRoute(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  if (url.pathname === '/api/media/photo') {
    const id = url.searchParams.get('id');
    if (!isPhotoId(id) || !photosOn(env) || !configured(env)) return new Response('not found', { status: 404 });
    try {
      // only a photo still on the list: a removed one stops showing straight away, even if the file lingers
      if (!(await ownerMedia(env, fetchFn)).some((p) => p.id === id)) return new Response('not found', { status: 404 });
      return photoResponse(env, id, 'public, max-age=3600', FOLDER);
    } catch (e) {
      console.log('media photo error', e.message);
      return new Response('unavailable', { status: 503 });
    }
  }
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  const slug = url.searchParams.get('slug');
  if (slug !== null && !/^[a-z0-9-]{1,40}$/.test(slug)) return json({ error: 'slug' }, 400);
  try {
    return json({ photos: await mediaFor(env, slug, fetchFn) }, 200, 'public, max-age=60');
  } catch (e) {
    console.log('media error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

/* ---------- the owner's side (server/admin.js) ---------- */

// every photo the owner has uploaded, with the id needed to remove one
export async function adminMedia(env, fetchFn = fetch) {
  forgetMedia();
  const list = photosOn(env) ? await ownerMedia(env, fetchFn) : [];
  return { on: photosOn(env), max: MAX_MEDIA_PER_PRODUCT, photos: list.map((p) => ({ ...p, src: mediaPhotoUrl(p.id) })) };
}

// { slug, jpeg: "<base64>", alt }. slugs: the website's products (products.json)
export async function addMedia(env, body, slugs, who, fetchFn = fetch) {
  if (!photosOn(env)) return { error: 'photos off', status: 503 };
  if (!body || typeof body.slug !== 'string' || !slugs.has(body.slug)) return { error: 'unknown product' };
  const pic = readPhoto(body.jpeg);
  if (!pic) return { error: 'photo' };
  forgetMedia();
  const already = (await ownerMedia(env, fetchFn)).filter((p) => p.slug === body.slug).length;
  if (already >= MAX_MEDIA_PER_PRODUCT) return { error: 'too many', max: MAX_MEDIA_PER_PRODUCT };
  const p = { id: newPhotoId(), w: pic.w, h: pic.h, bytes: pic.bytes };
  await storePhotos(env, [p], FOLDER);
  try {
    await firestoreSet(env, FOLDER + '/' + p.id, {
      slug: body.slug, photo: photoString([p]), alt: cleanAlt(body.alt), createdAt: new Date(), by: who || ''
    }, fetchFn);
  } catch (e) {
    await deletePhotos(env, [p.id], FOLDER);
    throw e;
  }
  forgetMedia();
  return { saved: true, id: p.id };
}

export async function removeMedia(env, id, fetchFn = fetch) {
  if (!isPhotoId(id)) return { error: 'no such photo', status: 404 };
  const path = FOLDER + '/' + id;
  if (!(await firestoreGet(env, path, fetchFn))) return { error: 'no such photo', status: 404 };
  await firestoreDelete(env, path, fetchFn);
  await deletePhotos(env, [id], FOLDER);
  forgetMedia();
  return { deleted: true };
}

// for tests
export function _resetMediaCache() { forgetMedia(); }
