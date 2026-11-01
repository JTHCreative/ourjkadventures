// Tests for the About page's reels: /api/reels, connecting Instagram on /admin, and the weekly key renewal.
// Instagram and the KV drawer are faked. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { reelsRoute, renewToken, callbackBounce, toReel, instagramStatus } from '../server/instagram.js';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { fakeGoogle, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const DAY = 24 * 3600 * 1000;

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

// a pretend Instagram
function fakeInstagram(opts = {}) {
  const calls = [];
  const media = opts.media || [
    { id: '1', media_type: 'VIDEO', media_url: 'https://cdn.ig/1.mp4', thumbnail_url: 'https://cdn.ig/1.jpg', permalink: 'https://www.instagram.com/reel/1/', caption: 'corgi at the beach.', username: 'ourjkadventures' },
    { id: '2', media_type: 'IMAGE', media_url: 'https://cdn.ig/2.jpg', permalink: 'https://www.instagram.com/p/2/' },
    { id: '3', media_type: 'VIDEO', thumbnail_url: 'https://cdn.ig/3.jpg', permalink: 'https://www.instagram.com/reel/3/', caption: 'licensed music.', username: 'ourjkadventures' },
    { id: '4', media_type: 'CAROUSEL_ALBUM', permalink: 'https://www.instagram.com/p/4/' }
  ];
  const fetchFn = async (url, init = {}) => {
    url = String(url);
    calls.push((init.method || 'GET') + ' ' + url);
    if (opts.down) return new Response('{"error":{"message":"down"}}', { status: 500 });
    if (url === 'https://api.instagram.com/oauth/access_token') {
      const f = new URLSearchParams(init.body);
      if (f.get('code') !== 'good-code' || f.get('client_secret') !== 'shh') return Response.json({ error_type: 'OAuthException', error_message: 'bad code' }, { status: 400 });
      return Response.json({ data: [{ access_token: 'short-key', user_id: '42', permissions: 'instagram_business_basic' }] });
    }
    if (url.startsWith('https://graph.instagram.com/access_token')) return Response.json({ access_token: 'long-key', token_type: 'bearer', expires_in: 5184000 });
    if (url.startsWith('https://graph.instagram.com/refresh_access_token')) {
      if (opts.renewFails) return Response.json({ error: { message: 'session expired' } }, { status: 400 });
      return Response.json({ access_token: 'renewed-key', token_type: 'bearer', expires_in: 5184000 });
    }
    if (url.startsWith('https://graph.instagram.com/me/media')) return Response.json({ data: media });
    if (url.startsWith('https://graph.instagram.com/me')) return Response.json({ user_id: '42', username: 'ourjkadventures' });
    return null;
  };
  return { calls, fetchFn };
}

function setup(extra = {}) {
  _resetCaches();
  const kv = fakeKV();
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, REEL_STORE: kv, INSTAGRAM_APP_ID: 'app-1', INSTAGRAM_APP_SECRET: 'shh', ...extra };
  return { kv, env };
}
const get = (path) => new Request('https://ourjkadventures.com' + path);
const connected = (kv, t = Date.now()) => kv.data.set('instagram:token', JSON.stringify({ access_token: 'long-key', expires_at: t + 60 * DAY, renewed_at: t, username: 'ourjkadventures' }));

test('not set up, or not connected yet: the page is told to show its stand-ins', async () => {
  for (const env of [{}, { REEL_STORE: fakeKV() }, setup().env]) {
    const r = await reelsRoute(get('/api/reels'), env, fakeInstagram().fetchFn);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { connected: false, reels: [] });
  }
});

test('only videos come through, in the reel door shape, and the key never does', async () => {
  const { kv, env } = setup();
  connected(kv);
  const ig = fakeInstagram();
  const r = await reelsRoute(get('/api/reels'), env, ig.fetchFn);
  const text = await r.text();
  assert.ok(!text.includes('long-key'));
  const body = JSON.parse(text);
  assert.equal(body.connected, true);
  assert.deepEqual(body.reels.map((x) => x.id), ['1', '3']);
  assert.deepEqual(body.reels[0], { id: '1', thumbnailUrl: 'https://cdn.ig/1.jpg', videoUrl: 'https://cdn.ig/1.mp4', permalink: 'https://www.instagram.com/reel/1/', caption: 'corgi at the beach.', username: 'ourjkadventures' });
  // no video file (licensed music): the still and the link, no videoUrl
  assert.equal(body.reels[1].videoUrl, undefined);
});

