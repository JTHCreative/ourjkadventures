// Tests for the About page's reels: /api/reels and the /admin status check (system-user key + Facebook Page).
// Meta and the KV drawer are faked, shaped like Meta's docs. Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { reelsRoute, toReel, instagramStatus } from '../server/instagram.js';
import { admin } from '../server/admin.js';
import { _resetCaches } from '../server/firebase.js';
import { fakeGoogle, sign, env as baseEnv } from './helpers.mjs';

const OWNER = 'owner@example.com';
const G = 'https://graph.facebook.com/v26.0';
const KEY = 'website-key';

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
  const linked = opts.unlinked ? {} : { instagram_business_account: { id: '1789', username: 'ourjkadventures' } };
  const proof = createHmac('sha256', 'shh').update(KEY).digest('hex');
  const fail = (status, code, message) => Response.json({ error: { message, type: 'OAuthException', code } }, { status });
  const fetchFn = async (url) => {
    url = String(url);
    calls.push(url);
    if (!url.startsWith(G)) return fail(400, 190, 'not meta');
    if (opts.down) return fail(500, 2, 'down');
    const u = new URL(url);
    if (u.pathname === '/v26.0/debug_token') {
      return Response.json({ data: { app_id: 'meta-app', type: 'SYSTEM_USER', is_valid: true, expires_at: 0, scopes: ['instagram_basic', 'pages_show_list', 'pages_read_engagement'] } });
    }
    if (u.searchParams.get('access_token') !== KEY || opts.revoked) return fail(400, 190, 'Error validating access token');
    if (u.searchParams.get('appsecret_proof') !== proof) return fail(400, 100, 'API calls from the server require an appsecret_proof argument');
    if (u.pathname === '/v26.0/me') return Response.json({ id: '1220', name: 'website' });
    if (u.pathname === '/v26.0/page-1') return Response.json({ id: 'page-1', name: 'J+K Adventures', ...linked });
    if (u.pathname === '/v26.0/me/accounts') return Response.json({ data: opts.pages || [] });
    if (u.pathname === '/v26.0/1789/media') return Response.json({ data: media });
    return fail(404, 803, 'unknown ' + u.pathname);
  };
  return { calls, fetchFn };
}

function setup(extra = {}) {
  _resetCaches();
  const kv = fakeKV();
  const env = { ...baseEnv, ADMIN_EMAILS: OWNER, REEL_STORE: kv, INSTAGRAM_ACCESS_TOKEN: ' ' + KEY + ' ', INSTAGRAM_PAGE_ID: 'page-1', META_APP_ID: 'meta-app', META_APP_SECRET: 'shh', ...extra };
  return { kv, env };
}
const get = (path) => new Request('https://ourjkadventures.com' + path);

test('without the key or the drawer, the page is told to show its stand-ins', async () => {
  for (const env of [{}, { REEL_STORE: fakeKV() }, { INSTAGRAM_ACCESS_TOKEN: KEY }]) {
    const r = await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { connected: false, reels: [] });
  }
});

test('reels come from the account linked to our page: only videos, in the reel door shape, never the key', async () => {
  const { kv, env } = setup();
  const meta = fakeMeta();
  const r = await reelsRoute(get('/api/reels'), env, meta.fetchFn);
  const text = await r.text();
  assert.ok(!text.includes(KEY));
  const body = JSON.parse(text);
  assert.equal(body.connected, true);
  assert.deepEqual(body.reels.map((x) => x.id), ['1', '3']);
  assert.deepEqual(body.reels[0], { id: '1', thumbnailUrl: 'https://cdn.ig/1.jpg', videoUrl: 'https://cdn.ig/1.mp4', permalink: 'https://www.instagram.com/reel/1/', caption: 'corgi at the beach.', username: 'ourjkadventures' });
  // no video file (licensed music): the still and the link, no videoUrl
  assert.equal(body.reels[1].videoUrl, undefined);
  // found through the page, read from the account, every call signed; the drawer only holds reels
  assert.ok(meta.calls.some((c) => c.startsWith(G + '/page-1?')));
  assert.ok(meta.calls.some((c) => c.startsWith(G + '/1789/media?')));
  assert.ok(meta.calls.every((c) => c.includes('appsecret_proof=')));
  assert.deepEqual([...kv.data.keys()], ['instagram:reels']);
  assert.ok(!kv.data.get('instagram:reels').includes(KEY));
});

test('the key\'s own page list is a fallback when INSTAGRAM_PAGE_ID is missing', async () => {
  const { env } = setup({ INSTAGRAM_PAGE_ID: '' });
  const meta = fakeMeta({ pages: [{ id: 'page-1', instagram_business_account: { id: '1789', username: 'ourjkadventures' } }] });
  const body = await (await reelsRoute(get('/api/reels'), env, meta.fetchFn)).json();
  assert.equal(body.reels.length, 2);
});

test('without META_APP_SECRET, requests go unsigned and still work', async () => {
  const { env } = setup({ META_APP_SECRET: '' });
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname === '/v26.0/page-1') return Response.json({ instagram_business_account: { id: '1789', username: 'ourjkadventures' } });
    if (u.pathname === '/v26.0/1789/media') return Response.json({ data: [{ id: '1', media_type: 'VIDEO', thumbnail_url: 'https://cdn.ig/1.jpg', permalink: 'https://www.instagram.com/reel/1/' }] });
    return Response.json({ error: { code: 803, message: 'unknown' } }, { status: 404 });
  };
  const body = await (await reelsRoute(get('/api/reels'), env, fetchFn)).json();
  assert.equal(body.reels.length, 1);
  assert.ok(calls.every((c) => !c.includes('appsecret_proof')));
});

