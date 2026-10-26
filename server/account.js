// j+k adventures: /api/account. The clerk checks the ticket, then opens that person's folder.
//   POST   /api/account   sign-in hello: creates the folder on first visit, returns it
//   DELETE /api/account   deletes the folder and the login. Needs a sign-in from the last 5 minutes.

import { configured, userFromRequest, firestoreGet, firestoreCreate, firestoreDelete, deleteAuthUser } from './firebase.js';

const RECENT_SIGN_IN = 5 * 60; // seconds

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// first names only: trimmed, no control characters, at most 40 characters
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function publicView(user, doc) {
  return {
    email: user.email || doc.email || '',
    emailVerified: user.email_verified === true,
    name: doc.displayName || '',
    createdAt: doc.createdAt || null,
    charges: doc.charges || 0
  };
}

export async function account(request, env, fetchFn = fetch) {
  if (request.method !== 'POST' && request.method !== 'DELETE') return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);

  let user;
  try { user = await userFromRequest(request, env, fetchFn); } catch (e) {
    console.log('token check failed', e.message);
    return json({ error: 'unavailable' }, 503);
  }
  if (!user) return json({ error: 'signed out' }, 401);
  const uid = user.sub;
  const path = 'users/' + encodeURIComponent(uid);

  try {
    if (request.method === 'DELETE') {
      if (!(user.auth_time > Date.now() / 1000 - RECENT_SIGN_IN)) return json({ error: 'sign in again' }, 403);
      await firestoreDelete(env, path, fetchFn);
      await deleteAuthUser(env, uid, fetchFn);
      return json({ deleted: true });
    }

    let doc = await firestoreGet(env, path, fetchFn);
    if (!doc) {
      let body = {};
      try { body = await request.json(); } catch (e) {}
      doc = {
        email: user.email || '',
        displayName: cleanName(body && body.name) || cleanName((user.name || '').split(' ')[0]),
        createdAt: new Date(),
        // the Collector's Path. only ever changed by the server
        charges: 0,
        lifetimeCharges: 0,
        earlyAccess: false,
        gift6Awarded: false,
        pendingGift6: false,
        freePinAvailable: false
      };
      const created = await firestoreCreate(env, 'users', uid, doc, fetchFn);
      if (!created) doc = (await firestoreGet(env, path, fetchFn)) || doc;
      else doc.createdAt = doc.createdAt.toISOString();
    }
    return json(publicView(user, doc));
  } catch (e) {
    console.log('account error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}
