// j+k adventures: reels from our own Instagram account, for the reel door on the About page
// (docs/reel-door-spec.md; owner steps in docs/setup/instagram.md).
//
// Uses Meta's "Instagram API with Unified Login" (the setup Meta now offers new apps). Like a staff key that belongs
// to the shop rather than to whoever collected it: the owner signs in once on /admin, choosing our business portfolio
// and @ourjkadventures, and the website is handed a key (a "system-user access token") that belongs to the business
// portfolio and doesn't expire. The key lives in a Cloudflare KV drawer (REEL_STORE) that only this worker can open,
// never in the repo or the page. Every 30 minutes at most, /api/reels uses it to fetch the latest reels and keeps a
// copy in the drawer, so visitors never reach Meta directly.
//
// Cloudflare settings:
//   REEL_STORE            KV namespace binding (wrangler.jsonc)
//   META_APP_ID           the Meta app's App ID (App settings > Basic). not secret, but kept with the secret
//   META_APP_SECRET       secret, the Meta app's App secret (App settings > Basic)
//   INSTAGRAM_CONFIG_ID   the configuration ID from "API setup with Unified login" (not secret)
//
// Meta's docs: developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login

const GRAPH_VERSION = 'v26.0';
const FB_DIALOG = 'https://www.facebook.com/' + GRAPH_VERSION + '/dialog/oauth';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
const FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,username,timestamp';
const OUR_HANDLE = 'ourjkadventures';

export const CALLBACK_PATH = '/api/admin/instagram/callback';
const KEY_TOKEN = 'instagram:token';
const KEY_REELS = 'instagram:reels';
const STATE_PREFIX = 'instagram:state:';
const SETTINGS = ['REEL_STORE', 'META_APP_ID', 'META_APP_SECRET', 'INSTAGRAM_CONFIG_ID'];

const FRESH_MS = 30 * 60 * 1000;   // serve the saved copy for this long before asking Meta again
const STATE_TTL_S = 600;           // a sign-in has ten minutes to come back
const MAX_REELS = 12;
const MAX_CAPTION = 300;

export function instagramConfigured(env) {
  return SETTINGS.every((k) => !!env[k]);
}

function json(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }
  });
}

class MetaError extends Error {
  constructor(message, keyDead) { super(message); this.keyDead = keyDead; }
}

async function metaJson(res, what) {
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.error) {
    const err = (data && data.error) || {};
    // 190: the key was revoked, the app was removed from the portfolio, or the account moved portfolios
    throw new MetaError(what + ' ' + res.status + (err.message ? ' ' + String(err.message).slice(0, 200) : ''), err.code === 190);
  }
  return data;
}

function redirectUri(requestUrl) { return new URL(CALLBACK_PATH, requestUrl).href; }

function graphUrl(path, params) {
  const u = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.href;
}

async function readToken(env) {
  return env.REEL_STORE ? env.REEL_STORE.get(KEY_TOKEN, 'json') : null;
}

/* ---------- connecting: only ever called from /api/admin, after the owner check ---------- */

// step 1: a one-time ticket ("state") that the sign-in must bring back, tied to the owner who started it
export async function startLogin(env, ownerEmail, requestUrl) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const state = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.REEL_STORE.put(STATE_PREFIX + state, JSON.stringify({ email: ownerEmail.toLowerCase(), at: Date.now() }), { expirationTtl: STATE_TTL_S });
  const u = new URL(FB_DIALOG);
  u.searchParams.set('client_id', env.META_APP_ID);
  u.searchParams.set('config_id', env.INSTAGRAM_CONFIG_ID);
  u.searchParams.set('redirect_uri', redirectUri(requestUrl));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.href;
}

