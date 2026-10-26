// Tests for sign-in tickets and /api/account, with Google and Firestore faked.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdToken, _resetCaches } from '../server/firebase.js';
import { account, cleanName } from '../server/account.js';

const PROJECT = 'jk-test';
const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function keypair() {
  return crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
}
const google = await keypair();
const stranger = await keypair();
const googleJwk = { ...(await crypto.subtle.exportKey('jwk', google.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const saPem = '-----BEGIN PRIVATE KEY-----\n' +
  Buffer.from(await crypto.subtle.exportKey('pkcs8', (await keypair()).privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';

async function sign(claims, { key = google.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const body = { aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, sub: 'uid123', iat: t - 10, exp: t + 3600, auth_time: t - 10, email: 'pup@example.com', email_verified: true, ...claims };
  const unsigned = enc({ alg, kid, typ: 'JWT' }) + '.' + enc(body);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + Buffer.from(sig).toString('base64url');
}

// a pretend Google: the key list, the token exchange, Firestore and the auth admin API
function fakeGoogle() {
  const docs = {};
  const calls = [];
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method + ' ' + url);
    if (url.includes('securetoken@system')) return new Response(JSON.stringify({ keys: [googleJwk] }), { headers: { 'Cache-Control': 'max-age=100' } });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'server-token', expires_in: 3600 });
    if (opts.headers && opts.headers.Authorization !== 'Bearer server-token') return new Response('no', { status: 401 });
    const fs = /documents\/(.+?)(\?documentId=(.+))?$/.exec(url);
    if (fs) {
      const path = fs[3] ? fs[1] + '/' + decodeURIComponent(fs[3]) : decodeURIComponent(fs[1]);
      if (method === 'GET') return docs[path] ? Response.json({ fields: docs[path] }) : new Response('{}', { status: 404 });
      if (method === 'POST') {
        if (docs[path]) return new Response('{}', { status: 409 });
        docs[path] = JSON.parse(opts.body).fields;
        return Response.json({});
      }
      if (method === 'DELETE') { delete docs[path]; return Response.json({}); }
    }
    if (url.endsWith('/accounts:delete')) return Response.json({});
    return new Response('unexpected ' + url, { status: 500 });
  };
  return { docs, calls, fetchFn };
}

const env = { FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@jk-test.iam.gserviceaccount.com', private_key: saPem }) };
const req = (method, token, body) => new Request('https://x.test/api/account', {
  method, headers: token ? { Authorization: 'Bearer ' + token } : {}, body: body ? JSON.stringify(body) : undefined
});

test('a real ticket is accepted', async () => {
  _resetCaches();
  const c = await verifyIdToken(await sign({}), PROJECT, fakeGoogle().fetchFn);
  assert.equal(c.sub, 'uid123');
});

test('forged, expired, wrong project and malformed tickets are refused', async () => {
  const { fetchFn } = fakeGoogle();
  const t = Math.floor(Date.now() / 1000);
  const bad = [
    await sign({}, { key: stranger.privateKey }),
    await sign({ exp: t - 3600 }),
    await sign({ aud: 'someone-else' }),
    await sign({ iss: 'https://securetoken.google.com/someone-else' }),
    await sign({ sub: '' }),
    await sign({ iat: t + 3600 }),
    await sign({}, { kid: 'unknown' }),
    await sign({}, { alg: 'none' }),
    'not.a.token', '', null
  ];
  for (const tok of bad) assert.equal(await verifyIdToken(tok, PROJECT, fetchFn), null, String(tok).slice(0, 40));
  // tampering with the claims breaks the signature
  const good = await sign({});
  const [h, , s] = good.split('.');
  assert.equal(await verifyIdToken(h + '.' + enc({ sub: 'admin', aud: PROJECT }) + '.' + s, PROJECT, fetchFn), null);
});

test('google keys are cached between requests', async () => {
  _resetCaches();
  const g = fakeGoogle();
  await verifyIdToken(await sign({}), PROJECT, g.fetchFn);
  await verifyIdToken(await sign({}), PROJECT, g.fetchFn);
  assert.equal(g.calls.filter((c) => c.includes('securetoken')).length, 1);
});

test('first sign-in creates the folder; the second returns it unchanged', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const tok = await sign({});
  const r1 = await account(req('POST', tok, { name: '  juniper  ' }), env, g.fetchFn);
  assert.equal(r1.status, 200);
  const j1 = await r1.json();
  assert.equal(j1.name, 'juniper');
  assert.equal(j1.email, 'pup@example.com');
  assert.equal(j1.charges, 0);
  assert.deepEqual(g.docs['users/uid123'].charges, { integerValue: '0' });

  const r2 = await account(req('POST', tok, { name: 'someone else' }), env, g.fetchFn);
  assert.equal((await r2.json()).name, 'juniper');
});

test('google sign-ups take the first name from the ticket', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const r = await account(req('POST', await sign({ name: 'Kai Lee' })), env, g.fetchFn);
  assert.equal((await r.json()).name, 'Kai');
});

test('no ticket or a bad ticket is turned away', async () => {
  const g = fakeGoogle();
  assert.equal((await account(req('POST'), env, g.fetchFn)).status, 401);
  assert.equal((await account(req('POST', await sign({}, { key: stranger.privateKey })), env, g.fetchFn)).status, 401);
  assert.equal(Object.keys(g.docs).length, 0);
});

test('without Firebase settings the endpoint says so', async () => {
  assert.equal((await account(req('POST', 'x'), {}, fakeGoogle().fetchFn)).status, 503);
});

test('deleting needs a recent sign-in, then removes folder and login', async () => {
  _resetCaches();
  const g = fakeGoogle();
  const t = Math.floor(Date.now() / 1000);
  await account(req('POST', await sign({})), env, g.fetchFn);
  const stale = await account(req('DELETE', await sign({ auth_time: t - 3600 })), env, g.fetchFn);
  assert.equal(stale.status, 403);
  assert.ok(g.docs['users/uid123']);

  const ok = await account(req('DELETE', await sign({})), env, g.fetchFn);
  assert.equal(ok.status, 200);
  assert.equal(g.docs['users/uid123'], undefined);
  assert.ok(g.calls.some((c) => c.endsWith('/accounts:delete')));
});

test('names are cleaned', () => {
  assert.equal(cleanName('<b>pip</b>'), 'bpip/b');
  assert.equal(cleanName('a\u0000b'), 'ab');
  assert.equal(cleanName('x'.repeat(60)).length, 40);
  assert.equal(cleanName(5), '');
});
