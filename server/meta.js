// j+k adventures: Meta's Conversions API, the server's side of the Meta Pixel (docs/setup/meta-pixel.md).
//
// The Pixel (site/assets/pixel.js) is the browser telling Meta "someone looked at the corgi". This is our own
// server saying the same thing, like the till's record beside the clipboard at the door: an ad blocker or a closed
// tab can lose the browser's word, never the till's. Both carry the same ticket number (event_id), so Meta counts
// an event it hears twice only once.
//
//   POST /api/meta-event   the browser's ViewContent, AddToCart and InitiateCheckout, passed on
//   purchaseEvent()        Purchase, made by /api/checkout/pay the moment the card is charged (server/checkout.js)
//
// Only ever after a yes on the cookie note: the browser calls /api/meta-event only then, and the checkout page
// sends meta.consent only then. Prices are looked up here, never taken from the browser. The buyer's email goes to
// Meta scrambled (SHA-256), as Meta's rules ask; nothing else about them is sent but what any website sees (the
// connection's address and the browser's name) and Meta's own cookie values.
//
// Cloudflare settings:
//   META_CAPI_TOKEN        secret. Events Manager > the pixel > settings > conversions api > generate access token.
//                          without it nothing is sent from the server, and the browser's Pixel still works alone
//   META_TEST_EVENT_CODE   optional, only while testing: the code on Events Manager's "test events" tab, so the
//                          server's events show up there. remove it when done
// The pixel's number is in site/assets/pixel-id.js (not secret, and the browser needs it too).

import { META_PIXEL_ID } from '../site/assets/pixel-id.js';
import { getCatalog } from './catalog.js';
import { fromOurSite } from './same-site.js';

const GRAPH = 'https://graph.facebook.com/v26.0';
const BROWSER_EVENTS = ['ViewContent', 'AddToCart', 'InitiateCheckout'];
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
const KEY_RE = /^[a-z0-9-]{1,40}(:[a-z]{1,10})?$/;
const COOKIE_RE = /^fb\.\d\.\d{6,20}\.[A-Za-z0-9._-]{1,300}$/;
const PATH_RE = /^\/[A-Za-z0-9/._-]{0,120}$/;
const MAX_ITEMS = 30;
const MAX_QTY = 20;
// at most this many passed-on events a minute from one connection. kept in this worker's own memory, so it's a
// speed bump, not a wall: enough to stop one page stuck in a loop
const PER_MINUTE = 60;
let seen = new Map();

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function metaConfigured(env) { return !!(env && env.META_CAPI_TOKEN); }

// Meta's rule for an email: trimmed, lowercase, then SHA-256 as hex. can't be turned back into the address
export async function hashEmail(email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean) return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clean));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

// which browser this is, as far as Meta is told: what any website sees, plus Meta's own cookie values
async function userData(request, who) {
  const u = {};
  const ip = request.headers.get('CF-Connecting-IP');
  const agent = request.headers.get('User-Agent');
  if (ip) u.client_ip_address = ip;
  if (agent) u.client_user_agent = agent.slice(0, 500);
  if (who && typeof who.fbp === 'string' && COOKIE_RE.test(who.fbp)) u.fbp = who.fbp;
  if (who && typeof who.fbc === 'string' && COOKIE_RE.test(who.fbc)) u.fbc = who.fbc;
  const em = who && who.email ? await hashEmail(who.email) : '';
  if (em) u.em = [em];
  return u;
}

// the products in an event, priced from our own catalog. lines: [{ key, qty }]
export function productData(catalog, lines) {
  const out = { content_type: 'product', content_ids: [], contents: [] };
  let cents = 0, priced = lines.length > 0, count = 0;
  for (const l of lines) {
    const entry = catalog.byKey[l.key];
    const c = { id: l.key, quantity: l.qty };
    if (entry && Number.isInteger(entry.price_cents)) { c.item_price = entry.price_cents / 100; cents += entry.price_cents * l.qty; } else priced = false;
    out.content_ids.push(l.key);
    out.contents.push(c);
    count += l.qty;
  }
  if (lines.length === 1) {
    const slug = lines[0].key.split(':')[0];
    const p = (catalog.items || []).find((x) => x.slug === slug);
    if (p && p.name) out.content_name = p.name;
  }
  if (lines.length > 1 || count > 1) out.num_items = count;
  if (priced) { out.value = cents / 100; out.currency = (catalog.currency || 'USD'); }
  return out;
}

