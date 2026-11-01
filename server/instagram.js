// j+k adventures: reels from our own Instagram account, for the reel door on the About page
// (docs/reel-door-spec.md, Path A; owner steps in docs/setup/instagram.md).
//
// Like a valet key: the owner signs in to Instagram once on /admin, and the website is handed a key that can only
// read our posts. The key lives in a Cloudflare KV drawer (REEL_STORE) that only this worker can open, never in the
// repo or the page. Every 30 minutes at most, /api/reels uses it to fetch the latest reels and keeps a copy in the
// drawer, so visitors never reach Instagram directly. Once a week a scheduled job swaps the key for a fresh one,
// so it never reaches its ~60 day expiry.
//
// Cloudflare settings:
//   REEL_STORE              KV namespace binding (wrangler.jsonc)
//   INSTAGRAM_APP_ID        secret, the Instagram app ID from the Meta app (Instagram > API setup with Instagram login)
//   INSTAGRAM_APP_SECRET    secret, the Instagram app secret from the same page

const IG_AUTHORIZE = 'https://www.instagram.com/oauth/authorize';
const IG_TOKEN = 'https://api.instagram.com/oauth/access_token';
const IG_GRAPH = 'https://graph.instagram.com';
const FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,username,timestamp';

export const CALLBACK_PATH = '/api/admin/instagram/callback';
const KEY_TOKEN = 'instagram:token';
const KEY_REELS = 'instagram:reels';
const STATE_PREFIX = 'instagram:state:';

const FRESH_MS = 30 * 60 * 1000;             // serve the saved copy for this long before asking Instagram again
const RENEW_AFTER_MS = 24 * 60 * 60 * 1000;  // Instagram only renews a key that is at least a day old
const STATE_TTL_S = 600;                     // a sign-in has ten minutes to come back
const MAX_REELS = 12;
const MAX_CAPTION = 300;

export function instagramConfigured(env) {
  return !!(env.REEL_STORE && env.INSTAGRAM_APP_ID && env.INSTAGRAM_APP_SECRET);
}

function json(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }
  });
}

async function igJson(res, what) {
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.error || data.error_type) {
    const msg = data && (data.error_message || (data.error && data.error.message) || data.error_type || data.error);
    throw new Error(what + ' ' + res.status + (msg ? ' ' + String(msg).slice(0, 200) : ''));
  }
  return data;
}

function redirectUri(requestUrl) { return new URL(CALLBACK_PATH, requestUrl).href; }

async function readToken(env) {
  return env.REEL_STORE ? env.REEL_STORE.get(KEY_TOKEN, 'json') : null;
}

/* ---------- connecting: only ever called from /api/admin, after the owner check ---------- */

// step 1: a one-time ticket ("state") that the sign-in must bring back, tied to the owner who started it
export async function startLogin(env, ownerEmail, requestUrl) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.REEL_STORE.put(STATE_PREFIX + state, JSON.stringify({ email: ownerEmail.toLowerCase(), at: Date.now() }), { expirationTtl: STATE_TTL_S });
  const u = new URL(IG_AUTHORIZE);
  u.searchParams.set('client_id', env.INSTAGRAM_APP_ID);
  u.searchParams.set('redirect_uri', redirectUri(requestUrl));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', 'instagram_business_basic');
  u.searchParams.set('state', state);
  return u.href;
}

