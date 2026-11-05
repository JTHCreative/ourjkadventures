// Tests for review photos: up to four per review, kept in R2 (faked here), checked and cleaned by the server,
// and shown to everyone only once the review is approved.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCaches } from '../server/firebase.js';
import { reviews, setReviewStatus, pendingReviews, _resetReviewCache } from '../server/reviews.js';
import { cleanJpeg, parsePhotos, photoString, MAX_PHOTO_BYTES } from '../server/photos.js';
import { admin } from '../server/admin.js';
import { account } from '../server/account.js';
import { sign, fakeGoogle, env as baseEnv } from './helpers.mjs';

const catalog = { items: [{ slug: 'corgi', name: 'corgi', kind: 'pin' }, { slug: 'pug', name: 'pug', kind: 'pin' }] };

// a pretend R2 bucket
function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, new Uint8Array(v)); },
    async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); }
  };
}

// the smallest JPEG-shaped file: start, a JFIF block, a camera EXIF block with a "location", the size block
// (width 640, height 480), a comment, the picture data, end
const seg = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
const GPS = [...Buffer.from('Exif\0\0GPS 37.77N 122.41W')];
function jpeg({ w = 640, h = 480, exif = true } = {}) {
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif ? seg(0xe1, GPS) : []),
    ...seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    ...seg(0xfe, [...Buffer.from('taken on a pixel')]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0x56,
    0xff, 0xd9
  ]);
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function world() {
  _resetCaches();
  _resetReviewCache();
  const g = fakeGoogle();
  g.docs['users/uid123'] = { firstName: { stringValue: 'juniper' }, lastName: { stringValue: 'hart' } };
  const bucket = fakeBucket();
  const env = { ...baseEnv, ADMIN_EMAILS: 'owner@example.com', REVIEW_PHOTOS: bucket, ASSETS: { fetch: async () => Response.json(catalog) } };
  const fetchFn = async (url, opts) => {
    if (String(url).startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [{ type: 15, data: '10 mx.example.com.' }] });
    return g.fetchFn(url, opts);
  };
  return { g, bucket, env, fetchFn };
}
const post = (w, token, body) => reviews(new Request('https://x.test/api/reviews', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body)
}), w.env, w.fetchFn);
const getPin = async (w, slug, token) => (await reviews(new Request('https://x.test/api/reviews?slug=' + slug, {
  headers: token ? { Authorization: 'Bearer ' + token } : {}
}), w.env, w.fetchFn)).json();
const photo = (w, id, token, slug) => reviews(new Request('https://x.test/api/reviews/photo?id=' + id + (slug ? '&slug=' + slug : ''), {
  headers: token ? { Authorization: 'Bearer ' + token } : {}
}), w.env, w.fetchFn);
const approve = async (w, id) => { await setReviewStatus(w.env, id, 'approved', 'owner', w.fetchFn); _resetReviewCache(); };
const storedIds = (w) => [...w.bucket.store.keys()].map((k) => k.slice('reviews/'.length, -4)).sort();

test('a photo is checked and cleaned: a real JPEG, a sensible size, and the camera notes taken out', () => {
  const clean = cleanJpeg(jpeg());
  assert.equal(clean.w, 640);
  assert.equal(clean.h, 480);
  const text = Buffer.from(clean.bytes).toString('latin1');
  assert.ok(!text.includes('GPS'), 'location gone');
  assert.ok(!text.includes('pixel'), 'comment gone');
  assert.ok(text.includes('JFIF'), 'picture blocks kept');
  assert.deepEqual([...clean.bytes.slice(-2)], [0xff, 0xd9]);

  assert.equal(cleanJpeg(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0])), null, 'a PNG is not a JPEG');
  assert.equal(cleanJpeg(jpeg().slice(0, 30)), null, 'cut short');
  assert.equal(cleanJpeg(jpeg({ w: 9000 })), null, 'far too wide');
  assert.equal(cleanJpeg(new TextEncoder().encode('<svg onload=alert(1)>')), null);
});

test('photos are written as one line in Firestore and read back the same', () => {
  const list = [{ id: 'a'.repeat(32), w: 1600, h: 1200 }, { id: 'b'.repeat(32), w: 900, h: 1600 }];
  assert.deepEqual(parsePhotos(photoString(list)), list);
  assert.deepEqual(parsePhotos('nonsense,../../x.1x1'), []);
  assert.deepEqual(parsePhotos(undefined), []);
});

test('a review can carry up to four photos, which wait with it and show once it is approved', async () => {
  const w = world();
  const tok = await sign({});
  const pics = [1, 2, 3].map(() => ({ jpeg: b64(jpeg()) }));
  assert.equal((await post(w, tok, { slug: 'corgi', rating: 5, text: 'the ears.', photos: pics })).status, 200);
  assert.equal(w.bucket.store.size, 3);
  const stored = [...w.bucket.store.values()][0];
  assert.ok(!Buffer.from(stored).toString('latin1').includes('GPS'), 'stored without the location');

  // waiting: the public sees no review and can't open the photo; the writer can
  const mine = (await getPin(w, 'corgi', tok)).mine;
  assert.equal(mine.photos.length, 3);
  assert.deepEqual({ w: mine.photos[0].w, h: mine.photos[0].h }, { w: 640, h: 480 });
  const id = mine.photos[0].id;
  assert.equal((await photo(w, id)).status, 404);
  assert.equal((await photo(w, id, await sign({ sub: 'someone-else' }), 'corgi')).status, 404);
  const own = await photo(w, id, tok, 'corgi');
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('Cache-Control'), 'private, no-store');

  // the owner sees them on /admin, and can open them there
  const waiting = await pendingReviews(w.env, w.fetchFn);
  assert.equal(waiting[0].photos.length, 3);
  const ownerAsk = (token) => admin(new Request('https://x.test/api/admin/photo?id=' + id, { headers: { Authorization: 'Bearer ' + token } }), w.env, w.fetchFn);
  assert.equal((await ownerAsk(await sign({ email: 'owner@example.com' }))).status, 200);
  assert.equal((await ownerAsk(tok)).status, 403);

  await approve(w, 'corgi_uid123');
  const pin = await getPin(w, 'corgi');
  assert.equal(pin.photos, true);
  assert.equal(pin.reviews[0].photos.length, 3);
  const open = await photo(w, id);
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('Content-Type'), 'image/jpeg');
  assert.equal(open.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(open.headers.get('Cache-Control'), /^public/);
});

