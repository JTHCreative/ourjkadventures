// j+k adventures: Firebase on the server, with no libraries.
// Firebase Authentication is the coat check: it signs a ticket (an "ID token") for each signed-in person.
// verifyIdToken checks that ticket is real. firestore* functions read and write customer folders
// using the service account, the key only the server holds.
//
// Cloudflare settings (Settings > Variables and secrets):
//   FIREBASE_PROJECT_ID        plain, jk-adventures-website (that is also the default if it is left out)
//   FIREBASE_SERVICE_ACCOUNT   secret, the full JSON of the service account key

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit';
const SKEW = 60; // seconds of clock difference we tolerate

// kept between requests while this copy of the worker is warm
let keyCache = { keys: null, until: 0 };
let accessCache = { token: null, until: 0, account: null };

/* ---------- small helpers ---------- */
function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function jsonB64url(obj) { return bytesToB64url(new TextEncoder().encode(JSON.stringify(obj))); }
function decodePart(s) { return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))); }
function now() { return Math.floor(Date.now() / 1000); }

const DEFAULT_PROJECT = 'jk-adventures-website';
export function projectId(env) { return env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT; }

export function configured(env) {
  return !!env.FIREBASE_SERVICE_ACCOUNT;
}

/* ---------- checking the ticket (ID token) ---------- */
async function googleKeys(fetchFn) {
  if (keyCache.keys && keyCache.until > Date.now()) return keyCache.keys;
  const res = await fetchFn(JWKS_URL);
  if (!res.ok) throw new Error('jwks ' + res.status);
  const body = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('Cache-Control') || '');
  keyCache = { keys: body.keys || [], until: Date.now() + (m ? Number(m[1]) : 3600) * 1000 };
  return keyCache.keys;
}

// Returns the token's claims ({ sub, email, email_verified, name, auth_time, ... }) or null if it is not valid.
export async function verifyIdToken(token, projectId, fetchFn = fetch) {
  if (!token || typeof token !== 'string' || !projectId) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = decodePart(parts[0]); claims = decodePart(parts[1]); } catch (e) { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;

  const t = now();
  if (claims.aud !== projectId) return null;
  if (claims.iss !== 'https://securetoken.google.com/' + projectId) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
  if (!(claims.exp > t - SKEW)) return null;
  if (!(claims.iat <= t + SKEW)) return null;
  if (!(claims.auth_time <= t + SKEW)) return null;

  let keys = await googleKeys(fetchFn);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Google rotates keys; look once more in case ours are stale
    keyCache.until = 0;
    keys = await googleKeys(fetchFn);
    jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
  }
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + '.' + parts[1]));
  return ok ? claims : null;
}

// Pulls "Bearer <token>" out of a request and checks it.
export async function userFromRequest(request, env, fetchFn = fetch) {
  const m = /^Bearer\s+(\S+)$/.exec(request.headers.get('Authorization') || '');
  if (!m) return null;
  return verifyIdToken(m[1], projectId(env), fetchFn);
}

/* ---------- the server's own key (service account) ---------- */
function serviceAccount(env) {
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  if (!sa.client_email || !sa.private_key) throw new Error('service account incomplete');
  return sa;
}

async function accessToken(env, fetchFn) {
  const sa = serviceAccount(env);
  if (accessCache.token && accessCache.account === sa.client_email && accessCache.until > Date.now()) return accessCache.token;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const t = now();
  const unsigned = jsonB64url({ alg: 'RS256', typ: 'JWT' }) + '.' +
    jsonB64url({ iss: sa.client_email, scope: SCOPES, aud: TOKEN_URL, iat: t, exp: t + 3600 });
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + unsigned + '.' + bytesToB64url(sig)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('google token ' + res.status);
  accessCache = { token: body.access_token, account: sa.client_email, until: Date.now() + ((body.expires_in || 3600) - 300) * 1000 };
  return accessCache.token;
}

