// j+k adventures: reels from our own Instagram account, for the reel door on the About page
// (docs/reel-door-spec.md; owner steps in docs/setup/instagram.md; why it works this way in docs/decisions.md).
//
// Like a staff key cut at the front desk: a "system user" called website in our own Business settings has a key that
// can only read, never expires, and is kept as a Cloudflare secret. Meta lets that kind of key reach an Instagram
// account through the Facebook Page it's linked to, so the website asks for the J+K Adventures Page by ID and reads
// the @ourjkadventures account linked to it. Every 10 minutes at most, /api/reels fetches the latest reels and keeps
// a copy in Cloudflare KV, so visitors never reach Meta directly.
//
// Cloudflare settings:
//   INSTAGRAM_ACCESS_TOKEN  secret, the website system user's key (instagram_basic, pages_show_list,
//                           pages_read_engagement, and instagram_manage_insights for share counts; never expires)
//   INSTAGRAM_PAGE_ID       the J+K Adventures Facebook Page's ID (not secret, in wrangler.jsonc)
//   REEL_STORE              KV namespace binding for the saved copy (wrangler.jsonc)
//   META_APP_SECRET         secret, the Meta app's App secret: signs every request (appsecret_proof)
//   META_APP_ID             optional, the Meta app's App ID: only for the "key" line in /admin's test answers

const GRAPH_VERSION = 'v26.0';
const GRAPH = 'https://graph.facebook.com/' + GRAPH_VERSION;
// like_count is left out by Meta when we hid the like count on that post; comments_count only shows if comments are on
const FIELDS = 'id,media_type,media_url,thumbnail_url,permalink,caption,username,timestamp,like_count,comments_count,is_comment_enabled';

const KEY_REELS = 'instagram:reels';
const FRESH_MS = 10 * 60 * 1000;   // serve the saved copy for this long before asking Meta again (counts stay fresh)
const MAX_REELS = 12;
const MAX_CAPTION = 2200;          // instagram's own caption limit: the full screen shows all of it

function json(body, status, cache) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': cache || 'no-store' }
  });
}

async function metaJson(res, what) {
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || !data || data.error) {
    const err = (data && data.error) || {};
    throw new Error(what + ' ' + res.status + (err.code ? ' (#' + err.code + ')' : '') + (err.message ? ' ' + String(err.message).slice(0, 200) : ''));
  }
  return data;
}

function graphUrl(path, params) {
  const u = new URL(GRAPH + path);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  return u.href;
}

// Meta's recommended signature on every call made with the key: a fingerprint of the key made with the app secret,
// so a key copied out of here would be useless without the secret too
async function appsecretProof(secret, token) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(token));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function keyedUrl(env, path, token, params) {
  const extra = env.META_APP_SECRET ? { appsecret_proof: await appsecretProof(env.META_APP_SECRET, token) } : {};
  return graphUrl(path, { ...params, access_token: token, ...extra });
}

function accessKey(env) {
  return typeof env.INSTAGRAM_ACCESS_TOKEN === 'string' ? env.INSTAGRAM_ACCESS_TOKEN.trim() : '';
}
function pageId(env) {
  return env.INSTAGRAM_PAGE_ID ? encodeURIComponent(String(env.INSTAGRAM_PAGE_ID).trim()) : '';
}

// which Instagram account to read: the one linked to our Page, asked for by ID. Meta leaves the Page out of the
// key's own list of Pages, so that list is only a fallback. what each step said goes back to /admin if both fail
async function findAccount(env, key, fetchFn) {
  const notes = [];
  const pid = pageId(env);
  if (pid) {
    try {
      const page = await metaJson(await fetchFn(await keyedUrl(env, '/' + pid, key, { fields: 'instagram_business_account{id,username}' })), 'page');
      const a = page.instagram_business_account;
      if (a && a.id) return { account: { id: String(a.id), username: a.username || '' }, notes };
      notes.push('the page has no linked instagram account');
    } catch (e) { notes.push(e.message); }
  } else notes.push('INSTAGRAM_PAGE_ID is not set');
  try {
    const pages = await metaJson(await fetchFn(await keyedUrl(env, '/me/accounts', key, { fields: 'instagram_business_account{id,username}' })), 'pages');
    const a = (Array.isArray(pages.data) ? pages.data : []).map((p) => p && p.instagram_business_account).find((x) => x && x.id);
    if (a) return { account: { id: String(a.id), username: a.username || '' }, notes };
    notes.push('no facebook page with instagram');
  } catch (e) { notes.push(e.message); }
  return { account: null, notes };
}

