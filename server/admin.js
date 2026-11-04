// j+k adventures: /api/admin, the back office. Only the shop owner gets in.
// Like a staff door: the sign-in ticket proves who you are, and the guest list (ADMIN_EMAILS) says
// whether you may come through. Both are checked by the server on every single request.
//
//   GET  /api/admin          are you the owner? { admin: true, email }
//   GET  /api/admin/shop     the open sign, read fresh
//   POST /api/admin/shop     { open: true|false }
//   GET  /api/admin/reviews  reviews waiting for a look
//   POST /api/admin/reviews  { id, status: "approved" | "hidden" }
//   GET  /api/admin/products  website products, the Square items they could be, the links chosen,
//                             and each product's available switch and "i'm interested" tally
//   POST /api/admin/products  { links: { "aussie": "<square variation id>", "aussie:large": "", ... } }
//   GET  /api/admin/featured  products that could go in the shop's featured carousel, their stock, and the picks
//   POST /api/admin/featured  { slugs: ["corgi", "aussie", ...] }  at most eight; a new pick must be in stock
//   POST /api/admin/availability  { slug, available: true|false }  not available: off sale, shows "i'm interested"
//   GET  /api/admin/notify   who is waiting for an "it's here" email, per product, and today's email count
//   POST /api/admin/notify   { slug }  send "it's here" to everyone confirmed for it (up to today's allowance)
//   GET  /api/admin/instagram  does the key in cloudflare open @ourjkadventures, and how many reels (never the key)
//
// Cloudflare setting (Settings > Variables and secrets):
//   ADMIN_EMAILS   plain text, comma separated, e.g. ourjkadventures@gmail.com