test('reels are fetched at most every 30 minutes; visitors in between get the saved copy', async () => {
  const { kv, env } = setup();
  connected(kv);
  const ig = fakeInstagram();
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, ig.fetchFn, t);
  for (let i = 1; i <= 20; i++) await reelsRoute(get('/api/reels'), env, ig.fetchFn, t + i * 60 * 1000);
  assert.equal(ig.calls.filter((c) => c.includes('/me/media')).length, 1);
  await reelsRoute(get('/api/reels'), env, ig.fetchFn, t + 31 * 60 * 1000);
  assert.equal(ig.calls.filter((c) => c.includes('/me/media')).length, 2);
  // the media call carries the key, but only to Instagram
  assert.ok(ig.calls.find((c) => c.includes('/me/media')).startsWith('GET https://graph.instagram.com/'));
});

test('if Instagram is down, the last saved copy is served; with no copy, a calm error', async () => {
  const { kv, env } = setup();
  connected(kv);
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, fakeInstagram().fetchFn, t);
  const r = await reelsRoute(get('/api/reels'), env, fakeInstagram({ down: true }).fetchFn, t + 2 * 3600 * 1000);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.reels.length, 2);
  assert.equal(body.stale, true);

  const fresh = setup();
  connected(fresh.kv);
  assert.equal((await reelsRoute(get('/api/reels'), fresh.env, fakeInstagram({ down: true }).fetchFn)).status, 502);
});

test('toReel skips anything that is not a video with an https picture', () => {
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'javascript:alert(1)' }), null);
  assert.equal(toReel({ media_type: 'IMAGE', permalink: 'https://x', thumbnail_url: 'https://x.jpg' }), null);
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'https://x.jpg', media_url: 'http://plain' }).videoUrl, undefined);
});

test('the weekly renewal swaps the key, waits a day between, and keeps the old key if Instagram says no', async () => {
  const { kv, env } = setup();
  const t = Date.now();
  assert.equal(await renewToken(env, fakeInstagram().fetchFn, t), 'not connected');
  connected(kv, t);
  assert.equal(await renewToken(env, fakeInstagram().fetchFn, t + 3600 * 1000), 'too soon');
  assert.equal(await renewToken(env, fakeInstagram().fetchFn, t + 7 * DAY), 'renewed');
  let tok = JSON.parse(kv.data.get('instagram:token'));
  assert.equal(tok.access_token, 'renewed-key');
  assert.equal(tok.expires_at, t + 7 * DAY + 5184000 * 1000);

  assert.equal(await renewToken(env, fakeInstagram({ renewFails: true }).fetchFn, t + 14 * DAY), 'failed');
  tok = JSON.parse(kv.data.get('instagram:token'));
  assert.equal(tok.access_token, 'renewed-key');
  assert.match(tok.last_renew_error, /session expired/);
  assert.match((await instagramStatus(env)).last_renew_error, /session expired/);
  assert.equal(await renewToken({}, fakeInstagram().fetchFn), 'not configured');
});

test('the callback only forwards the code to /admin, it saves nothing', async () => {
  const r = callbackBounce(get('/api/admin/instagram/callback?code=abc&state=def'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), '/admin?instagram_code=abc&instagram_state=def');
  const no = callbackBounce(get('/api/admin/instagram/callback?error=access_denied&error_reason=user_denied'));
  assert.equal(no.headers.get('Location'), '/admin?instagram_error=user_denied');
});

/* ---------- connecting, through /api/admin ---------- */

function call(env, g, ig, method, path, token, body) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const fetchFn = async (url, init) => (await ig.fetchFn(url, init)) || g.fetchFn(String(url), init);
  return admin(new Request('https://ourjkadventures.com' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, fetchFn);
}