// sends events to Meta. { sent } or { skipped }. never throws: an ad report must not get in the way of the shop
export async function sendEvents(env, events, fetchFn = fetch) {
  if (!metaConfigured(env)) return { skipped: 'not set up' };
  if (!events.length) return { skipped: 'nothing' };
  try {
    const body = { data: events, access_token: env.META_CAPI_TOKEN };
    if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;
    const res = await fetchFn(GRAPH + '/' + META_PIXEL_ID + '/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      let why = '';
      try { const j = await res.json(); why = (j && j.error && j.error.message) || ''; } catch (e) {}
      console.log('meta events error', res.status, why);
      return { skipped: 'meta said no' };
    }
    return { sent: events.length };
  } catch (e) {
    console.log('meta events failed', e.message);
    return { skipped: 'failed' };
  }
}

// lets the answer go back to the browser first, where Cloudflare offers that (ctx.waitUntil); otherwise waits
function later(ctx, work) {
  if (ctx && typeof ctx.waitUntil === 'function') { ctx.waitUntil(work); return Promise.resolve(); }
  return work.then(() => {}, () => {});
}

/* ---------- a paid order (called by server/checkout.js) ---------- */
// what the thank-you page's Pixel event and ours both say. totalCents: what was paid for the order (items, shipping
// and tax, no tip), as Square worked it out
export function purchaseDetails(catalog, lines, orderId, totalCents, currency) {
  const d = productData(catalog, lines);
  return {
    event_id: 'purchase-' + orderId, value: totalCents / 100, currency: currency || 'USD',
    content_ids: d.content_ids, contents: d.contents, num_items: lines.reduce((n, l) => n + l.qty, 0)
  };
}

// consent: the checkout page's { consent: true, fbp, fbc }, sent only after a yes on the cookie note
export async function purchaseEvent(env, request, ctx, { consent, details, orderId, email, origin }, fetchFn = fetch) {
  if (!metaConfigured(env) || !consent || consent.consent !== true) return;
  const { event_id, ...custom } = details;
  const event = {
    event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000), event_id, action_source: 'website',
    event_source_url: origin + '/checkout',
    user_data: await userData(request, { fbp: consent.fbp, fbc: consent.fbc, email }),
    custom_data: { ...custom, content_type: 'product', order_id: orderId }
  };
  await later(ctx, sendEvents(env, [event], fetchFn));
}

/* ---------- /api/meta-event ---------- */
function tooMany(ip) {
  const now = Date.now();
  if (seen.size > 5000) seen = new Map();
  const s = seen.get(ip);
  if (!s || s.until < now) { seen.set(ip, { n: 1, until: now + 60000 }); return false; }
  s.n += 1;
  return s.n > PER_MINUTE;
}

export async function metaEventRoute(request, env, ctx, fetchFn = fetch) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!fromOurSite(request)) return json({ error: 'forbidden' }, 403);
  let body;
  try { body = JSON.parse((await request.text()).slice(0, 8000)); } catch (e) { return json({ error: 'bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad request' }, 400);
  if (!BROWSER_EVENTS.includes(body.name)) return json({ error: 'bad event' }, 400);
  if (typeof body.event_id !== 'string' || !ID_RE.test(body.event_id)) return json({ error: 'bad event' }, 400);
  const raw = Array.isArray(body.items) ? body.items : [];
  if (!raw.length || raw.length > MAX_ITEMS) return json({ error: 'bad items' }, 400);
  const lines = [];
  for (const it of raw) {
    if (!it || typeof it.key !== 'string' || !KEY_RE.test(it.key)) return json({ error: 'bad items' }, 400);
    const qty = Number.isInteger(it.qty) && it.qty > 0 ? Math.min(it.qty, MAX_QTY) : 1;
    lines.push({ key: it.key, qty });
  }
  if (!metaConfigured(env)) return json({ ok: true, skipped: true });
  if (tooMany(request.headers.get('CF-Connecting-IP') || 'unknown')) return json({ error: 'slow down' }, 429);

  let catalog;
  try { catalog = await getCatalog(env, request.url, fetchFn); } catch (e) { return json({ ok: true, skipped: true }); }
  // only our own products: a key we sell, or the page of a product that isn't in the shop yet
  const slugs = new Set((catalog.items || []).map((p) => p.slug));
  if (!lines.every((l) => catalog.byKey[l.key] || slugs.has(l.key))) return json({ error: 'bad items' }, 400);

  const path = typeof body.path === 'string' && PATH_RE.test(body.path) ? body.path : '/';
  const event = {
    event_name: body.name, event_time: Math.floor(Date.now() / 1000), event_id: body.event_id, action_source: 'website',
    event_source_url: new URL(request.url).origin + path,
    user_data: await userData(request, { fbp: body.fbp, fbc: body.fbc }),
    custom_data: productData(catalog, lines)
  };
  await later(ctx, sendEvents(env, [event], fetchFn));
  return json({ ok: true });
}

// for tests
export function _resetMetaLimit() { seen = new Map(); }
