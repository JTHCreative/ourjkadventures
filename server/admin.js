// j+k adventures: /api/admin, the back office. Only the shop owner gets in.
// Like a staff door: the sign-in ticket proves who you are, and the guest list (ADMIN_EMAILS) says
// whether you may come through. Both are checked by the server on every single request.
//
//   GET  /api/admin          are you the owner? { admin: true, email }
//   GET  /api/admin/shop     the open sign, read fresh
//   POST /api/admin/shop     { open: true|false }
//   GET  /api/admin/reviews  reviews waiting for a look
//   POST /api/admin/reviews  { id, status: "approved" | "hidden" }
//   GET  /api/admin/products  website products, the Square items they could be, and the links chosen
//   POST /api/admin/products  { links: { "aussie": "<square variation id>", "aussie:large": "", ... } }
//   GET  /api/admin/instagram             is instagram connected, as whom, when the key renews (never the key)
//   POST /api/admin/instagram/start       { url } the instagram sign-in page to send the owner to
//   POST /api/admin/instagram/finish      { code, state } what instagram sent back; saves the key
//   POST /api/admin/instagram/disconnect  forget the key and the saved reels
//
// Cloudflare setting (Settings > Variables and secrets):
//   ADMIN_EMAILS   plain text, comma separated, e.g. ourjkadventures@gmail.com

import { configured, userFromRequest } from './firebase.js';
import { readShopSwitch, setShopOpen } from './shop.js';
import { pendingReviews, setReviewStatus, REVIEW_STATUSES } from './reviews.js';
import { siteProducts, siteKeys, readLinks, saveLinks } from './catalog.js';
import { squareConfigured, squareMode, listVariations, stockCounts } from './square.js';
import { instagramConfigured, instagramStatus, startLogin, finishLogin, disconnect } from './instagram.js';

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

    if (route === 'instagram' || route.startsWith('instagram/')) return instagramAdmin(route, request, env, user, fetchFn);

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
  return { mode: squareMode(env), products: keys, links, square, squareError };
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

/* ---------- instagram: connect the account whose reels show on the About page ---------- */
async function instagramAdmin(route, request, env, user, fetchFn) {
  if (route === 'instagram') {
    if (request.method !== 'GET') return json({ error: 'method' }, 405);
    return json(await instagramStatus(env));
  }
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!instagramConfigured(env)) return json({ error: 'not configured' }, 503);
  if (route === 'instagram/start') return json({ url: await startLogin(env, user.email, request.url) });
  if (route === 'instagram/disconnect') {
    await disconnect(env);
    return json(await instagramStatus(env));
  }
  if (route === 'instagram/finish') {
    const body = await readJson(request);
    let result;
    try { result = await finishLogin(env, user.email, body.code, body.state, request.url, fetchFn); } catch (e) {
      console.log('instagram connect failed', e.message);
      return json({ error: 'instagram said no' }, 502);
    }
    if (result.error) return json(result, 400);
    return json(await instagramStatus(env));
  }
  return json({ error: 'not found' }, 404);
}