// step 2: Instagram sent the owner back with a code. swap it for a short key, then that for a 60 day key
export async function finishLogin(env, ownerEmail, code, state, requestUrl, fetchFn = fetch, now = Date.now()) {
  if (typeof state !== 'string' || !/^[0-9a-f]{48}$/.test(state)) return { error: 'state' };
  if (typeof code !== 'string' || !code || code.length > 2000) return { error: 'code' };
  const saved = await env.REEL_STORE.get(STATE_PREFIX + state, 'json');
  if (!saved || saved.email !== ownerEmail.toLowerCase()) return { error: 'state' };
  await env.REEL_STORE.delete(STATE_PREFIX + state);   // a ticket works once

  const form = new URLSearchParams({
    client_id: env.INSTAGRAM_APP_ID,
    client_secret: env.INSTAGRAM_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri(requestUrl),
    code: code.replace(/#_$/, '')
  });
  let short = await igJson(await fetchFn(IG_TOKEN, { method: 'POST', body: form }), 'code exchange');
  if (Array.isArray(short.data)) short = short.data[0] || {};
  if (!short.access_token) throw new Error('code exchange gave no key');

  const longUrl = new URL(IG_GRAPH + '/access_token');
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', env.INSTAGRAM_APP_SECRET);
  longUrl.searchParams.set('access_token', short.access_token);
  const long = await igJson(await fetchFn(longUrl.href), 'long key');
  if (!long.access_token) throw new Error('long key missing');

  let username = '';
  try {
    const me = new URL(IG_GRAPH + '/me');
    me.searchParams.set('fields', 'user_id,username');
    me.searchParams.set('access_token', long.access_token);
    username = (await igJson(await fetchFn(me.href), 'profile')).username || '';
  } catch (e) { console.log('instagram profile', e.message); }

  await saveToken(env, {
    access_token: long.access_token,
    expires_at: now + (Number(long.expires_in) || 60 * 24 * 3600) * 1000,
    renewed_at: now,
    connected_at: now,
    connected_by: ownerEmail.toLowerCase(),
    username
  });
  await env.REEL_STORE.delete(KEY_REELS);   // show the newly connected account's reels straight away
  return { connected: true };
}

async function saveToken(env, tok) {
  await env.REEL_STORE.put(KEY_TOKEN, JSON.stringify(tok));
}

export async function disconnect(env) {
  await env.REEL_STORE.delete(KEY_TOKEN);
  await env.REEL_STORE.delete(KEY_REELS);
}

// what /admin shows. never includes the key itself
export async function instagramStatus(env) {
  if (!instagramConfigured(env)) {
    return { configured: false, missing: ['REEL_STORE', 'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'].filter((k) => !env[k]) };
  }
  const tok = await readToken(env);
  if (!tok) return { configured: true, connected: false };
  const reels = await env.REEL_STORE.get(KEY_REELS, 'json');
  return {
    configured: true,
    connected: true,
    username: tok.username || '',
    expires_at: tok.expires_at,
    renewed_at: tok.renewed_at,
    last_renew_error: tok.last_renew_error || '',
    reels_fetched_at: reels ? reels.fetched_at : null,
    reels_count: reels ? reels.reels.length : null
  };
}

/* ---------- the weekly key renewal (Cron Trigger, see wrangler.jsonc) ---------- */

export async function renewToken(env, fetchFn = fetch, now = Date.now()) {
  if (!instagramConfigured(env)) return 'not configured';
  const tok = await readToken(env);
  if (!tok) return 'not connected';
  if (now - (tok.renewed_at || 0) < RENEW_AFTER_MS) return 'too soon';
  try {
    const u = new URL(IG_GRAPH + '/refresh_access_token');
    u.searchParams.set('grant_type', 'ig_refresh_token');
    u.searchParams.set('access_token', tok.access_token);
    const fresh = await igJson(await fetchFn(u.href), 'renew');
    if (!fresh.access_token) throw new Error('renew gave no key');
    await saveToken(env, {
      ...tok,
      access_token: fresh.access_token,
      expires_at: now + (Number(fresh.expires_in) || 60 * 24 * 3600) * 1000,
      renewed_at: now,
      last_renew_error: ''
    });
    return 'renewed';
  } catch (e) {
    // keep the old key (it may still have weeks left) and let /admin show what went wrong
    console.log('instagram renew failed', e.message);
    await saveToken(env, { ...tok, last_renew_error: e.message.slice(0, 200) });
    return 'failed';
  }
}

/* ---------- GET /api/reels ---------- */

// one Instagram post, in the reel door's shape. only videos with a picture to show
export function toReel(m) {
  if (!m || m.media_type !== 'VIDEO' || typeof m.permalink !== 'string') return null;
  const thumb = typeof m.thumbnail_url === 'string' ? m.thumbnail_url : '';
  if (!/^https:\/\//.test(thumb)) return null;
  const reel = {
    id: String(m.id),
    thumbnailUrl: thumb,
    permalink: m.permalink,
    caption: typeof m.caption === 'string' ? m.caption.slice(0, MAX_CAPTION) : '',
    username: typeof m.username === 'string' ? m.username : ''
  };
  // no media_url means Instagram held the video back (licensed music, usually): the still shows, and links to the post
  if (typeof m.media_url === 'string' && /^https:\/\//.test(m.media_url)) reel.videoUrl = m.media_url;
  return reel;
}

async function fetchReels(env, tok, fetchFn) {
  const u = new URL(IG_GRAPH + '/me/media');
  u.searchParams.set('fields', FIELDS);
  u.searchParams.set('limit', '50');
  u.searchParams.set('access_token', tok.access_token);
  const data = await igJson(await fetchFn(u.href), 'media');
  return (Array.isArray(data.data) ? data.data : []).map(toReel).filter(Boolean).slice(0, MAX_REELS);
}

export async function reelsRoute(request, env, fetchFn = fetch, now = Date.now()) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  // not set up or not connected yet: the page shows its stand-in reels
  if (!instagramConfigured(env)) return json({ connected: false, reels: [] }, 200, 'public, max-age=300');
  const tok = await readToken(env);
  if (!tok) return json({ connected: false, reels: [] }, 200, 'public, max-age=300');

  const saved = await env.REEL_STORE.get(KEY_REELS, 'json');
  if (saved && now - saved.fetched_at < FRESH_MS) return json({ connected: true, reels: saved.reels }, 200, 'public, max-age=300');
  try {
    const reels = await fetchReels(env, tok, fetchFn);
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels }));
    return json({ connected: true, reels }, 200, 'public, max-age=300');
  } catch (e) {
    console.log('instagram reels failed', e.message);
    // Instagram is down or the key stopped working: the last saved copy beats an empty page
    if (saved) return json({ connected: true, reels: saved.reels, stale: true }, 200, 'public, max-age=60');
    return json({ error: 'unavailable' }, 502);
  }
}

// Instagram sends the owner back here. it does nothing on its own: it only carries the one-time code over to /admin,
// where the signed-in owner's page hands it to POST /api/admin/instagram/finish (which checks the owner as always)
export function callbackBounce(request) {
  const url = new URL(request.url);
  const to = new URL('/admin', url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (code && state) {
    to.searchParams.set('instagram_code', code);
    to.searchParams.set('instagram_state', state);
  } else {
    to.searchParams.set('instagram_error', url.searchParams.get('error_reason') || url.searchParams.get('error') || 'cancelled');
  }
  return new Response(null, { status: 302, headers: { Location: to.pathname + to.search, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
