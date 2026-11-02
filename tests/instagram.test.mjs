// Tests for the About page's reels: /api/reels and connecting Instagram on /admin (Meta's Unified Login).
// Meta and the KV drawer are faked, shaped like Meta's docs. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reelsRoute, callbackBounce, toReel, instagramStatus } from '../server/instagram.js';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { createHmac } from 'node:crypto';
import { fakeGoogle, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const G = 'https://graph.facebook.com/v26.0';

// a pretend Workers KV namespace
function fakeKV() {
  const data = new Map();
  let writes = 0;
  return {
    data,
    get writes() { return writes; },
    async get(k, type) { const v = data.has(k) ? data.get(k) : null; return v !== null && type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { writes++; data.set(k, v); },
    async delete(k) { data.delete(k); }
  };
}

// a pretend Meta (graph.facebook.com)
function fakeMeta(opts = {}) {
  const calls = [];
  const media = opts.media || [
    { id: '1', media_type: 'VIDEO', media_url: 'https://cdn.ig/1.mp4', thumbnail_url: 'https://cdn.ig/1.jpg', permalink: 'https://www.instagram.com/reel/1/', caption: 'corgi at the beach.', username: 'ourjkadventures' },
    { id: '2', media_type: 'IMAGE', media_url: 'https://cdn.ig/2.jpg', permalink: 'https://www.instagram.com/p/2/' },
    { id: '3', media_type: 'VIDEO', thumbnail_url: 'https://cdn.ig/3.jpg', permalink: 'https://www.instagram.com/reel/3/', caption: 'licensed music.', username: 'ourjkadventures' },
    { id: '4', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/4/' }
  ];
  const accounts = opts.accounts || [{ id: '1789', username: 'ourjkadventures' }];
  // what the key's own description says each permission covers (debug_token)
  const granted = opts.granted || [{ scope: 'instagram_basic', target_ids: ['1789'] }, { scope: 'instagram_manage_messages', target_ids: ['1789'] }];
  const proof = createHmac('sha256', 'shh').update('suat-key').digest('hex');
  const fail = (status, code, message) => Response.json({ error: { message, type: 'OAuthException', code } }, { status });
  const fetchFn = async (url, init = {}) => {
    url = String(url);
    calls.push((init.method || 'GET') + ' ' + url);
    if (!url.startsWith(G)) return null;
    if (opts.down) return fail(500, 2, 'down');
    const u = new URL(url);
    if (u.pathname === '/v26.0/oauth/access_token') {
      const p = u.searchParams;
      if (p.get('code') !== 'good-code' || p.get('client_secret') !== 'shh' || p.get('client_id') !== 'meta-app'
        || p.get('redirect_uri') !== 'https://ourjkadventures.com/api/admin/instagram/callback') return fail(400, 100, 'bad code');
      return Response.json({ access_token: 'suat-key', token_type: 'bearer', ...(opts.expiresIn ? { expires_in: opts.expiresIn } : {}) });
    }
    if (u.pathname === '/v26.0/debug_token') {
      if (u.searchParams.get('access_token') !== 'meta-app|shh' || u.searchParams.get('input_token') !== 'suat-key') return fail(400, 100, 'bad app token');
      return Response.json({ data: { app_id: 'meta-app', type: 'SYSTEM_USER', is_valid: true, scopes: granted.map((g) => g.scope), granular_scopes: granted } });
    }
    const key = u.searchParams.get('access_token');
    if (key !== 'suat-key' || opts.revoked) return fail(400, 190, 'Error validating access token');
    if (u.searchParams.get('appsecret_proof') !== proof) return fail(400, 100, 'API calls from the server require an appsecret_proof argument');
    if (u.pathname === '/v26.0/me') return Response.json({ client_business_id: 'biz-1', id: 'sys-9' });
    if (u.pathname === '/v26.0/me/assigned_instagram_accounts') return Response.json({ data: accounts });
    if (u.pathname === '/v26.0/1789') return Response.json({ id: '1789', username: 'ourjkadventures' });
    if (u.pathname === '/v26.0/biz-1/owned_instagram_accounts') {
      if (opts.ownedError) return fail(400, 200, 'Requires business_management permission');
      return Response.json({ data: opts.owned || [] });
    }
    if (u.pathname === '/v26.0/biz-1/instagram_accounts') return Response.json({ data: opts.bizAccounts || [] });
    if (u.pathname === '/v26.0/me/accounts') return Response.json({ data: opts.pages || [] });
    if (u.pathname === '/v26.0/1789/media') return Response.json({ data: media });
    return fail(404, 803, 'unknown ' + u.pathname);
  };
  return { calls, fetchFn };
}

function setup(extra = {}) {
  _resetCaches();
  const kv = fakeKV();
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, REEL_STORE: kv, META_APP_ID: 'meta-app', META_APP_SECRET: 'shh', INSTAGRAM_CONFIG_ID: 'cfg-7', ...extra };
  return { kv, env };
}
const get = (path) => new Request('https://ourjkadventures.com' + path);
const connected = (kv) => kv.data.set('instagram:token', JSON.stringify({ access_token: 'suat-key', instagram_id: '1789', username: 'ourjkadventures', expires_at: null, connected_at: Date.now() }));

test('not set up, or not connected yet: the page is told to show its stand-ins', async () => {
  for (const env of [{}, { REEL_STORE: fakeKV() }, setup().env]) {
    const r = await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { connected: false, reels: [] });
  }
});

test('only videos come through, in the reel door shape, and the key never does', async () => {
  const { kv, env } = setup();
  connected(kv);
  const meta = fakeMeta();
  const r = await reelsRoute(get('/api/reels'), env, meta.fetchFn);
  const text = await r.text();
  assert.ok(!text.includes('suat-key'));
  const body = JSON.parse(text);
  assert.equal(body.connected, true);
  assert.deepEqual(body.reels.map((x) => x.id), ['1', '3']);
  assert.deepEqual(body.reels[0], { id: '1', thumbnailUrl: 'https://cdn.ig/1.jpg', videoUrl: 'https://cdn.ig/1.mp4', permalink: 'https://www.instagram.com/reel/1/', caption: 'corgi at the beach.', username: 'ourjkadventures' });
  // no video file (licensed music): the still and the link, no videoUrl
  assert.equal(body.reels[1].videoUrl, undefined);
  // asked by the Instagram account's ID, on graph.facebook.com
  assert.ok(meta.calls.some((c) => c.startsWith('GET ' + G + '/1789/media?')));
});

test('reels are fetched at most every 30 minutes; visitors in between get the saved copy', async () => {
  const { kv, env } = setup();
  connected(kv);
  const meta = fakeMeta();
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, meta.fetchFn, t);
  for (let i = 1; i <= 20; i++) await reelsRoute(get('/api/reels'), env, meta.fetchFn, t + i * 60 * 1000);
  assert.equal(meta.calls.filter((c) => c.includes('/media')).length, 1);
  await reelsRoute(get('/api/reels'), env, meta.fetchFn, t + 31 * 60 * 1000);
  assert.equal(meta.calls.filter((c) => c.includes('/media')).length, 2);
});