import { configured, userFromRequest } from './firebase.js';
import { readShopSwitch, setShopOpen } from './shop.js';
import { pendingReviews, setReviewStatus, REVIEW_STATUSES } from './reviews.js';
import { siteProducts, siteKeys, readLinks, saveLinks, freshCatalog, readFeatured, saveFeatured, stockOf, MAX_FEATURED, forgetCatalog } from './catalog.js';
import { squareConfigured, squareMode, listVariations, stockCounts } from './square.js';
import { instagramStatus } from './instagram.js';
import { readAvailability, setAvailable, readInterest } from './interest.js';
import { notifySummary, sendItsHere } from './notify.js';

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export function adminEmails(env) {
  return String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// A confirmed email that is on the list. An unconfirmed email could belong to anyone, so it never counts.
export function isAdmin(claims, env) {
  if (!claims || claims.email_verified !== true || typeof claims.email !== 'string') return false;
  return adminEmails(env).includes(claims.email.trim().toLowerCase());
}

async function readJson(request) {
  try { return (await request.json()) || {}; } catch (e) { return {}; }
}

export async function admin(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/admin\/?/, '');
  if (!configured(env)) return json({ error: 'not configured' }, 503);

  let user;
  try { user = await userFromRequest(request, env, fetchFn); } catch (e) {
    console.log('admin token check failed', e.message);
    return json({ error: 'unavailable' }, 503);
  }
  if (!user) return json({ error: 'signed out' }, 401);
  if (!isAdmin(user, env)) return json({ error: 'not the owner' }, 403);

  try {
    if (route === '') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      return json({ admin: true, email: user.email });
    }

    if (route === 'shop') {
      if (request.method === 'GET') return json(await readShopSwitch(env, fetchFn));
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      if (typeof body.open !== 'boolean') return json({ error: 'open must be true or false' }, 400);
      await setShopOpen(env, body.open, user.email, fetchFn);
      return json(await readShopSwitch(env, fetchFn));
    }

    if (route === 'reviews') {
      if (request.method === 'GET') return json({ reviews: await pendingReviews(env, fetchFn) });
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      if (!REVIEW_STATUSES.includes(body.status)) return json({ error: 'status' }, 400);
      if (!(await setReviewStatus(env, body.id, body.status, user.email, fetchFn))) return json({ error: 'no such review' }, 404);
      return json({ id: body.id, status: body.status });
    }

    if (route === 'products') {
      if (request.method === 'GET') return json(await productLinks(request, env, fetchFn));
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      const result = await changeLinks(request, env, body.links, fetchFn);
      if (result.error) return json(result, result.status || 400);
      return json(await productLinks(request, env, fetchFn));
    }

    if (route === 'featured') {
      if (request.method === 'GET') return json(await featuredChoices(request, env, fetchFn));
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      const result = await changeFeatured(request, env, body.slugs, user.email, fetchFn);
      if (result.error) return json(result, result.status || 400);
      return json(await featuredChoices(request, env, fetchFn));
    }

    if (route === 'availability') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      if (typeof body.available !== 'boolean') return json({ error: 'available must be true or false' }, 400);
      const slugs = new Set((await siteProducts(env, request.url)).items.map((p) => p.slug));
      if (typeof body.slug !== 'string' || !slugs.has(body.slug)) return json({ error: 'unknown product' }, 400);
      await setAvailable(env, body.slug, body.available, fetchFn);
      forgetCatalog();
      return json({ slug: body.slug, available: body.available });
    }

    if (route === 'notify') {
      const origin = new URL(request.url).origin;
      if (request.method === 'GET') return json(await notifySummary(env, origin, fetchFn));
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      const body = await readJson(request);
      const result = await sendItsHere(env, origin, body.slug, fetchFn);
      if (result.error) return json(result, result.status || 400);
      return json({ ...result, ...(await notifySummary(env, origin, fetchFn)) });
    }

    if (route === 'instagram') {
      if (request.method !== 'GET') return json({ error: 'method' }, 405);
      return json(await instagramStatus(env, fetchFn));
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.log('admin error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

/* ---------- products: which Square item is which website product ---------- */
async function productLinks(request, env, fetchFn) {
  const keys = siteKeys(await siteProducts(env, request.url));
  const links = await readLinks(env, fetchFn);
  let square = null;
  let squareError = null;
  if (!squareConfigured(env)) squareError = 'not configured';
  else {
    try {
      const vars = await listVariations(env, fetchFn);
      const counts = await stockCounts(env, vars.map((v) => v.id), fetchFn);
      square = vars.map((v) => ({
        id: v.id, label: v.label, sku: v.sku, price_cents: v.price_cents, tracked: v.tracked,
        stock: v.marked_sold_out ? 0 : counts[v.id] || 0
      }));
    } catch (e) {
      console.log('admin square list', e.message);
      squareError = /401|403|UNAUTHORIZED|FORBIDDEN|SCOPE/i.test(e.message) ? 'permission' : 'unreachable';
    }
  }
  // every product's switch and tally, available or not, so the owner sees what people asked for even after it arrives
  const availability = await readAvailability(env, fetchFn);
  const available = Object.fromEntries([...new Set(keys.map((k) => k.slug))].map((s) => [s, availability[s] !== false]));
  return { mode: squareMode(env), products: keys, links, square, squareError, available, interest: await readInterest(env, fetchFn) };
}

async function changeLinks(request, env, wanted, fetchFn) {
  if (!wanted || typeof wanted !== 'object' || Array.isArray(wanted)) return { error: 'links' };
  const allowedKeys = new Set(siteKeys(await siteProducts(env, request.url)).map((k) => k.key));
  const known = new Set((await listVariations(env, fetchFn)).map((v) => v.id));
  const links = {};
  const used = new Set();
  for (const [key, id] of Object.entries(wanted)) {
    if (!allowedKeys.has(key)) return { error: 'unknown product ' + key };
    if (id === '' || id === null) continue;
    if (typeof id !== 'string' || !known.has(id)) return { error: 'unknown square item for ' + key };
    // one Square item can stand behind only one website product, or its stock would be counted twice
    if (used.has(id)) return { error: 'used twice', key };
    used.add(id);
    links[key] = id;
  }
  await saveLinks(env, links, fetchFn);
  return { saved: true };
}

/* ---------- featured: what spins in the carousel at the top of the shop ---------- */
// Like choosing what goes in the shop window: only things on the shelf can go in, and at most eight fit.
async function featuredChoices(request, env, fetchFn) {
  const { ok, value } = await freshCatalog(env, request.url, fetchFn);
  const featured = await readFeatured(env, fetchFn);
  return {
    max: MAX_FEATURED,
    // false when Square or Firestore didn't answer, so every stock number below would read 0
    stockKnown: ok && squareConfigured(env),
    featured,
    products: value.items.map((p) => ({ slug: p.slug, name: p.name, kind: p.kind, series: p.series, available: p.available, linked: p.sizes.length > 0, stock: stockOf(p) }))
  };
}

async function changeFeatured(request, env, wanted, who, fetchFn) {
  if (!Array.isArray(wanted) || !wanted.every((s) => typeof s === 'string')) return { error: 'slugs' };
  const slugs = [...new Set(wanted)];
  if (slugs.length !== wanted.length) return { error: 'picked twice' };
  if (slugs.length > MAX_FEATURED) return { error: 'too many', max: MAX_FEATURED };
  if (!squareConfigured(env)) return { error: 'square not configured', status: 503 };
  const { ok, value } = await freshCatalog(env, request.url, fetchFn);
  if (!ok) return { error: 'square unreachable', status: 503 };
  const stock = Object.fromEntries(value.items.map((p) => [p.slug, stockOf(p)]));
  // a pick already saved may stay after it sells out (it simply hides until it's back); a new one must be in stock
  const before = new Set(await readFeatured(env, fetchFn));
  for (const slug of slugs) {
    if (!(slug in stock)) return { error: 'unknown product ' + slug };
    if (!before.has(slug) && stock[slug] <= 0) return { error: 'sold out', slug };
  }
  await saveFeatured(env, slugs, who, fetchFn);
  return { saved: true };
}