/* ---------- Firestore (REST) ---------- */
// Firestore's REST API wraps every value in its type, e.g. { stringValue: "hi" }. These two convert.
function toFields(obj) {
  const fields = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) fields[k] = { nullValue: null };
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    else if (typeof v === 'number') fields[k] = Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    else if (v instanceof Date) fields[k] = { timestampValue: v.toISOString() };
    else fields[k] = { stringValue: String(v) };
  }
  return fields;
}
function fromFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if ('stringValue' in v) out[k] = v.stringValue;
    else if ('booleanValue' in v) out[k] = v.booleanValue;
    else if ('integerValue' in v) out[k] = Number(v.integerValue);
    else if ('doubleValue' in v) out[k] = v.doubleValue;
    else if ('timestampValue' in v) out[k] = v.timestampValue;
    else out[k] = null;
  }
  return out;
}

function docsBase(env) {
  return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(projectId(env)) + '/databases/(default)/documents';
}

// Returns the document's fields, or null if it does not exist.
export async function firestoreGet(env, path, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn(docsBase(env) + '/' + path, { headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('firestore get ' + res.status);
  return fromFields((await res.json()).fields);
}

// Creates a document only if it is not there yet. Returns true if created, false if it already existed.
export async function firestoreCreate(env, collection, id, data, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const url = docsBase(env) + '/' + collection + '?documentId=' + encodeURIComponent(id);
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error('firestore create ' + res.status);
  return true;
}

// Changes only the named fields of a document that already exists.
export async function firestoreUpdate(env, path, data, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const mask = Object.keys(data).map((k) => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await fetchFn(docsBase(env) + '/' + path + '?' + mask + '&currentDocument.exists=true', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  if (!res.ok) throw new Error('firestore update ' + res.status);
}

// Lists a collection: [{ id, ...fields }], up to `limit` documents.
export async function firestoreList(env, collection, limit = 100, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn(docsBase(env) + '/' + collection + '?pageSize=' + limit, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('firestore list ' + res.status);
  const body = await res.json();
  return (body.documents || []).map((d) => ({ id: decodeURIComponent(d.name.split('/').pop()), ...fromFields(d.fields) }));
}

// Creates or replaces a whole document.
export async function firestoreSet(env, path, data, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn(docsBase(env) + '/' + path, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: toFields(data) })
  });
  if (!res.ok) throw new Error('firestore set ' + res.status);
}

// Finds documents in a top-level collection whose fields equal the given values, e.g. { status: 'approved' }.
// Returns [{ id, ...fields }], up to `limit`. Equality only, so Firestore needs no extra index.
export async function firestoreQuery(env, collection, equals, limit = 500, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const where = Object.keys(equals).map((k) => ({
    fieldFilter: { field: { fieldPath: k }, op: 'EQUAL', value: toFields({ v: equals[k] }).v }
  }));
  const structuredQuery = { from: [{ collectionId: collection }], limit };
  if (where.length === 1) structuredQuery.where = where[0];
  else if (where.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: where } };
  const res = await fetchFn(docsBase(env) + ':runQuery', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery })
  });
  if (!res.ok) throw new Error('firestore query ' + res.status);
  const rows = await res.json();
  return (rows || []).filter((r) => r.document)
    .map((r) => ({ id: decodeURIComponent(r.document.name.split('/').pop()), ...fromFields(r.document.fields) }));
}

export async function firestoreDelete(env, path, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn(docsBase(env) + '/' + path, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok && res.status !== 404) throw new Error('firestore delete ' + res.status);
}

/* ---------- Firebase Authentication (admin) ---------- */
export async function deleteAuthUser(env, uid, fetchFn = fetch) {
  const token = await accessToken(env, fetchFn);
  const res = await fetchFn('https://identitytoolkit.googleapis.com/v1/projects/' + encodeURIComponent(projectId(env)) + '/accounts:delete', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid })
  });
  // USER_NOT_FOUND means it is already gone, which is what we wanted
  if (!res.ok) {
    const body = await res.text();
    if (!/USER_NOT_FOUND/.test(body)) throw new Error('auth delete ' + res.status);
  }
}

// for tests
export function _resetCaches() { keyCache = { keys: null, until: 0 }; accessCache = { token: null, until: 0, account: null }; }