// step 2: Meta sent the owner back with a code. swap it for the business's key, then find our Instagram account
export async function finishLogin(env, ownerEmail, code, state, requestUrl, fetchFn = fetch, now = Date.now()) {
  if (typeof state !== 'string' || !/^[0-9a-f]{48}$/.test(state)) return { error: 'state' };
  if (typeof code !== 'string' || !code || code.length > 2000) return { error: 'code' };
  const saved = await env.REEL_STORE.get(STATE_PREFIX + state, 'json');
  if (!saved || saved.email !== ownerEmail.toLowerCase()) return { error: 'state' };
  await env.REEL_STORE.delete(STATE_PREFIX + state);   // a ticket works once

  const tok = await metaJson(await fetchFn(graphUrl('/oauth/access_token', {
    client_id: env.META_APP_ID,
    redirect_uri: redirectUri(requestUrl),
    client_secret: env.META_APP_SECRET,
    code: code.replace(/#_$/, '')
  })), 'code exchange');
  if (!tok.access_token) throw new MetaError('code exchange gave no key');

  // with this key, /me is the business's system user, not the Instagram account
  let businessId = '';
  try {
    businessId = (await metaJson(await fetchFn(graphUrl('/me', { fields: 'client_business_id', access_token: tok.access_token })), 'business')).client_business_id || '';
  } catch (e) { console.log('instagram business id', e.message); }

  const shared = await metaJson(await fetchFn(graphUrl('/me/assigned_instagram_accounts', { fields: 'id,username', access_token: tok.access_token })), 'accounts');
  const accounts = Array.isArray(shared.data) ? shared.data.filter((a) => a && a.id) : [];
  if (!accounts.length) return { error: 'no account' };
  const ours = accounts.find((a) => String(a.username).toLowerCase() === OUR_HANDLE) || accounts[0];

  await env.REEL_STORE.put(KEY_TOKEN, JSON.stringify({
    access_token: tok.access_token,
    // system-user keys made this way don't expire; if the configuration was set to expire, remember when
    expires_at: Number(tok.expires_in) > 0 ? now + Number(tok.expires_in) * 1000 : null,
    instagram_id: String(ours.id),
    username: ours.username || '',
    business_id: businessId,
    config_id: env.INSTAGRAM_CONFIG_ID,
    connected_at: now,
    connected_by: ownerEmail.toLowerCase()
  }));
  await env.REEL_STORE.delete(KEY_REELS);   // show the newly connected account's reels straight away
  return { connected: true };
}

export async function disconnect(env) {
  await env.REEL_STORE.delete(KEY_TOKEN);
  await env.REEL_STORE.delete(KEY_REELS);
}

// what /admin shows. never includes the key itself
export async function instagramStatus(env) {
  if (!instagramConfigured(env)) return { configured: false, missing: SETTINGS.filter((k) => !env[k]) };
  const tok = await readToken(env);
  if (!tok) return { configured: true, connected: false };
  const reels = await env.REEL_STORE.get(KEY_REELS, 'json');
  return {
    configured: true,
    connected: true,
    username: tok.username || '',
    connected_at: tok.connected_at,
    expires_at: tok.expires_at || null,
    key_stopped: !!tok.key_stopped,
    reels_fetched_at: reels ? reels.fetched_at : null,
    reels_count: reels ? reels.reels.length : null
  };
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
  // no media_url means Meta held the video back (licensed music, usually): the still shows, and links to the post
  if (typeof m.media_url === 'string' && /^https:\/\//.test(m.media_url)) reel.videoUrl = m.media_url;
  return reel;
}

async function fetchReels(tok, fetchFn) {
  const data = await metaJson(await fetchFn(graphUrl('/' + encodeURIComponent(tok.instagram_id) + '/media', {
    fields: FIELDS, limit: '50', access_token: tok.access_token
  })), 'media');
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
  // the key stopped working earlier: don't keep knocking (Meta asks apps to stop retrying), serve what we have
  if (tok.key_stopped) {
    if (saved) return json({ connected: true, reels: saved.reels, stale: true }, 200, 'public, max-age=300');
    return json({ error: 'unavailable' }, 502);
  }
  try {
    const reels = await fetchReels(tok, fetchFn);
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels }));
    return json({ connected: true, reels }, 200, 'public, max-age=300');
  } catch (e) {
    console.log('instagram reels failed', e.message);
    // mark a dead key once, so /admin can say "connect again"
    if (e.keyDead) await env.REEL_STORE.put(KEY_TOKEN, JSON.stringify({ ...tok, key_stopped: true }));
    // Meta is down or the key stopped working: the last saved copy beats an empty page
    if (saved) return json({ connected: true, reels: saved.reels, stale: true }, 200, 'public, max-age=60');
    return json({ error: 'unavailable' }, 502);
  }
}

// Meta sends the owner back here. it does nothing on its own: it only carries the one-time code over to /admin,
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
    to.searchParams.set('instagram_error', (url.searchParams.get('error_reason') || url.searchParams.get('error') || 'cancelled').slice(0, 60));
  }
  return new Response(null, { status: 302, headers: { Location: to.pathname + to.search, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
}