test('only the owner can see, start or finish connecting instagram', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), ig = fakeInstagram();
  const customer = await sign({});
  for (const [m, p] of [['GET', '/api/admin/instagram'], ['POST', '/api/admin/instagram/start'], ['POST', '/api/admin/instagram/finish'], ['POST', '/api/admin/instagram/disconnect']]) {
    assert.equal((await call(env, g, ig, m, p)).status, 401);
    assert.equal((await call(env, g, ig, m, p, customer, m === 'GET' ? undefined : {})).status, 403);
  }
  assert.equal(kv.writes, 0);
});

test('the owner connects: start, sign in, finish; the key is saved and never shown', async () => {
  const { env, kv } = setup();
  const g = fakeGoogle(), ig = fakeInstagram();
  const token = await sign({ email: OWNER });
  assert.deepEqual(await (await call(env, g, ig, 'GET', '/api/admin/instagram', token)).json(), { configured: true, connected: false });

  const start = await (await call(env, g, ig, 'POST', '/api/admin/instagram/start', token)).json();
  const u = new URL(start.url);
  assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), 'app-1');
  assert.equal(u.searchParams.get('redirect_uri'), 'https://ourjkadventures.com/api/admin/instagram/callback');
  assert.equal(u.searchParams.get('scope'), 'instagram_business_basic');
  const state = u.searchParams.get('state');
  assert.ok(!start.url.includes('shh'));

  // a made-up state, or a bad code, saves nothing
  assert.equal((await call(env, g, ig, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state: 'f'.repeat(48) })).status, 400);
  assert.equal(kv.data.has('instagram:token'), false);

  const done = await call(env, g, ig, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code#_', state });
  const text = await done.text();
  assert.equal(done.status, 200);
  assert.ok(!text.includes('long-key') && !text.includes('short-key'));
  const status = JSON.parse(text);
  assert.equal(status.connected, true);
  assert.equal(status.username, 'ourjkadventures');
  assert.equal(JSON.parse(kv.data.get('instagram:token')).access_token, 'long-key');

  // the state works once
  assert.equal((await call(env, g, ig, 'POST', '/api/admin/instagram/finish', token, { code: 'good-code', state })).status, 400);

  // and the About page now gets real reels
  assert.equal((await (await reelsRoute(get('/api/reels'), env, ig.fetchFn)).json()).connected, true);

  // disconnect forgets the key and the saved reels
  const off = await (await call(env, g, ig, 'POST', '/api/admin/instagram/disconnect', token)).json();
  assert.equal(off.connected, false);
  assert.equal(kv.data.has('instagram:token'), false);
  assert.equal(kv.data.has('instagram:reels'), false);
});

test('a state started by someone else, or a bad code from Instagram, does not connect', async () => {
  const { env, kv } = setup({ ADMIN_EMAILS: OWNER + ',partner@example.com' });
  const g = fakeGoogle(), ig = fakeInstagram();
  const owner = await sign({ email: OWNER });
  const partner = await sign({ email: 'partner@example.com' });
  const state = new URL((await (await call(env, g, ig, 'POST', '/api/admin/instagram/start', owner)).json()).url).searchParams.get('state');
  assert.equal((await call(env, g, ig, 'POST', '/api/admin/instagram/finish', partner, { code: 'good-code', state })).status, 400);
  const state2 = new URL((await (await call(env, g, ig, 'POST', '/api/admin/instagram/start', owner)).json()).url).searchParams.get('state');
  assert.equal((await call(env, g, ig, 'POST', '/api/admin/instagram/finish', owner, { code: 'bad-code', state: state2 })).status, 502);
  assert.equal(kv.data.has('instagram:token'), false);
});

test('without the Cloudflare pieces, /admin says what is missing and connecting is refused', async () => {
  _resetCaches();
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER };
  const g = fakeGoogle(), ig = fakeInstagram();
  const token = await sign({ email: OWNER });
  const s = await (await call(env, g, ig, 'GET', '/api/admin/instagram', token)).json();
  assert.deepEqual(s, { configured: false, missing: ['REEL_STORE', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'] });
  assert.equal((await call(env, g, ig, 'POST', '/api/admin/instagram/start', token)).status, 503);
});
