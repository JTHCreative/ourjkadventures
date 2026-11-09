// j+k adventures: the shop's shelf. Three things are put together here:
//   1. products.json   which products the website shows (slug, name, kind, the sizes it can come in)
//   2. Firestore       which Square item each of those is, chosen by the owner on /admin
//                      (settings/square_production, or settings/square_sandbox while testing)
//   3. Square          the price and how many are on the shelf
//   4. Firestore again whether the owner marked each product available (server/interest.js). One that isn't is
//                      never for sale here; it carries its "i'm interested" tally instead. One on pre-order (being
//                      made) is never for sale either, and shows no tally: only "email me when it's here"
// The result is kept for a minute, like reading the stock list once a minute instead of on every visit.
//
//   GET /api/catalog   for the website: products, sizes, prices, stock, whether the shop is open, and which
//                      products the owner put in the featured carousel (only ones in stock, at most eight)
//
// A pin's standard size has the key "aussie"; its large size "aussie:large". The bag uses these keys.

import { configured, firestoreGet, firestoreSet } from './firebase.js';
import { isShopOpen } from './shop.js';
import { squareConfigured, squareMode, getVariations, stockCounts } from './square.js';
import { readShopStates, isAvailable, isPreorder, readTallies } from './interest.js';
import { preorderDateFor } from './preorder-words.js';
import { emailConfigured } from './email.js';
import { stateList, GIFT_MAX } from './ship-to.js';

const CACHE_MS = 60 * 1000;
const RETRY_MS = 10 * 1000;
export const SIZES = ['standard', 'large'];
export const MAX_FEATURED = 8;

let cache = { value: null, until: 0, mode: null };

export function sizeKey(slug, size) { return size === 'standard' ? slug : slug + ':' + size; }
function linksDoc(env) { return 'settings/square_' + squareMode(env); }
// the featured picks follow the Square mode too, so practising in the sandbox never changes the real shop
function featuredDoc(env) { return 'settings/featured_' + squareMode(env); }

export async function siteProducts(env, origin) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', origin)));
  if (!res.ok) throw new Error('products.json ' + res.status);
  return res.json();
}