test('if Meta is down, the last saved copy is served; with no copy, a calm error', async () => {
  const { kv, env } = setup();
  connected(kv);
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn, t);
  const r = await reelsRoute(get('/api/reels'), env, fakeMeta({ down: true }).fetchFn, t + 2 * 3600 * 1000);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.reels.length, 2);
  assert.equal(body.stale, true);
  assert.equal((await instagramStatus(env)).key_stopped, false);

  const fresh = setup();
  connected(fresh.kv);
  assert.equal((await reelsRoute(get('/api/reels'), fresh.env, fakeMeta({ down: true }).fetchFn)).status, 502);
});

test('a key Meta has stopped accepting is marked once, not retried, and /admin hears about it', async () => {
  const { kv, env } = setup();
  connected(kv);
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn, t);
  const revoked = fakeMeta({ revoked: true });
  const r = await reelsRoute(get('/api/reels'), env, revoked.fetchFn, t + 31 * 60 * 1000);
  assert.equal((await r.json()).stale, true);
  assert.equal((await instagramStatus(env)).key_stopped, true);
  const writes = kv.writes;
  for (let i = 2; i < 6; i++) await reelsRoute(get('/api/reels'), env, revoked.fetchFn, t + i * 31 * 60 * 1000);
  assert.equal(revoked.calls.length, 1);
  assert.equal(kv.writes, writes);
});

test('toReel skips anything that is not a video with an https picture', () => {
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'javascript:alert(1)' }), null);
  assert.equal(toReel({ media_type: 'IMAGE', permalink: 'https://x', thumbnail_url: 'https://x.jpg' }), null);
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'https://x.jpg', media_url: 'http://plain' }).videoUrl, undefined);
});

