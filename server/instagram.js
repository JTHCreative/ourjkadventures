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
//   INSTAGRAM_ACCOUNT_ID  @ourjkadventures' account ID (not secret, in wrangler.jsonc). Meta's key covers "all" accounts
//                         without naming ours, and the lists that would name it need business_management
//   INSTAGRAM_PAGE_ID     the J+K Adventures Facebook Page's ID (not secret, in wrangler.jsonc). The system-user key
//                         reaches @ourjkadventures through this Page, but Meta leaves the Page out of the key's own
//                         list of Pages, so the website asks for it by ID
//   INSTAGRAM_ACCESS_TOKEN  secret, optional: a system-user key made in our own business settings. When it's set, the
//                         website uses it and the sign-in on /admin isn't needed. This is the way that works for an app
//                         and an Instagram account in the same business portfolio: Meta's sign-in keys are meant for
//                         apps that serve other businesses (docs/decisions.md, 2026-11)
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

// Meta's recommended signature on every call made with the key: a fingerprint of the key made with the app secret,
// so a key copied out of here would be useless without the secret too
async function appsecretProof(env, token) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.META_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(token));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function keyedUrl(env, path, token, params) {
  const extra = env.META_APP_SECRET ? { appsecret_proof: await appsecretProof(env, token) } : {};
  return graphUrl(path, { ...params, access_token: token, ...extra });
}

// the system-user key kept as a Cloudflare secret, if there is one
function cloudflareKey(env) {
  return typeof env.INSTAGRAM_ACCESS_TOKEN === 'string' ? env.INSTAGRAM_ACCESS_TOKEN.trim() : '';
}

// which Instagram account was shared. Meta's guide says /me/assigned_instagram_accounts; if that comes back empty,
// the key's own description (debug_token) may list the account IDs each permission covers, and failing that the
// business portfolio's own lists of Instagram accounts. what each one said goes back to /admin if all come up empty
async function findAccounts(env, token, businessId, fetchFn) {
  const notes = [];
  // the account we were told about: check the key can read it, and use the ID Meta gives back
  if (env.INSTAGRAM_ACCOUNT_ID) {
    try {
      const a = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(String(env.INSTAGRAM_ACCOUNT_ID).trim()), token, { fields: 'id,username' })), 'INSTAGRAM_ACCOUNT_ID');
      if (a && a.id) return { accounts: [{ id: String(a.id), username: a.username || '' }], notes };
      notes.push('INSTAGRAM_ACCOUNT_ID gave nothing back');
    } catch (e) { notes.push(e.message); }
  }
  try {
    const shared = await metaJson(await fetchFn(await keyedUrl(env, '/me/assigned_instagram_accounts', token, { fields: 'id,username' })), 'assigned accounts');
    const list = (Array.isArray(shared.data) ? shared.data : []).filter((a) => a && a.id);
    if (list.length) return { accounts: list, notes };
    notes.push('assigned accounts list was empty');
  } catch (e) { notes.push(e.message); }

  let scopes = [];
  try {
    const dbg = await metaJson(await fetchFn(graphUrl('/debug_token', {
      input_token: token, access_token: env.META_APP_ID + '|' + env.META_APP_SECRET
    })), 'key check');
    scopes = (dbg.data && Array.isArray(dbg.data.granular_scopes)) ? dbg.data.granular_scopes : [];
    notes.push('key covers: ' + (scopes.map((g) => g.scope + ' (' + (Array.isArray(g.target_ids) ? g.target_ids.length + ' account' + (g.target_ids.length === 1 ? '' : 's') : 'all') + ')').join(', ') || 'nothing'));
  } catch (e) { notes.push(e.message); }

  const basic = scopes.find((g) => g.scope === 'instagram_basic');
  const ids = basic && Array.isArray(basic.target_ids) ? basic.target_ids.map(String) : [];
  const found = [];
  for (const id of ids.slice(0, 5)) {
    try {
      const a = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(id), token, { fields: 'id,username' })), 'account ' + id);
      if (a && a.id) found.push({ id: String(a.id), username: a.username || '' });
    } catch (e) { notes.push(e.message); }
  }
  if (found.length) return { accounts: found, notes };

  // the Instagram account linked to our Facebook Page, asked for by the Page's ID
  if (env.INSTAGRAM_PAGE_ID) {
    try {
      const page = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(String(env.INSTAGRAM_PAGE_ID).trim()), token, { fields: 'instagram_business_account{id,username}' })), 'INSTAGRAM_PAGE_ID');
      const a = page && page.instagram_business_account;
      if (a && a.id) return { accounts: [{ id: String(a.id), username: a.username || '' }], notes };
      notes.push('INSTAGRAM_PAGE_ID has no linked instagram account');
    } catch (e) { notes.push(e.message); }
  }

  // an Instagram account linked to a Facebook Page the key can see (the classic Facebook-login way)
  try {
    const pages = await metaJson(await fetchFn(await keyedUrl(env, '/me/accounts', token, { fields: 'instagram_business_account{id,username}' })), 'pages');
    const linked = (Array.isArray(pages.data) ? pages.data : []).map((p) => p && p.instagram_business_account).filter((a) => a && a.id)
      .map((a) => ({ id: String(a.id), username: a.username || '' }));
    if (linked.length) return { accounts: linked, notes };
    notes.push('no facebook page with instagram');
  } catch (e) { notes.push(e.message); }

  // the business portfolio's own lists of Instagram accounts
  if (!businessId) { notes.push('no business id'); return { accounts: [], notes }; }
  for (const edge of ['owned_instagram_accounts', 'instagram_accounts']) {
    try {
      const r = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(businessId) + '/' + edge, token, { fields: 'id,username' })), edge);
      const list = (Array.isArray(r.data) ? r.data : []).filter((a) => a && a.id).map((a) => ({ id: String(a.id), username: a.username || '' }));
      if (list.length) return { accounts: list, notes };
      notes.push(edge + ' was empty');
    } catch (e) { notes.push(e.message); }
  }
  return { accounts: [], notes };
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
    businessId = (await metaJson(await fetchFn(await keyedUrl(env, '/me', tok.access_token, { fields: 'client_business_id' })), 'business')).client_business_id || '';
  } catch (e) { console.log('instagram business id', e.message); }

  const { accounts, notes } = await findAccounts(env, tok.access_token, businessId, fetchFn);
  if (!accounts.length) {
    console.log('instagram: no account found', notes.join('; '));
    return { error: 'no account', detail: notes.join('; ').slice(0, 400) };
  }
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