// every key the website could sell: [{ key, slug, size, name, kind, series }]
export function siteKeys(products) {
  const out = [];
  for (const p of products.items || []) {
    const sizes = (Array.isArray(p.sizes) && p.sizes.length ? p.sizes : ['standard']).filter((s) => SIZES.includes(s));
    for (const size of sizes) out.push({ key: sizeKey(p.slug, size), slug: p.slug, size, name: p.name, kind: p.kind, series: p.series || '' });
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

// the owner's featured picks, in the order chosen. Firestore keeps them as one line, "corgi,aussie"
export async function readFeatured(env, fetchFn = fetch) {
  const doc = await firestoreGet(env, featuredDoc(env), fetchFn);
  const slugs = doc && typeof doc.slugs === 'string' ? doc.slugs.split(',').map((x) => x.trim()).filter(Boolean) : [];
  return [...new Set(slugs)];
}

export async function saveFeatured(env, slugs, who, fetchFn = fetch) {
  await firestoreSet(env, featuredDoc(env), { slugs: slugs.join(','), updatedAt: new Date(), updatedBy: who || '' }, fetchFn);
  cache = { value: null, until: 0, mode: null };
}

// how many of a product are on the shelf, all sizes together. a pin on pre-order has none on the shelf yet
export function stockOf(item) {
  if (item.preorder) return 0;
  return (item.sizes || []).reduce((n, s) => n + (s.stock > 0 ? s.stock : 0), 0);
}

// a pre-order isn't limited by the shelf (the pins are being made), only by how many one order may hold.
// the bag and checkout treat this as its "stock"
export const PREORDER_MAX = 20;

async function build(env, origin, fetchFn) {
  const products = await siteProducts(env, origin);
  const open = await isShopOpen(env, fetchFn);
  let links = {};
  let variations = {};
  let counts = {};
  let availability = {};
  let preorder = {};
  let dates = {};
  let ok = true;
  try {
    if (configured(env)) {
      links = await readLinks(env, fetchFn);
      ({ available: availability, preorder, dates } = await readShopStates(env, fetchFn));
    }
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

  // the tallies are only a nice-to-have: if they can't be read, the buttons still work and the counts read 0
  let interest = {};
  let rounds = {};
  if (configured(env)) {
    try {
      for (const [slug, t] of Object.entries(await readTallies(env, fetchFn))) { interest[slug] = t.count; rounds[slug] = t.round; }
    } catch (e) { console.log('interest: ' + e.message); }
  }

  const byKey = {};
  const items = (products.items || []).map((p) => {
    const sizes = [];
    const available = isAvailable(availability, p.slug);
    const onPreorder = isPreorder(preorder, p.slug);
    // a pre-order is only for sale with its date (today or later). without one: "being made now. coming soon."
    const preorderDate = onPreorder ? preorderDateFor(dates[p.slug]) : null;
    // not available: no sizes, no price and nothing in byKey, so checkout can't sell it either.
    // on pre-order with a date: sold at its Square price without looking at the shelf or Square's "sold out" tick (the
    // pins are being made, so Square rightly calls them sold out), and ships around its pre-order date
    for (const k of available || preorderDate ? siteKeys({ items: [p] }) : []) {
      const v = variations[links[k.key]];
      if (!v || !v.sellable || v.price_cents === null) continue;
      const stock = onPreorder ? PREORDER_MAX : v.marked_sold_out ? 0 : (counts[v.id] || 0);
      byKey[k.key] = { variation_id: v.id, price_cents: v.price_cents, currency: v.currency, stock, marked_sold_out: onPreorder ? false : v.marked_sold_out, slug: p.slug, size: k.size, kind: p.kind, ...(onPreorder ? { preorder: true } : {}) };
      sizes.push({ size: k.size, key: k.key, price_cents: v.price_cents, stock, ...(onPreorder ? { preorder: true } : {}) });
    }
    return {
      slug: p.slug, name: p.name, kind: p.kind, series: p.series || '', description: p.description || '', sizes,
      // a pup's breed and its few sentences, shown on the board and on its own page (server/pup-pages.js)
      ...(p.breed ? { breed: p.breed } : {}), ...(p.about ? { about: p.about } : {}),
      available, preorder: onPreorder, interest: available || onPreorder ? 0 : interest[p.slug] || 0,
      // which round of "i'm interested" this is: a browser's remembered vote from an earlier round no longer counts
      interest_round: rounds[p.slug] || 0,
      // when it's expected in stock and shipping, "2026-12-15". only while on pre-order with a date
      ...(preorderDate ? { preorder_date: preorderDate } : {})
    };
  });

  // featured: the owner's picks that are on the shelf right now. a pick that sells out steps out of the carousel
  // and comes back by itself when it's restocked. a missing or unreadable list just means no carousel
  let featured = [];
  if (configured(env)) {
    try { featured = await readFeatured(env, fetchFn); } catch (e) { console.log('featured: ' + e.message); }
  }
  const inStock = new Set(items.filter((p) => stockOf(p) > 0).map((p) => p.slug));
  featured = featured.filter((slug) => inStock.has(slug)).slice(0, MAX_FEATURED);

  return {
    ok,
    value: {
      open,
      currency: products.currency || 'USD',
      shipping: shippingOptions(products),
      items,
      featured,
      byKey
    }
  };
}

// the shipping choices in the bag (ground, priority, express), from products.json. the first is the default.
// the price the customer pays is always this one: the browser only says which choice it wants
export function shippingOptions(products) {
  const list = Array.isArray(products && products.shipping) ? products.shipping : [];
  return list
    .filter((o) => o && typeof o.id === 'string' && Number.isInteger(o.cents) && o.cents >= 0)
    .map((o) => ({
      id: o.id, name: String(o.name || o.id), cents: o.cents, days: String(o.days || ''),
      // free when the pins in the order come to this much or more (ground: $40). boards don't count toward it
      ...(Number.isInteger(o.free_over_cents) && o.free_over_cents > 0 ? { free_over_cents: o.free_over_cents } : {})
    }));
}

// what shipping costs for this order: the choice's price, or nothing when its free line is reached.
// lines: [{ kind, price_cents, qty }] from our own catalog (Square prices), never from the browser.
// counts pins only, and an order with a board in it pays for shipping until the board has its own prices
export function shippingCharge(option, lines) {
  const pins = lines.filter((l) => l.kind === 'pin').reduce((n, l) => n + l.price_cents * l.qty, 0);
  const onlyPins = lines.every((l) => l.kind === 'pin');
  const free = Boolean(option.free_over_cents) && onlyPins && pins >= option.free_over_cents;
  return { cents: free ? 0 : option.cents, free };
}

// a fresh look, skipping the one-minute memory, for the owner's page. ok is false if Square or Firestore didn't answer
export async function freshCatalog(env, origin, fetchFn = fetch) {
  return build(env, origin, fetchFn);
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
    // only slugs, and only ones in stock. shown while the shop is closed too: the carousel is a window display,
    // and each pin's own page still says "coming soon"
    featured: c.featured || [],
    shipping: c.shipping || [],
    items: c.items.map((p) => ({
      ...p,
      sizes: p.sizes.map((s) => ({ size: s.size, key: s.key, price_cents: s.price_cents, stock: c.open ? s.stock : 0, ...(s.preorder ? { preorder: true } : {}) }))
    }))
  };
}

export async function catalogRoute(request, env, fetchFn = fetch) {
  if (request.method !== 'GET') return new Response('{"error":"method"}', { status: 405 });
  try {
    const c = await getCatalog(env, request.url, fetchFn);
    // email: whether "email me when it's here" can be offered (server/notify.js)
    // states: where we ship (u.s. states and d.c.), for the checkout page's address (server/ship-to.js)
    // card: what the checkout page needs for Square's embedded card form (all public, nothing secret), or null
    // while SQUARE_APPLICATION_ID isn't set, and the page sends people to Square's hosted page instead
    return new Response(JSON.stringify({ ...publicCatalog(c), email: emailConfigured(env), states: stateList(), gift_max: GIFT_MAX, card: cardForm(env) }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    console.log('catalog error', e.message);
    return new Response('{"error":"unavailable"}', { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

// Square's Web Payments SDK: the application id and location are public by design (they're in every page that
// uses it); the access token never leaves the server
export function cardForm(env) {
  if (!squareConfigured(env) || !env.SQUARE_APPLICATION_ID) return null;
  const sandbox = squareMode(env) === 'sandbox';
  return {
    app_id: env.SQUARE_APPLICATION_ID,
    location_id: env.SQUARE_LOCATION_ID,
    sdk: sandbox ? 'https://sandbox.web.squarecdn.com/v1/square.js' : 'https://web.squarecdn.com/v1/square.js'
  };
}

// the owner changed something (an available or pre-order switch): read everything fresh on the next visit
export function forgetCatalog() { cache = { value: null, until: 0, mode: null }; }

// a vote just landed: the shop's one-minute memory shows the new tally at once instead of a minute later
export function noteInterest(slug, count) {
  const item = cache.value && cache.value.items.find((p) => p.slug === slug);
  if (item && !item.available && !item.preorder) item.interest = count;
}

// for tests
export function _resetCatalogCache() { cache = { value: null, until: 0, mode: null }; }