test('the callback only forwards the code to /admin, it saves nothing', async () => {
  const r = callbackBounce(get('/api/admin/instagram/callback?code=abc&state=def'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/admin?instagram_code=abc&instagram_state=def');
  const no = callbackBounce(get('/api/admin/instagram/callback?error=access_denied&error_reason=user_denied'));
  assert.equal(no.headers.get('Location'), '/admin?instagram_error=user_denied');
});

/* ---------- connecting, through /api/admin ---------- */

function call(env, g, meta, method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const fetchFn = async (url, init) => (await meta.fetchFn(url, init)) || g.fetchFn(String(url), init);
  return admin(new Request('https://ourjkadventures.com' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchFn);
}
async function startState(env, g, meta, token) {
  const r = await (await call(env, g, meta, 'POST', '/api/admin/instagram/start', token)).json();
  return new URL(r.url).searchParams.get('state');
}

test('only the owner can see, start or finish connecting instagram', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), meta = fakeMeta();
  const customer = await sign({});
  for (const [m, p] of [['GET', '/api/admin/instagram'], ['POST', '/api/admin/instagram/start'], ['POST', '/api/admin/instagram/finish'], ['POST', '/api/admin/instagram/disconnect']]) {
    assert.equal((await call(env, g, meta, m, p)).status, 401);
    assert.equal((await call(env, g, meta, m, p, customer, m === 'GET' ? undefined : {})).status, 403);
  }
  assert.equal(kv.writes, 0);
});

test('the owner connects: facebook sign-in with our configuration, then the key is saved and never shown', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), meta = fakeMeta();
  const token = await sign({ email: OWNER });
  assert.deepEqual(await (await call(env, g, meta, 'GET', '/api/admin/instagram', token)).json(), { configured: true, connected: false });

  const start = await (await call(env, g, meta, 'POST', '/api/admin/instagram/start', token)).json();
  const u = new URL(start.url);
  assert.equal(u.origin + u.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
  assert.equal(u.searchParams.get('client_id'), 'meta-app');
  assert.equal(u.searchParams.get('config_id'), 'cfg-7');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://ourjkadventures.com/api/admin/instagram/callback');
  const state = u.searchParams.get('state');
  assert.ok(!start.url.includes('shh'));

  // a made-up state saves nothing
  assert.equal((await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: 'f'.repeat(48) })).status, 400);
  assert.equal(kv.data.has('instagram:token'), false);

  const done = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code#_', state });
  const text = await done.text();
  assert.equal(done.status, 200);
  assert.ok(!text.includes('suat-key'));
  const status = JSON.parse(text);
  assert.equal(status.connected, true);
  assert.equal(status.username, 'ourjkadventures');
  assert.equal(status.expires_at, null);
  const saved = JSON.parse(kv.data.get('instagram:token'));
  assert.equal(saved.access_token, 'suat-key');
  assert.equal(saved.instagram_id, '1789');
  assert.equal(saved.business_id, 'biz-1');

  // the state works once
  assert.equal((await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state })).status, 400);

  // and the About page now gets real reels
  assert.equal((await (await reelsRoute(get('/api/reels'), env, meta.fetchFn)).json()).connected, true);

  // disconnect forgets the key and the saved reels
  const off = await (await call(env, g, meta, 'POST', '/api/admin/instagram/disconnect', token)).json();
  assert.equal(off.connected, false);
  assert.equal(kv.data.has('instagram:token'), false);
  assert.equal(kv.data.has('instagram:reels'), false);
});

test('with several accounts shared, @ourjkadventures is picked; with none, nothing is saved', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle();
  const token = await sign({ email: OWNER });
  let meta = fakeMeta({ accounts: [{ id: '55', username: 'someotherbrand' }, { id: '1789', username: 'OurJKAdventures' }] });
  await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  assert.equal(JSON.parse(kv.data.get('instagram:token')).instagram_id, '1789');

  const other = setup();
  meta = fakeMeta({ accounts: [], granted: [] });
  const r = await call(other.env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(other.env, g, meta, token) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'no account');
  assert.equal(other.kv.data.has('instagram:token'), false);
});

test('if the assigned list comes back empty, the account is found from what the key covers', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), meta = fakeMeta({ accounts: [] });
  const token = await sign({ email: OWNER });
  const r = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).username, 'ourjkadventures');
  assert.equal(JSON.parse(kv.data.get('instagram:token')).instagram_id, '1789');
  // the app secret only ever goes to meta's code swap and key check, never on other calls
  assert.ok(meta.calls.filter((c) => c.includes('shh')).every((c) => /\/(oauth\/access_token|debug_token)\?/.test(c)));
});

