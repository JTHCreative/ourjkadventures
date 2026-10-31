// j+k adventures: /api/admin, the back office. Only the shop owner gets in.
// Like a staff door: the sign-in ticket proves who you are, and the guest list (ADMIN_EMAILS) says
// whether you may come through. Both are checked by the server on every single request.
//
//   GET  /api/admin          are you the owner? { admin: true, email }
//   GET  /api/admin/shop     the open sign, read fresh
//   POST /api/admin/shop     { open: true|false }
//   GET  /api/admin/reviews  reviews waiting for a look
//   POST /api/admin/reviews  { id, status: "approved" | "hidden" }
//
// Cloudflare setting (Settings > Variables and secrets):
//   ADMIN_EMAILS   plain text, comma separated, e.g. ourjkadventures@gmail.com

import { configured, userFromRequest } from './firebase.js';
import { readShopSwitch, setShopOpen } from './shop.js';
import { pendingReviews, setReviewStatus, REVIEW_STATUSES } from './reviews.js';

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

    return json({ error: 'not found' }, 404);
  } catch (e) {
    console.log('admin error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}
