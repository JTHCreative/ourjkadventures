// j+k adventures: review photos, kept in Cloudflare R2 (the REVIEW_PHOTOS bucket, see docs/setup/reviews.md).
// Like a photo album kept in a back room: each picture gets a long random number as its name, and the review's
// Firestore record lists the numbers. The pictures themselves never go in Firestore.
//
// Only JPEGs come in: the browser shrinks every photo (long side 1600px) and turns it into a JPEG before sending.
// The server still checks each one is a real JPEG of a sensible size, and drops the hidden extras a camera
// writes inside the file (EXIF: where and when it was taken, the phone's model) in case anything slipped through.
// Who may look at a photo is decided in server/reviews.js and server/admin.js, not here.

export const MAX_PHOTOS = 4;
export const MAX_PHOTO_BYTES = 700 * 1024;
const MAX_SIDE = 4000;
const ID = /^[a-f0-9]{32}$/;

export function photosOn(env) {
  return !!(env && env.REVIEW_PHOTOS && typeof env.REVIEW_PHOTOS.put === 'function');
}

export function isPhotoId(id) { return typeof id === 'string' && ID.test(id); }

// in Firestore a review's photos are one line of text: "id.WxH,id.WxH" (width and height let the page
// save the right space before the picture loads, so nothing jumps)
export function parsePhotos(s) {
  if (typeof s !== 'string' || !s) return [];
  return s.split(',').map((part) => {
    const m = /^([a-f0-9]{32})\.(\d{1,4})x(\d{1,4})$/.exec(part);
    return m ? { id: m[1], w: Number(m[2]), h: Number(m[3]) } : null;
  }).filter(Boolean).slice(0, MAX_PHOTOS);
}
export function photoString(list) {
  return list.map((p) => p.id + '.' + p.w + 'x' + p.h).join(',');
}

function newPhotoId() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
const key = (id) => 'reviews/' + id + '.jpg';

// A JPEG is a row of labelled blocks. Keep the picture and its colour profile; drop the camera's notes
// (APP1 EXIF and XMP, APP13 and the other APP blocks, comments). Returns null if it isn't a sound JPEG.
export function cleanJpeg(b) {
  if (!(b instanceof Uint8Array) || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  if (b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) return null;
  const parts = [b.subarray(0, 2)];
  let i = 2, w = 0, h = 0, scan = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd9) return null;
    if (m === 0xda) { scan = true; parts.push(b.subarray(i)); break; }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (len < 7) return null;
      h = (b[i + 5] << 8) | b[i + 6];
      w = (b[i + 7] << 8) | b[i + 8];
    }
    const drop = (m >= 0xe1 && m <= 0xef && m !== 0xe2 && m !== 0xee) || m === 0xfe;
    if (!drop) parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!scan || !w || !h || w > MAX_SIDE || h > MAX_SIDE) return null;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return { bytes: out, w, h };
}

// the browser sends each new photo as base64 text (a "data:image/jpeg;base64," start is fine)
export function readPhoto(text) {
  if (typeof text !== 'string') return null;
  const s = text.replace(/^data:image\/jpeg;base64,/, '');
  if (!s || s.length > Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  let bin;
  try { bin = atob(s); } catch (e) { return null; }
  if (bin.length > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
  return cleanJpeg(bytes);
}

// Works out a review's photos from what the browser sent: { keep: id } for one it already has,
// { jpeg: "<base64>" } for a new one. Nothing is stored yet: call storePhotos with the result.
// No "photos" in the request at all means "leave them as they were".
export function planPhotos(env, input, beforeString) {
  const before = parsePhotos(beforeString);
  if (input === undefined) return { list: before, add: [], remove: [] };
  if (!Array.isArray(input) || input.length > MAX_PHOTOS) return { error: 'photos' };
  const list = [], add = [], seen = new Set();
  for (const item of input) {
    if (item && typeof item.keep === 'string') {
      const had = before.find((p) => p.id === item.keep);
      if (!had || seen.has(had.id)) return { error: 'photos' };
      seen.add(had.id);
      list.push(had);
    } else if (item && typeof item.jpeg === 'string') {
      if (!photosOn(env)) return { error: 'photos off' };
      const pic = readPhoto(item.jpeg);
      if (!pic) return { error: 'photo' };
      const p = { id: newPhotoId(), w: pic.w, h: pic.h, bytes: pic.bytes };
      list.push(p);
      add.push(p);
    } else return { error: 'photos' };
  }
  return { list: list.map(({ id, w, h }) => ({ id, w, h })), add, remove: before.filter((p) => !seen.has(p.id)).map((p) => p.id) };
}

export async function storePhotos(env, add) {
  for (const p of add) {
    await env.REVIEW_PHOTOS.put(key(p.id), p.bytes, { httpMetadata: { contentType: 'image/jpeg' } });
  }
}

// never stops anything else: a photo left behind is only a little wasted space
export async function deletePhotos(env, ids) {
  if (!photosOn(env) || !ids || !ids.length) return;
  try { await env.REVIEW_PHOTOS.delete(ids.map(key)); } catch (e) { console.log('photo delete failed', e.message); }
}

export async function photoResponse(env, id, cache) {
  if (!photosOn(env) || !isPhotoId(id)) return new Response('not found', { status: 404 });
  const obj = await env.REVIEW_PHOTOS.get(key(id));
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'"
    }
  });
}