test('a key that covers "all" accounts: found through the business portfolio\'s own list', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle();
  const meta = fakeMeta({ accounts: [], granted: [{ scope: 'instagram_basic' }, { scope: 'instagram_manage_messages' }], ownedError: true, bizAccounts: [{ id: '1789', username: 'ourjkadventures' }] });
  const token = await sign({ email: OWNER });
  const r = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(kv.data.get('instagram:token')).instagram_id, '1789');
});

test('a key that covers "all" accounts and no business_management: found through INSTAGRAM_ACCOUNT_ID', async () => {
  const { env, kv } = setup({ INSTAGRAM_ACCOUNT_ID: ' 1789 ' });
  const g = fakeGoogle();
  const meta = fakeMeta({ accounts: [], granted: [{ scope: 'instagram_basic' }, { scope: 'instagram_manage_messages' }], ownedError: true });
  const token = await sign({ email: OWNER });
  const r = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).username, 'ourjkadventures');
  assert.equal(JSON.parse(kv.data.get('instagram:token')).instagram_id, '1789');
  // the told-about account is checked first, so the other lookups aren't needed
  assert.ok(!meta.calls.some((c) => c.includes('assigned_instagram_accounts')));
});

test('a wrong INSTAGRAM_ACCOUNT_ID says so, and the other lookups still run', async () => {
  const { env, kv } = setup({ INSTAGRAM_ACCOUNT_ID: '999' });
  const g = fakeGoogle(), meta = fakeMeta();
  const token = await sign({ email: OWNER });
  const r = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(kv.data.get('instagram:token')).instagram_id, '1789');
});

test('when no account can be found, /admin is told what the key covers', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), meta = fakeMeta({ accounts: [], granted: [{ scope: 'instagram_manage_messages', target_ids: ['1789'] }] });
  const token = await sign({ email: OWNER });
  const r = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) });
  const body = await r.json();
  assert.equal(r.status, 400);
  assert.equal(body.error, 'no account');
  assert.match(body.detail, /assigned accounts list was empty/);
  assert.match(body.detail, /instagram_manage_messages \(1 account\)/);
  assert.match(body.detail, /owned_instagram_accounts was empty; instagram_accounts was empty/);
  assert.ok(!JSON.stringify(body).includes('suat-key') && !JSON.stringify(body).includes('shh'));
  assert.equal(kv.data.has('instagram:token'), false);
});

test('a configuration set to expire: /admin shows when', async () => {
  const { env } = setup();
  const g = fakeGoogle(), meta = fakeMeta({ expiresIn: 5184000 });
  const token = await sign({ email: OWNER });
  const s = await (await call(env, g, meta, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: await startState(env, g, meta, token) })).json();
  assert.ok(s.expires_at > Date.now() + 59 * 24 * 3600 * 1000);
});

test('a state started by someone else, or a bad code from Meta, does not connect', async () => {
  const { env, kv } = setup({ ADMIN_EMAILS: OWNER + ',partner@example.com' });
  const g = fakeGoogle(), meta = fakeMeta();
  const owner = await sign({ email: OWNER });
  const partner = await sign({ email: 'partner@example.com' });
  const state = await startState(env, g, meta, owner);
  assert.equal((await call(env, g, meta, 'POST', '/api/admin/instagram/finish', partner, { code: 'good-code', state })).status, 400);
  const bad = await call(env, g, meta, 'POST', '/api/admin/instagram/finish', owner, { code: 'bad-code', state: await startState(env, g, meta, owner) });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).detail, /bad code/);
  assert.equal(kv.data.has('instagram:token'), false);
});

test('without the Cloudflare pieces, /admin says what is missing and connecting is refused', async () => {
  _resetCaches();
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, META_APP_ID: 'meta-app' };
  const g = fakeGoogle(), meta = fakeMeta();
  const token = await sign({ email: OWNER });
  const s = await (await call(env, g, meta, 'GET', '/api/admin/instagram', token)).json();
  assert.deepEqual(s, { configured: false, missing: ['REEL_STORE', 'META_APP_SECRET', 'INSTAGRAM_CONFIG_ID'] });
  assert.equal((await call(env, g, meta, 'POST', '/api/admin/instagram/start', token)).status, 503);
});

/* ---------- the system-user key kept in cloudflare (INSTAGRAM_ACCESS_TOKEN) ---------- */