// when the key doesn't open our account: a few read-only questions to Meta, each answer a line on /admin.
// never includes the key
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
  if (env.META_APP_ID && env.META_APP_SECRET) {
    await ask('key', graphUrl('/debug_token', { input_token: key, access_token: env.META_APP_ID + '|' + env.META_APP_SECRET }), (d) => {
      const x = d.data || {};
      return 'type ' + x.type + ', valid ' + x.is_valid + ', for our app ' + (String(x.app_id) === String(env.META_APP_ID)) +
        ', expires ' + (x.expires_at ? new Date(x.expires_at * 1000).toISOString().slice(0, 10) : 'never') +
        ', permissions ' + (Array.isArray(x.scopes) ? x.scopes.join(' ') : '?');
    });
  }
  await ask('who the key is', await keyedUrl(env, '/me', key, { fields: 'id,name' }), (d) => d.name + ' (' + d.id + ')');
  const pid = pageId(env);
  if (pid) {
    await ask('page ' + pid, await keyedUrl(env, '/' + pid, key, { fields: 'name,instagram_business_account{id,username}' }),
      (d) => d.name + ' -> ' + (d.instagram_business_account ? '@' + d.instagram_business_account.username + ' ' + d.instagram_business_account.id : 'no instagram linked'));
  }
  await ask('facebook pages', await keyedUrl(env, '/me/accounts', key, { fields: 'name,instagram_business_account{id,username}' }),
    (d) => (d.data || []).map((p) => p.name + ' -> ' + (p.instagram_business_account ? '@' + p.instagram_business_account.username : 'no instagram')).join(', ') || 'none');
  return out;
}

// what /admin shows: a live check that the key opens our account. never includes the key itself
export async function instagramStatus(env, fetchFn = fetch) {
  const missing = [];
  if (!accessKey(env)) missing.push('INSTAGRAM_ACCESS_TOKEN');
  if (!env.REEL_STORE) missing.push('REEL_STORE');
  if (missing.length) return { configured: false, missing };
  const key = accessKey(env);
  const { account, notes } = await findAccount(env, key, fetchFn);
  const reels = await env.REEL_STORE.get(KEY_REELS, 'json');
  return {
    configured: true,
    connected: !!account,
    username: account ? account.username : '',
    check_error: account ? '' : notes.join('; ').slice(0, 400),
    diagnostics: account ? [] : await diagnose(env, key, fetchFn),
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
  // the counts, only the ones that are public on instagram: a hidden like count also hides shares, like instagram does
  const count = (v) => Number.isInteger(v) && v >= 0;
  if (count(m.like_count)) {
    reel.likes = m.like_count;
    if (count(m.shares)) reel.shares = m.shares;
  }
  if (count(m.comments_count) && m.is_comment_enabled !== false) reel.comments = m.comments_count;
  return reel;
}

async function fetchReels(env, key, fetchFn) {
  const { account, notes } = await findAccount(env, key, fetchFn);
  if (!account) throw new Error('no account: ' + notes.join('; '));
  const data = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(account.id) + '/media', key, { fields: FIELDS, limit: '50' })), 'media');
  const media = (Array.isArray(data.data) ? data.data : []).filter((m) => toReel(m)).slice(0, MAX_REELS);
  await addShares(env, key, fetchFn, media);
  return media.map(toReel);
}

// shares aren't a plain field: they're an insight, which needs instagram_manage_insights on the key. without it the
// first ask fails and the rest are skipped, so the reels still come back, just without a share count
async function shareCount(env, key, fetchFn, id) {
  const d = await metaJson(await fetchFn(await keyedUrl(env, '/' + encodeURIComponent(id) + '/insights', key, { metric: 'shares' })), 'shares');
  const row = (Array.isArray(d.data) ? d.data : []).find((x) => x && x.name === 'shares');
  const v = row && Array.isArray(row.values) && row.values[0] ? row.values[0].value : row && row.total_value ? row.total_value.value : undefined;
  return Number.isInteger(v) ? v : undefined;
}
async function addShares(env, key, fetchFn, media) {
  const wanted = media.filter((m) => Number.isInteger(m.like_count));
  if (!wanted.length) return;
  try { wanted[0].shares = await shareCount(env, key, fetchFn, wanted[0].id); } catch (e) { return; }
  await Promise.all(wanted.slice(1).map(async (m) => {
    try { m.shares = await shareCount(env, key, fetchFn, m.id); } catch (e) {}
  }));
}

export async function reelsRoute(request, env, fetchFn = fetch, now = Date.now()) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);
  // not set up: the page shows its stand-in reels
  const key = accessKey(env);
  if (!key || !env.REEL_STORE) return json({ connected: false, reels: [] }, 200, 'public, max-age=300');

  const saved = await env.REEL_STORE.get(KEY_REELS, 'json');
  if (saved && now - saved.fetched_at < FRESH_MS) return json({ connected: true, reels: saved.reels }, 200, 'public, max-age=300');
  try {
    const reels = await fetchReels(env, key, fetchFn);
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels }));
    return json({ connected: true, reels }, 200, 'public, max-age=300');
  } catch (e) {
    console.log('instagram reels failed', e.message);
    // try again in 10 minutes, not on every visit, and let /admin show what went wrong
    await env.REEL_STORE.put(KEY_REELS, JSON.stringify({ fetched_at: now, reels: saved ? saved.reels : [], last_error: e.message.slice(0, 300) }));
    // Meta is down or the key stopped working: the last saved copy beats an empty page
    if (saved) return json({ connected: true, reels: saved.reels, stale: true }, 200, 'public, max-age=60');
    return json({ error: 'unavailable' }, 502);
  }
}