// when the key doesn't open our account: a set of read-only questions to Meta, each answer in a line for /admin.
// never includes the key. this is how we tell a wrong account ID from a missing Facebook Page from a missing permission
async function diagnose(env, key, fetchFn) {
  const out = [];
  const ask = async (label, url, pick) => {
    try {
      const res = await fetchFn(url);
      let data = null;
      try { data = await res.json(); } catch (e) {}
      if (!res.ok || !data || data.error) {
        const err = (data && data.error) || {};
        out.push(label + ': ' + res.status + ' ' + (err.code ? '(#' + err.code + ') ' : '') + String(err.message || '').slice(0, 140));
      } else out.push(label + ': ' + String(pick(data)).slice(0, 200));
    } catch (e) { out.push(label + ': ' + e.message.slice(0, 140)); }
  };
  const id = env.INSTAGRAM_ACCOUNT_ID ? encodeURIComponent(String(env.INSTAGRAM_ACCOUNT_ID).trim()) : '';
  if (env.META_APP_ID && env.META_APP_SECRET) {
    await ask('key', graphUrl('/debug_token', { input_token: key, access_token: env.META_APP_ID + '|' + env.META_APP_SECRET }), (d) => {
      const x = d.data || {};
      return 'type ' + x.type + ', valid ' + x.is_valid + ', for our app ' + (String(x.app_id) === String(env.META_APP_ID)) +
        ', expires ' + (x.expires_at ? new Date(x.expires_at * 1000).toISOString().slice(0, 10) : 'never') +
        ', permissions ' + (Array.isArray(x.scopes) ? x.scopes.join(' ') : '?');
    });
  }
  await ask('who the key is', await keyedUrl(env, '/me', key, { fields: 'id,name' }), (d) => d.name + ' (' + d.id + ')');
  await ask('facebook pages', await keyedUrl(env, '/me/accounts', key, { fields: 'name,instagram_business_account{id,username}' }),
    (d) => (d.data || []).map((p) => p.name + ' -> ' + (p.instagram_business_account ? '@' + p.instagram_business_account.username + ' ' + p.instagram_business_account.id : 'no instagram')).join(', ') || 'none');
  await ask('assigned instagram', await keyedUrl(env, '/me/assigned_instagram_accounts', key, { fields: 'id,username' }),
    (d) => (d.data || []).map((a) => '@' + a.username + ' ' + a.id).join(', ') || 'none');
  if (env.INSTAGRAM_PAGE_ID) {
    const pid = encodeURIComponent(String(env.INSTAGRAM_PAGE_ID).trim());
    await ask('page ' + pid, await keyedUrl(env, '/' + pid, key, { fields: 'name,instagram_business_account{id,username}' }),
      (d) => d.name + ' -> ' + (d.instagram_business_account ? '@' + d.instagram_business_account.username + ' ' + d.instagram_business_account.id : 'no instagram linked'));
  }
  if (id) {
    await ask('account ' + id, await keyedUrl(env, '/' + id, key, { fields: 'id' }), (d) => 'found ' + d.id);
    await ask('account ' + id + ' posts', await keyedUrl(env, '/' + id + '/media', key, { fields: 'id', limit: '1' }), (d) => (d.data || []).length + ' found');
  }
  await ask('instagram host', 'https://graph.instagram.com/' + GRAPH_VERSION + '/me?fields=user_id,username&access_token=' + encodeURIComponent(key), (d) => '@' + d.username + ' ' + d.user_id);
  return out;
}