test('editing keeps the photos asked for, removes the rest, and goes back for another look', async () => {
  const w = world();
  const tok = await sign({});
  await post(w, tok, { slug: 'corgi', rating: 5, photos: [{ jpeg: b64(jpeg()) }, { jpeg: b64(jpeg()) }] });
  await approve(w, 'corgi_uid123');
  const [a, b] = (await getPin(w, 'corgi', tok)).mine.photos.map((p) => p.id);

  // keep the second, add a new one: the first is gone from the bucket
  assert.equal((await post(w, tok, { slug: 'corgi', rating: 4, photos: [{ keep: b }, { jpeg: b64(jpeg({ w: 480, h: 640 })) }] })).status, 200);
  const now = (await getPin(w, 'corgi', tok)).mine;
  assert.equal(now.status, 'pending');
  assert.equal(now.photos[0].id, b);
  assert.deepEqual({ w: now.photos[1].w, h: now.photos[1].h }, { w: 480, h: 640 });
  assert.ok(!storedIds(w).includes(a));
  assert.equal(w.bucket.store.size, 2);

  // leaving "photos" out (an older page) keeps them as they were
  await post(w, tok, { slug: 'corgi', rating: 4, text: 'still love it' });
  assert.equal((await getPin(w, 'corgi', tok)).mine.photos.length, 2);

  // removing the review removes its photos
  await reviews(new Request('https://x.test/api/reviews?slug=corgi', { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok } }), w.env, w.fetchFn);
  assert.equal(w.bucket.store.size, 0);
});

test('bad photos are refused and nothing is stored', async () => {
  const w = world();
  const tok = await sign({});
  const sent = async (photos) => { const r = await post(w, tok, { slug: 'corgi', rating: 5, photos }); return [r.status, (await r.json()).error]; };
  const one = { jpeg: b64(jpeg()) };
  assert.deepEqual(await sent([one, one, one, one, one]), [400, 'photos'], 'five is one too many');
  assert.deepEqual(await sent([{ jpeg: b64(new TextEncoder().encode('GIF89a')) }]), [400, 'photo']);
  assert.deepEqual(await sent([{ jpeg: 'not base64 at all!' }]), [400, 'photo']);
  assert.deepEqual(await sent([{ jpeg: 'A'.repeat(Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 8) }]), [400, 'photo'], 'too big');
  assert.deepEqual(await sent([{ keep: 'f'.repeat(32) }]), [400, 'photos'], "can't keep a photo that isn't yours");
  assert.deepEqual(await sent('a picture'), [400, 'photos']);
  assert.equal(w.bucket.store.size, 0);
  assert.equal(w.g.docs['reviews/corgi_uid123'], undefined);

  // a request far too big to be four photos is turned away before it is read
  const huge = await reviews(new Request('https://x.test/api/reviews', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(10 * 1024 * 1024), Authorization: 'Bearer ' + tok }, body: '{}'
  }), w.env, w.fetchFn);
  assert.equal(huge.status, 413);
});

test('before the photo bucket is set up, reviews work as before and photos are politely refused', async () => {
  const w = world();
  delete w.env.REVIEW_PHOTOS;
  const tok = await sign({});
  assert.equal((await getPin(w, 'corgi')).photos, false);
  const r = await post(w, tok, { slug: 'corgi', rating: 5, photos: [{ jpeg: b64(jpeg()) }] });
  assert.deepEqual([r.status, (await r.json()).error], [400, 'photos off']);
  assert.equal((await post(w, tok, { slug: 'corgi', rating: 5, photos: [] })).status, 200);
});

test('guests can add photos too; they follow the review into an account, and go when the account is deleted', async () => {
  const w = world();
  const g = await post(w, null, { slug: 'pug', rating: 5, name: 'june hsu', email: 'pup@example.com', photos: [{ jpeg: b64(jpeg()) }] });
  assert.deepEqual(await g.json(), { saved: true, status: 'pending' });
  assert.equal(w.bucket.store.size, 1);
  const id = storedIds(w)[0];
  // a guest can't keep a photo (there's nothing of theirs to keep)
  const k = await post(w, null, { slug: 'corgi', rating: 5, name: 'june hsu', email: 'pup@example.com', photos: [{ keep: id }] });
  assert.equal(k.status, 400);

  // signing in with that confirmed email brings the review, photo and all, into the account
  const tok = await sign({});
  await account(new Request('https://x.test/api/account', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: '{}' }), w.env, w.fetchFn);
  assert.equal((await getPin(w, 'pug', tok)).mine.photos[0].id, id);
  assert.equal((await photo(w, id, tok, 'pug')).status, 200);

  // deleting the account takes the photo with it
  const recent = await sign({ auth_time: Math.floor(Date.now() / 1000) - 5 });
  const del = await account(new Request('https://x.test/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + recent } }), w.env, w.fetchFn);
  assert.equal(del.status, 200);
  assert.equal(w.bucket.store.size, 0);
});
