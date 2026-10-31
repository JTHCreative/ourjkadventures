// j+k adventures: the shop's shelf. Three things are put together here:
//   1. products.json   which products the website shows (slug, name, kind, the sizes it can come in)
//   2. Firestore       which Square item each of those is, chosen by the owner on /admin
//                      (settings/square_production, or settings/square_sandbox while testing)
//   3. Square          the price and how many are on the shelf
// The result is kept for a minute, like reading the stock list once a minute instead of on every visit.
//
//   GET /api/catalog   for the website: products, sizes, prices, stock, and whether the shop is open
//
// A pin's standard size has the key "aussie"; its large size "aussie:large". The bag uses these keys.

import { configured, firestoreGet, firestoreSet } from './firebase.js';
import { isShopOpen } from './shop.js';
import { squareConfigured, squareMode, getVariations, stockCounts } from './square.js';

const CACHE_MS = 60 * 1000;
const RETRY_MS = 10 * 1000;
export const SIZES = ['standard', 'large'];

let cache = { value: null, until: 0, mode: null };

export function sizeKey(slug, size) { return size === 'standard' ? slug : slug + ':' + size; }
function linksDoc(env) { return 'settings/square_' + squareMode(env); }

export async function siteProducts(env, origin) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', origin)));
  if (!res.ok) throw new Error('products.json ' + res.status);
  return res.json();
}

// every key the website could sell: [{ key, slug, size, name, kind }]
export function siteKeys(products) {
  const out = [];
  for (const p of products.items || []) {
    const sizes = (Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ['standard']).filter((s) => SIZES.includes(s));
    for (const size of sizes) out.push({ key: sizeKey(p.slug, size), slug: p.slug, size, name: p.name, kind: p.kind });
  }
  return out;
}

export async function readLinks(env, fetchFn = fetch) {
  const doc = (await firestoreGet(env, linksDoc(env), fetchFn)) || {};
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

export async function saveLinks(env, links, fetchFn = fetch) {
  await firestoreSet(env, linksDoc(env), links, fetchFn);
  cache = { value: null, until: 0, mode: null };
}

async function build(env, origin, fetchFn) {
  const products = await siteProducts(env, origin);
  const open = await isShopOpen(env, fetchFn);
  let links = {};
  let variations = {};
  let counts = {};
  let ok = true;
  try {
    if (configured(env)) links = await readLinks(env, fetchFn);
    const ids = [...new Set(Object.values(links))];
    if (ids.length && squareConfigured(env)) {
      variations = await getVariations(env, ids, fetchFn);
      counts = await stockCounts(env, Object.keys(variations), fetchFn);
    }
  } catch (e) {
    // Square or Firestore is resting: the shelf shows everything as sold out until it answers again
    console.log('catalog: ' + e.message);
    ok = false;
    links = {};
  }

  const byKey = {};
  const items = (products.items || []).map((p) => {
    const sizes = [];
    for (const k of siteKeys({ items: [p] })) {
      const v = variations[links[k.key]];
      if (!v || !v.sellable || v.price_cents === null) continue;
      const stock = v.marked_sold_out ? 0 : (counts[v.id] || 0);
      byKey[k.key] = { variation_id: v.id, price_cents: v.price_cents, currency: v.currency, stock, marked_sold_out: v.marked_sold_out, slug: p.slug, size: k.size };
      sizes.push({ size: k.size, key: k.key, price_cents: v.price_cents, stock });
    }
    return { slug: p.slug, name: p.name, kind: p.kind, description: p.description || '', sizes };
  });

  return {
    ok,
    value: {
      open,
      currency: products.currency || 'USD',
      shipping_cents: products.shipping_cents || 0,
      shipping_label: products.shipping_label || 'shipping',
      items,
      byKey
    }
  };
}

export async function getCatalog(env, origin, fetchFn = fetch) {
  const mode = squareMode(env);
  if (cache.value && cache.until > Date.now() && cache.mode === mode) {
    // the open sign has its own one-minute memory, and the admin page resets it at once
    return { ...cache.value, open: await isShopOpen(env, fetchFn) };
  }
  const { ok, value } = await build(env, origin, fetchFn);
  cache = { value, until: Date.now() + (ok ? CACHE_MS : RETRY_MS), mode };
  return value;
}

// what the browser gets: no Square ids, and no stock numbers while the shop is closed
export function publicCatalog(c) {
  return {
    open: c.open,
    currency: c.currency,
    items: c.items.map((p) => ({
      ...p,
      sizes: p.sizes.map((s) => ({ size: s.size, key: s.key, price_cents: s.price_cents, stock: c.open ? s.stock : 0 }))
    }))
  };
}

export async function catalogRoute(request, env, fetchFn = fetch) {
  if (request.method !== 'GET') return new Response('{"error":"method"}', { status: 405 });
  try {
    const c = await getCatalog(env, request.url, fetchFn);
    return new Response(JSON.stringify(publicCatalog(c)), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    console.log('catalog error', e.message);
    return new Response('{"error":"unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// for tests
export function _resetCatalogCache() { cache = { value: null, until: 0, mode: null }; }
