// j+k adventures: /api/account. The clerk checks the ticket, then opens that person's folder.
//   POST   /api/account          sign-in hello: creates the folder on first visit, returns it
//   PATCH  /api/account          changes first name, last name, phone
//   DELETE /api/account          deletes the folder, its order notes, their reviews and the login. Needs a sign-in from the last 5 minutes.
//   GET    /api/account/orders   paid orders placed while signed in, read from Square

import {
  configured, userFromRequest, firestoreGet, firestoreCreate, firestoreUpdate, firestoreList, firestoreDelete, deleteAuthUser
} from './firebase.js';
import { paidOrders } from './orders.js';
import { deleteReviewsBy } from './reviews.js';
import { isAdmin } from './admin.js';

const RECENT_SIGN_IN = 5 * 60; // seconds

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

// names: trimmed, no control characters or angle brackets, at most 40 characters
export function cleanName(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

// phone: optional. digits with the usual + ( ) - . and spaces, 7 to 15 digits. returns null if not valid.
export function cleanPhone(s) {
  if (s === undefined || s === null || s === '') return '';
  if (typeof s !== 'string' || s.length > 30 || !/^[0-9+().\-\s]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return s.replace(/\s+/g, ' ').trim();
}

function publicView(user, doc, env) {
  return {
    admin: isAdmin(user, env),
    email: user.email || doc.email || '',
    emailVerified: user.email_verified === true,
    firstName: doc.firstName || doc.displayName || '',
    lastName: doc.lastName || '',
    phone: doc.phone || '',
    createdAt: doc.createdAt || null,
    charges: doc.charges || 0
  };
}

export function userPath(uid) { return 'users/' + encodeURIComponent(uid); }

export async function account(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  const isOrders = url.pathname === '/api/account/orders';
  const allowed = isOrders ? ['GET'] : ['POST', 'PATCH', 'DELETE'];
  if (!allowed.includes(request.method)) return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);

  let user;
  try { user = await userFromRequest(request, env, fetchFn); } catch (e) {
    console.log('token check failed', e.message);
    return json({ error: 'unavailable' }, 503);
  }
  if (!user) return json({ error: 'signed out' }, 401);
  const uid = user.sub;
  const path = userPath(uid);

  try {
    if (isOrders) {
      const notes = await firestoreList(env, path + '/orders', 100, fetchFn);
      return json({ orders: await paidOrders(env, uid, notes.map((n) => n.id), fetchFn) });
    }

    if (request.method === 'DELETE') {
      if (!(user.auth_time > Date.now() / 1000 - RECENT_SIGN_IN)) return json({ error: 'sign in again' }, 403);
      // Firestore does not remove a folder's contents with it, so clear the order notes first
      const notes = await firestoreList(env, path + '/orders', 300, fetchFn);
      for (const n of notes) await firestoreDelete(env, path + '/orders/' + encodeURIComponent(n.id), fetchFn);
      await deleteReviewsBy(env, uid, fetchFn);
      await firestoreDelete(env, path, fetchFn);
      await deleteAuthUser(env, uid, fetchFn);
      return json({ deleted: true });
    }

    let body = {};
    try { body = await request.json(); } catch (e) {}
    body = body || {};

    if (request.method === 'PATCH') {
      const changes = {};
      if ('firstName' in body) changes.firstName = cleanName(body.firstName);
      if ('lastName' in body) changes.lastName = cleanName(body.lastName);
      if ('phone' in body) {
        const phone = cleanPhone(body.phone);
        if (phone === null) return json({ error: 'phone' }, 400);
        changes.phone = phone;
      }
      if (!Object.keys(changes).length) return json({ error: 'nothing to change' }, 400);
      await firestoreUpdate(env, path, changes, fetchFn);
      return json(publicView(user, (await firestoreGet(env, path, fetchFn)) || changes, env));
    }

    // POST: hello
    let doc = await firestoreGet(env, path, fetchFn);
    if (!doc) {
      const fromGoogle = (user.name || '').split(' ');
      doc = {
        email: user.email || '',
        firstName: cleanName(body.firstName) || cleanName(body.name) || cleanName(fromGoogle[0]),
        lastName: cleanName(body.lastName) || cleanName(fromGoogle.slice(1).join(' ')),
        phone: '',
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
    } else if (user.email && doc.email !== user.email) {
      // they changed their email through Firebase's link: keep our copy in step
      await firestoreUpdate(env, path, { email: user.email }, fetchFn);
      doc.email = user.email;
    }
    return json(publicView(user, doc, env));
  } catch (e) {
    console.log('account error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

// Called by checkout: a note in the buyer's folder that they started this Square order.
export async function noteOrder(env, uid, orderId, fetchFn = fetch) {
  await firestoreCreate(env, userPath(uid) + '/orders', orderId, { createdAt: new Date() }, fetchFn);
}
