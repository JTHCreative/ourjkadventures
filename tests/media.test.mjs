// Tests for the photos section under the pup board: the owner's own photos (uploaded on /admin, kept in R2 under
// media/, faked here) and the photos on approved reviews, listed together by /api/media.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCaches } from '../server/firebase.js';
import { reviews, setReviewStatus, _resetReviewCache } from '../server/reviews.js';
import { mediaRoute, cleanAlt, MAX_MEDIA_PER_PRODUCT, _resetMediaCache } from '../server/media.js';
import { admin } from '../server/admin.js';
import { sign, fakeGoogle, env as baseEnv } from './helpers.mjs';

const catalog = { items: [{ slug: 'corgi', name: 'corgi', kind: 'pin' }, { slug: 'pug', name: 'pug', kind: 'pin' }] };

function fakeBucket() {
  const store = new Map();
  return {
    store,
    async put(k, v) { store.set(k, new Uint8Array(v)); },
    async get(k) { return store.has(k) ? { body: store.get(k) } : null; },
    async delete(keys) { for (const k of [].concat(keys)) store.delete(k); }
  };
}
const seg = (marker, body) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
function jpeg({ w = 640, h = 480 } = {}) {
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...Buffer.from('Exif\0\0GPS 37.77N 122.41W')]),
    ...seg(0xc0, [8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]), 0x12, 0x34, 0x56,
    0xff, 0xd9
  ]);
}
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

function world({ bucket = true } = {}) {
  _resetCaches();
  _resetReviewCache();
  _resetMediaCache();
  const g = fakeGoogle();
  g.docs['users/uid123'] = { firstName: { stringValue: 'juniper' }, lastName: { stringValue: 'hart' } };
  const b = fakeBucket();
  const env = { ...baseEnv, ADMIN_EMAILS: 'owner@example.com', ...(bucket ? { REVIEW_PHOTOS: b } : {}), ASSETS: { fetch: async () => Response.json(catalog) } };
  return { g, bucket: b, env, fetchFn: g.fetchFn };
}
const owner = () => sign({ email: 'owner@example.com' });
const adminCall = async (w, method, path, body, token) => admin(new Request('https://x.test/api/admin/' + path, {
  method,
  headers: { Authorization: 'Bearer ' + (token || await owner()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined
}), w.env, w.fetchFn);
const media = async (w, query) => {
  _resetMediaCache();
  _resetReviewCache();
  return mediaRoute(new Request('https://x.test/api/media' + (query || '')), w.env, w.fetchFn);
};
const mediaPhoto = (w, id) => mediaRoute(new Request('https://x.test/api/media/photo?id=' + id), w.env, w.fetchFn);

test('the owner uploads a photo for a product: stored cleaned, listed for that product, public straight away', async () => {
  const w = world();
  const res = await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(jpeg({ w: 800, h: 600 })), alt: 'the corgi pin on a denim <jacket>\n' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.saved, true);
  assert.equal(body.photos.length, 1);
  assert.equal(body.photos[0].slug, 'corgi');
  assert.equal(body.photos[0].alt, 'the corgi pin on a denim jacket');
  assert.equal(body.photos[0].w, 800);
  const stored = w.bucket.store.get('media/' + body.id + '.jpg');
  assert.ok(stored, 'kept under media/');
  assert.ok(!Buffer.from(stored).includes('GPS'), 'camera notes dropped');

  const corgi = await (await media(w, '?slug=corgi')).json();
  assert.equal(corgi.photos.length, 1);
  assert.equal(corgi.photos[0].from, 'shop');
  assert.equal(corgi.photos[0].src, '/api/media/photo?id=' + body.id);
  assert.equal((await (await media(w, '?slug=pug')).json()).photos.length, 0);
  assert.equal((await (await media(w)).json()).photos.length, 1, 'the whole pack sees it too');
  assert.equal((await mediaPhoto(w, body.id)).status, 200);
});

test('only the owner can upload, and only for a real product with a real JPEG', async () => {
  const w = world();
  assert.equal((await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(jpeg()) }, await sign({ email: 'someone@example.com' }))).status, 403);
  assert.equal((await adminCall(w, 'POST', 'media', { slug: 'unicorn', jpeg: b64(jpeg()) })).status, 400);
  assert.equal((await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(Buffer.from('not a picture')) })).status, 400);
  assert.equal(w.bucket.store.size, 0);
});

test('without the photo bucket, uploads are refused and the list is empty', async () => {
  const w = world({ bucket: false });
  assert.equal((await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(jpeg()) })).status, 503);
  assert.deepEqual((await (await media(w, '?slug=corgi')).json()).photos, []);
  assert.equal((await (await adminCall(w, 'GET', 'media')).json()).on, false);
});

test('at most a set number of the owner\'s photos per product', async () => {
  const w = world();
  for (let i = 0; i < MAX_MEDIA_PER_PRODUCT; i++) {
    w.g.docs['media/' + String(i).padStart(32, 'a')] = { slug: { stringValue: 'corgi' }, photo: { stringValue: String(i).padStart(32, 'a') + '.10x10' } };
  }
  const res = await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(jpeg()) });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'too many');
  assert.equal((await adminCall(w, 'POST', 'media', { slug: 'pug', jpeg: b64(jpeg()) })).status, 200, 'another product still has room');
});

test('removing a photo takes it off the list and out of the bucket', async () => {
  const w = world();
  const { id } = await (await adminCall(w, 'POST', 'media', { slug: 'pug', jpeg: b64(jpeg()) })).json();
  const res = await adminCall(w, 'DELETE', 'media?id=' + id);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).photos.length, 0);
  assert.equal(w.bucket.store.size, 0);
  assert.equal((await mediaPhoto(w, id)).status, 404);
  assert.equal((await adminCall(w, 'DELETE', 'media?id=' + id)).status, 404);
});

test('approved review photos join the list after the owner\'s, waiting ones never do', async () => {
  const w = world();
  const tok = await sign({});
  const post = await reviews(new Request('https://x.test/api/reviews', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ slug: 'corgi', rating: 5, text: 'love it', photos: [{ jpeg: b64(jpeg()) }] })
  }), w.env, w.fetchFn);
  assert.equal(post.status, 200);
  await adminCall(w, 'POST', 'media', { slug: 'corgi', jpeg: b64(jpeg()), alt: 'on a tote' });

  let list = (await (await media(w, '?slug=corgi')).json()).photos;
  assert.deepEqual(list.map((p) => p.from), ['shop'], 'a waiting review\'s photo stays private');

  const id = Object.keys(w.g.docs).find((k) => k.startsWith('reviews/')).split('/')[1];
  await setReviewStatus(w.env, id, 'approved', 'owner', w.fetchFn);
  list = (await (await media(w, '?slug=corgi')).json()).photos;
  assert.deepEqual(list.map((p) => p.from), ['shop', 'review']);
  assert.equal(list[1].name, 'juniper h.');
  assert.match(list[1].src, /^\/api\/reviews\/photo\?id=[a-f0-9]{32}$/);
  assert.equal(list[1].uid, undefined, 'never who wrote it beyond "first l."');
});

test('bad requests', async () => {
  const w = world();
  assert.equal((await media(w, '?slug=Not%20A%20Slug')).status, 400);
  assert.equal((await mediaPhoto(w, 'nope')).status, 404);
  assert.equal((await mediaRoute(new Request('https://x.test/api/media', { method: 'POST' }), w.env, w.fetchFn)).status, 405);
  assert.equal(cleanAlt('  two\nlines  '), 'two lines');
  assert.equal(cleanAlt(5), '');
});