test('reels are fetched at most every 30 minutes; visitors in between get the saved copy', async () => {
  const { env } = setup();
  const meta = fakeMeta();
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, meta.fetchFn, t);
  for (let i = 1; i <= 20; i++) await reelsRoute(get('/api/reels'), env, meta.fetchFn, t + i * 60 * 1000);
  assert.equal(meta.calls.filter((c) => c.includes('/media?')).length, 1);
  await reelsRoute(get('/api/reels'), env, meta.fetchFn, t + 31 * 60 * 1000);
  assert.equal(meta.calls.filter((c) => c.includes('/media?')).length, 2);
});

test('if Meta is down, the last saved copy is served; with no copy, a calm error, retried after 30 minutes', async () => {
  const { env } = setup();
  const t = Date.now();
  await reelsRoute(get('/api/reels'), env, fakeMeta().fetchFn, t);
  const r = await reelsRoute(get('/api/reels'), env, fakeMeta({ down: true }).fetchFn, t + 2 * 3600 * 1000);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.reels.length, 2);
  assert.equal(body.stale, true);

  const fresh = setup();
  const down = fakeMeta({ down: true });
  assert.equal((await reelsRoute(get('/api/reels'), fresh.env, down.fetchFn, t)).status, 502);
  const asked = down.calls.length;
  for (let i = 1; i < 10; i++) await reelsRoute(get('/api/reels'), fresh.env, down.fetchFn, t + i * 60 * 1000);
  assert.equal(down.calls.length, asked);
  assert.match((await instagramStatus(fresh.env, fakeMeta().fetchFn)).last_error, /down/);
  const back = await (await reelsRoute(get('/api/reels'), fresh.env, fakeMeta().fetchFn, t + 31 * 60 * 1000)).json();
  assert.equal(back.reels.length, 2);
});

test('toReel skips anything that is not a video with an https picture', () => {
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'javascript:alert(1)' }), null);
  assert.equal(toReel({ media_type: 'IMAGE', permalink: 'https://x', thumbnail_url: 'https://x.jpg' }), null);
  assert.equal(toReel({ media_type: 'VIDEO', permalink: 'https://x', thumbnail_url: 'https://x.jpg', media_url: 'http://plain' }).videoUrl, undefined);
});

/* ---------- /admin ---------- */

function call(env, g, meta, method, path, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  const fetchFn = async (url, init) => (String(url).startsWith(G) ? meta.fetchFn(url, init) : g.fetchFn(String(url), init));
  return admin(new Request('https://ourjkadventures.com' + path, { method, headers }), env, fetchFn);
}

test('only the owner sees the instagram check, and only by GET', async () => {
  const { env } = setup();
  const g = fakeGoogle(), meta = fakeMeta();
  assert.equal((await call(env, g, meta, 'GET', '/api/admin/instagram')).status, 401);
  assert.equal((await call(env, g, meta, 'GET', '/api/admin/instagram', await sign({}))).status, 403);
  const owner = await sign({ email: OWNER });
  assert.equal((await call(env, g, meta, 'POST', '/api/admin/instagram', owner)).status, 405);
  // the old sign-in routes are gone
  for (const p of ['/api/admin/instagram/start', '/api/admin/instagram/finish', '/api/admin/instagram/disconnect']) {
    assert.equal((await call(env, g, meta, 'POST', p, owner)).status, 404);
  }
});

test('/admin: a live check says connected, as whom, and never shows the key', async () => {
  const { env } = setup();
  const g = fakeGoogle(), meta = fakeMeta();
  const r = await call(env, g, meta, 'GET', '/api/admin/instagram', await sign({ email: OWNER }));
  const text = await r.text();
  assert.ok(!text.includes(KEY) && !text.includes('shh'));
  const s = JSON.parse(text);
  assert.equal(s.connected, true);
  assert.equal(s.username, 'ourjkadventures');
  assert.deepEqual(s.diagnostics, []);
});

test('/admin: when the key does not open the account, meta\'s answers to test questions, never the key', async () => {
  const { env } = setup();
  const s = await instagramStatus(env, fakeMeta({ unlinked: true }).fetchFn);
  assert.equal(s.connected, false);
  assert.match(s.check_error, /the page has no linked instagram account/);
  const text = s.diagnostics.join('\n');
  assert.match(text, /^key: type SYSTEM_USER, valid true, for our app true, expires never, permissions instagram_basic pages_show_list pages_read_engagement$/m);
  assert.match(text, /^who the key is: website \(1220\)$/m);
  assert.match(text, /^page page-1: J\+K Adventures -> no instagram linked$/m);
  assert.match(text, /^facebook pages: none$/m);
  assert.ok(!text.includes(KEY) && !text.includes('shh'));

  const revoked = await instagramStatus(env, fakeMeta({ revoked: true }).fetchFn);
  assert.equal(revoked.connected, false);
  assert.match(revoked.check_error, /Error validating access token/);
});

test('/admin: says what is missing in cloudflare', async () => {
  assert.deepEqual(await instagramStatus({}, fakeMeta().fetchFn), { configured: false, missing: ['INSTAGRAM_ACCESS_TOKEN', 'REEL_STORE'] });
  assert.deepEqual(await instagramStatus({ INSTAGRAM_ACCESS_TOKEN: KEY }, fakeMeta().fetchFn), { configured: false, missing: ['REEL_STORE'] });
});
