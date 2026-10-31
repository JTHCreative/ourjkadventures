// j+k adventures: the shop's open sign. One switch in Firestore, settings/shop { open: true|false },
// flipped by the owner on /admin. Like a sign on the door, we glance at it about once a minute rather
// than on every visit. Anything other than a clear "open: true" means closed: a missing document,
// a typo, or Firestore being unreachable all keep the shop shut.

import { configured, firestoreGet, firestoreSet } from './firebase.js';

const SHOP_DOC = 'settings/shop';
const CACHE_MS = 60 * 1000;     // a good answer is trusted for a minute
const RETRY_MS = 10 * 1000;     // a failed look is retried after ten seconds

let cache = { open: false, until: 0 };

export async function isShopOpen(env, fetchFn = fetch) {
  if (cache.until > Date.now()) return cache.open;
  let open = false;
  let ok = false;
  if (configured(env)) {
    try {
      const doc = await firestoreGet(env, SHOP_DOC, fetchFn);
      open = !!doc && doc.open === true;
      ok = true;
    } catch (e) {
      console.log('shop switch unreadable', e.message);
    }
  }
  cache = { open, until: Date.now() + (ok ? CACHE_MS : RETRY_MS) };
  return open;
}

// Reads the switch fresh, for the admin page, which should never show a stale answer.
export async function readShopSwitch(env, fetchFn = fetch) {
  const doc = await firestoreGet(env, SHOP_DOC, fetchFn);
  return { open: !!doc && doc.open === true, updatedAt: (doc && doc.updatedAt) || null };
}

export async function setShopOpen(env, open, who, fetchFn = fetch) {
  await firestoreSet(env, SHOP_DOC, { open: open === true, updatedAt: new Date(), updatedBy: who || '' }, fetchFn);
  // this copy of the server knows right away; others catch up within a minute
  cache = { open: open === true, until: Date.now() + CACHE_MS };
}

// for tests
export function _resetShopCache() { cache = { open: false, until: 0 }; }