test('with the key in cloudflare: no sign-in needed, reels come from our account', async () => {
  const { env, kv } = setup({ INSTAGRAM_ACCESS_TOKEN: ' suat-key ', INSTAGRAM_ACCOUNT_ID: '1789' });
  const meta = fakeMeta();
  const r = await reelsRoute(get('/api/reels'), env, meta.fetchFn);
  const body = await r.json();
  assert.equal(body.connected, true);
  assert.deepEqual(body.reels.map((x) => x.id), ['1', '3']);
  assert.ok(!JSON.stringify(body).includes('suat-key'));
  // nothing about the key is written to the drawer, only the saved reels
  assert.equal(kv.data.has('instagram:token'), false);
  assert.ok(!kv.data.get('instagram:reels').includes('suat-key'));
});

test('with the key in cloudflare and no meta app settings, it still works (no signature then)', async () => {
  _resetCaches();
  const kv = fakeKV();
  const env = { REEL_STORE: kv, INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '1789' };
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.searchParams.get('access_token') !== 'suat-key') return Response.json({ error: { code: 190, message: 'bad key' } }, { status: 400 });
    if (u.pathname === '/v26.0/1789') return Response.json({ id: '1789', username: 'ourjkadventures' });
    if (u.pathname === '/v26.0/1789/media') return Response.json({ data: [{ id: '1', media_type: 'VIDEO', thumbnail_url: 'https://cdn.ig/1.jpg', permalink: 'https://www.instagram.com/reel/1/' }] });
    return Response.json({ error: { code: 803, message: 'unknown' } }, { status: 404 });
  };
  const body = await (await reelsRoute(get('/api/reels'), env, fetchFn)).json();
  assert.equal(body.reels.length, 1);
  assert.ok(calls.every((c) => !c.includes('appsecret_proof')));
});

test('/admin with the key in cloudflare: a live check, and meta\'s words when it fails', async () => {
  const g = fakeGoogle();
  const token = await sign({ email: OWNER });
  const good = setup({ INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '1789' });
  let s = await (await call(good.env, g, fakeMeta(), 'GET', '/api/admin/instagram', token)).json();
  assert.equal(s.source, 'cloudflare');
  assert.equal(s.connected, true);
  assert.equal(s.username, 'ourjkadventures');
  assert.ok(!JSON.stringify(s).includes('suat-key'));

  const bad = setup({ INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '1789' });
  s = await (await call(bad.env, g, fakeMeta({ revoked: true }), 'GET', '/api/admin/instagram', token)).json();
  assert.equal(s.connected, false);
  assert.match(s.check_error, /Error validating access token/);
});

test('a failed fetch waits 30 minutes before asking meta again, and /admin hears why', async () => {
  const { env } = setup({ INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '1789' });
  const down = fakeMeta({ down: true });
  const t = Date.now();
  assert.equal((await reelsRoute(get('/api/reels'), env, down.fetchFn, t)).status, 502);
  const asked = down.calls.length;
  for (let i = 1; i < 10; i++) await reelsRoute(get('/api/reels'), env, down.fetchFn, t + i * 60 * 1000);
  assert.equal(down.calls.length, asked);
  const s = await instagramStatus(env, fakeMeta().fetchFn);
  assert.match(s.last_error, /down/);
  // after 30 minutes it tries again, and recovers
  const body = await (await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn, t + 31 * 60 * 1000)).json();
  assert.equal(body.reels.length, 2);
});

test('an instagram account linked to a facebook page the key can see is found that way', async () => {
  const { env, kv } = setup({ INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '' });
  const meta = fakeMeta({ accounts: [], granted: [{ scope: 'instagram_basic' }],
    pages: [{ id: 'p1', name: 'j+k adventures', instagram_business_account: { id: '1789', username: 'ourjkadventures' } }] });
  const body = await (await reelsRoute(get('/api/reels'), env, meta.fetchFn)).json();
  assert.equal(body.reels.length, 2);
  assert.ok(kv.data.has('instagram:reels'));
});

test('when the key opens nothing, /admin gets plain answers to test questions, never the key', async () => {
  const { env } = setup({ INSTAGRAM_ACCESS_TOKEN: 'suat-key', INSTAGRAM_ACCOUNT_ID: '555' });
  const meta = fakeMeta({ accounts: [], granted: [{ scope: 'instagram_basic' }] });
  const s = await instagramStatus(env, meta.fetchFn);
  assert.equal(s.connected, false);
  const text = s.diagnostics.join('\n');
  assert.match(text, /^key: type SYSTEM_USER, valid true, for our app true, expires never, permissions instagram_basic$/m);
  assert.match(text, /^facebook pages: none$/m);
  assert.match(text, /^assigned instagram: none$/m);
  assert.match(text, /^account 555: 404/m);
  assert.ok(!text.includes('suat-key') && !text.includes('shh'));
});