// what /admin shows. never includes the key itself
export async function instagramStatus(env, fetchFn = fetch) {
  const key = cloudflareKey(env);
  if (key) {
    if (!env.REEL_STORE) return { configured: false, missing: ['REEL_STORE'] };
    // a live check that the key opens our account, with meta's words if it doesn't
    const { accounts, notes } = await findAccounts(env, key, '', fetchFn);
    const reels = await env.REEL_STORE.get(KEY_REELS, 'json');
    return {
      configured: true,
      connected: accounts.length > 0,
      source: 'cloudflare',
      username: accounts.length ? accounts[0].username : '',
      check_error: accounts.length ? '' : notes.join('; ').slice(0, 400),
      diagnostics: accounts.length ? [] : await diagnose(env, key, fetchFn),
      last_error: reels && reels.last_error ? reels.last_error : '',
      reels_fetched_at: reels ? reels.fetched_at : null,
      reels_count: reels ? reels.reels.length : null
    };
  }
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
    last_error: reels && reels.last_error ? reels.last_error : '',
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

async function fetchReels(env, tok, fetchFn) {
  const data = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(tok.instagram_id) + '/media', tok.access_token, {
    fields: FIELDS, limit: '50'
  })), 'media');
  return (Array.isArray(data.data) ? data.data : []).map(toReel).filter(Boolean).slice(0, MAX_REELS);
}

export async function reelsRoute(request, env, fetchFn = fetch, now = Date.now()) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  // not set up or not connected yet: the page shows its stand-in reels
  const notConnected = () => json({ connected: false, reels: [] }, 200, 'public, max-age=300');
  if (!env.REEL_STORE) return notConnected();
  const key = cloudflareKey(env);
  let tok;
  if (key) tok = { access_token: key, source: 'cloudflare' };
  else {
    if (!instagramConfigured(env)) return notConnected();
    tok = await readToken(env);
    if (!tok) return notConnected();
  }

  const saved = await env.REEL_STORE.get(KEY_REELS, 'json');
  if (saved && now - saved.fetched_at < FRESH_MS) return json({ connected: true, reels: saved.reels }, 200, 'public, max-age=300');
  // the key stopped working earlier: don't keep knocking (Meta asks apps to stop retrying), serve what we have
  if (tok.key_stopped) {
    if (saved) return json({ connected: true, reels: saved.reels, stale: true }, 200, 'public, max-age=300');
    return json({ error: 'unavailable' }, 502);
  }
  try {
    if (!tok.instagram_id) {
      // the cloudflare key doesn't say which account it's for: look it up (once per fetch, every 30 minutes at most)
      const { accounts, notes } = await findAccounts(env, tok.access_token, '', fetchFn);
      if (!accounts.length) throw new MetaError('no account: ' + notes.join('; '));
      tok.instagram_id = accounts[0].id;
    }
    const reels = await fetchReels(env, tok, fetchFn);
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels }));
    return json({ connected: true, reels }, 200, 'public, max-age=300');
  } catch (e) {
    console.log('instagram reels failed', e.message);
    // mark a dead sign-in key once, so /admin can say "connect again"
    if (e.keyDead && tok.source !== 'cloudflare') await env.REEL_STORE.put(KEY_TOKEN, JSON.stringify({ ...tok, key_stopped: true }));
    // try again in 30 minutes, not on every visit, and let /admin show what went wrong
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels: saved ? saved.reels : [], last_error: e.message.slice(0, 300) }));
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
