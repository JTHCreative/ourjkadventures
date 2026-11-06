// j+k adventures: our products in Google Merchant Center (Google Shopping, the Shopping tab, Google Images).
// Like keeping a shop window on Google's street: every 10 minutes the worker walks our own shelf list (the same
// catalog /api/catalog shows: products.json for the words, Square for prices and stock) and tells Google only what
// changed. Nothing is typed twice, and prices still only ever come from Square. Owner steps:
// docs/setup/merchant-center.md. Why it works this way: docs/decisions.md.
//
// The rules, the same as the shop's:
//   - fails closed: shop closed, or a size with none on the shelf, is "out of stock" on Google. A product that is
//     switched off on /admin, or not linked to Square, is taken out of the window. If Square or Firestore can't be
//     read, everything already on Google is marked out of stock until they answer again
//   - only the real shop: nothing is sent while Square is in sandbox mode, so test prices never reach Google
//   - no discounts, ever: no sale price or minimum price is ever sent (docs/pricing-and-loyalty.md)
//
// Cloudflare settings:
//   MERCHANT_ACCOUNT_ID       plain, the Merchant Center account number (top right in Merchant Center)
//   MERCHANT_DATA_SOURCE      optional, plain, the number of an "API" product source made in Merchant Center by hand.
//                             left out, the worker finds or makes its own, called "website (ourjkadventures.com)"
//   FIREBASE_SERVICE_ACCOUNT  the same server key Firebase uses (server/firebase.js), added as a user in
//                             Merchant Center
// What was last sent is kept in Firestore, settings/merchant, so each run only sends what changed.

import { configured, googleToken, firestoreGet, firestoreSet } from './firebase.js';
import { freshCatalog, siteProducts, siteKeys } from './catalog.js';
import { squareMode } from './square.js';
import { SITE, pupLabel, pupPath } from './pup-pages.js';

const API = 'https://merchantapi.googleapis.com';
const SCOPE = 'https://www.googleapis.com/auth/content';
const STATE_DOC = 'settings/merchant';
const LANGUAGE = 'en';
const FEED_LABEL = 'US';
const COUNTRY = 'US';
const SOURCE_NAME = 'website (ourjkadventures.com)';
const BRAND = 'j+k adventures';
// Google drops a product it hasn't heard about for 30 days, so everything is sent again once a week even if unchanged
const RESEND_MS = 7 * 24 * 60 * 60 * 1000;
const PIN_CATEGORY = 'Apparel & Accessories > Jewelry > Brooches & Lapel Pins';
const SERIES_NAMES = { 'pup-club': 'pup club', hometown: 'hometown series', zodiac: 'chinese zodiac' };
// products that have a page of their own but aren't pup club pins. a product with no page isn't sent:
// Google needs somewhere to send people
const PAGES = { 'bay-area-pin-board': '/bay-area-pin-board' };

export function merchantAccount(env) {
  const id = String(env.MERCHANT_ACCOUNT_ID || '').trim();
  return /^\d+$/.test(id) ? id : '';
}
export function merchantConfigured(env) { return !!(merchantAccount(env) && configured(env)); }
// the only time anything goes to Google: set up, and Square in production mode
export function merchantLive(env) { return merchantConfigured(env) && squareMode(env) === 'production'; }

// "aussie" and "aussie:large" become offer ids "aussie" and "aussie-large" (Google's ids keep to letters, numbers, dashes)
export function offerId(key) { return key.replace(/:/g, '-'); }

export function productPage(p) {
  if (p.kind === 'pin' && p.series === 'pup-club') return pupPath(p.slug);
  return PAGES[p.slug] || null;
}

function micros(cents) { return String(cents * 10000); }

function title(p, size, grouped) {
  const base = p.kind === 'pin' && p.series === 'pup-club' ? pupLabel(p) + ' enamel pin' : p.name;
  return grouped ? base + ', ' + size + ' size' : base;
}

// what Google gets for each product and size: { "aussie": { offerId, contentLanguage, feedLabel, productAttributes } }
// built only from the catalog (server/catalog.js), so it says exactly what the shop says
export function merchantProducts(catalog, products) {
  const bySlug = Object.fromEntries((products.items || []).map((p) => [p.slug, p]));
  const currency = catalog.currency || 'USD';
  const shipping = [{ country: COUNTRY, price: { amountMicros: micros(catalog.shipping_cents || 0), currencyCode: currency } }];
  const out = {};
  for (const item of catalog.items || []) {
    const p = bySlug[item.slug];
    const page = p && productPage(p);
    if (!p || !page || !item.available) continue;
    const sizes = (item.sizes || []).filter((s) => Number.isInteger(s.price_cents) && s.price_cents > 0);
    // grouped when the product comes in more than one size on the website, even if only one is linked right now
    const grouped = siteKeys({ items: [p] }).length > 1;
    for (const s of sizes) {
      const id = offerId(s.key);
      const attrs = {
        title: title(p, s.size, grouped),
        description: p.summary || p.description || p.about || title(p, s.size, grouped),
        link: SITE + page,
        imageLink: SITE + '/assets/img/merchant/' + p.slug + '.jpg',
        availability: catalog.open === true && s.stock > 0 ? 'IN_STOCK' : 'OUT_OF_STOCK',
        condition: 'NEW',
        price: { amountMicros: micros(s.price_cents), currencyCode: currency },
        brand: BRAND,
        // handmade in small runs: no barcode (GTIN) or maker's part number to give
        identifierExists: false,
        productTypes: [p.kind === 'pin' ? 'pins > ' + (SERIES_NAMES[p.series] || 'pins') : 'pin boards'],
        shipping
      };
      if (p.kind === 'pin') attrs.googleProductCategory = PIN_CATEGORY;
      if (grouped) { attrs.itemGroupId = p.slug; attrs.size = s.size; }
      out[id] = { offerId: id, contentLanguage: LANGUAGE, feedLabel: FEED_LABEL, productAttributes: attrs };
    }
  }
  return out;
}

/* ---------- talking to Google ---------- */
async function call(env, method, path, body, fetchFn) {
  const token = await googleToken(env, SCOPE, fetchFn);
  const res = await fetchFn(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const msg = data && data.error && data.error.message ? ' ' + String(data.error.message).slice(0, 300) : '';
    const err = new Error('merchant ' + method + ' ' + res.status + msg);
    err.status = res.status;
    throw err;
  }
  return data || {};
}

const accountPath = (env) => '/accounts/' + merchantAccount(env);

// the product list our worker writes into. Merchant Center calls it a "data source"
async function dataSource(env, state, fetchFn) {
  const own = String(env.MERCHANT_DATA_SOURCE || '').trim();
  if (/^\d+$/.test(own)) return 'accounts/' + merchantAccount(env) + '/dataSources/' + own;
  if (state.dataSource) return state.dataSource;
  const list = await call(env, 'GET', '/datasources/v1' + accountPath(env) + '/dataSources?pageSize=100', null, fetchFn);
  const found = (list.dataSources || []).find((d) => d.displayName === SOURCE_NAME && d.primaryProductDataSource);
  if (found) return found.name;
  const made = await call(env, 'POST', '/datasources/v1' + accountPath(env) + '/dataSources', {
    displayName: SOURCE_NAME,
    primaryProductDataSource: { contentLanguage: LANGUAGE, feedLabel: FEED_LABEL, countries: [COUNTRY] }
  }, fetchFn);
  if (!made.name) throw new Error('merchant data source not made');
  return made.name;
}

async function sendOne(env, source, product, fetchFn) {
  await call(env, 'POST', '/products/v1' + accountPath(env) + '/productInputs:insert?dataSource=' + encodeURIComponent(source), product, fetchFn);
}

async function removeOne(env, source, id, fetchFn) {
  const name = encodeURIComponent(LANGUAGE + '~' + FEED_LABEL + '~' + id);
  try {
    await call(env, 'DELETE', '/products/v1' + accountPath(env) + '/productInputs/' + name + '?dataSource=' + encodeURIComponent(source), null, fetchFn);
  } catch (e) {
    if (e.status !== 404) throw e; // already gone is what we wanted
  }
}

/* ---------- the walk round the shelf ---------- */
async function readState(env, fetchFn) {
  const doc = (await firestoreGet(env, STATE_DOC, fetchFn)) || {};
  let sent = {};
  try { sent = JSON.parse(doc.sent || '{}') || {}; } catch (e) { sent = {}; }
  return { ...doc, sent };
}

// one run: compare what Google should show with what we last sent, and send only the difference.
// force sends everything again (the "send to google now" button on /admin)
export async function syncMerchant(env, { force = false, origin = SITE, fetchFn = fetch } = {}) {
  if (!merchantConfigured(env)) return { skipped: 'not configured' };
  if (squareMode(env) !== 'production') return { skipped: 'sandbox' };

  const state = await readState(env, fetchFn);
  const started = new Date();
  const errors = [];
  let wanted;
  let shelfOk = true;
  try {
    const { ok, value } = await freshCatalog(env, origin, fetchFn);
    if (!ok) throw new Error('square or firestore did not answer');
    wanted = merchantProducts(value, await siteProducts(env, origin));
  } catch (e) {
    // can't see the shelf: everything on Google goes out of stock, nothing is taken down
    shelfOk = false;
    errors.push('shelf: ' + e.message);
    wanted = {};
    for (const [id, was] of Object.entries(state.sent)) {
      wanted[id] = { ...was, productAttributes: { ...was.productAttributes, availability: 'OUT_OF_STOCK' } };
    }
  }

  const full = force || !state.fullAt || Date.now() - Date.parse(state.fullAt) > RESEND_MS;
  const sent = { ...state.sent };
  let source = null;
  let changed = 0;
  let removed = 0;
  try {
    source = await dataSource(env, state, fetchFn);
    for (const [id, product] of Object.entries(wanted)) {
      if (!full && sent[id] && JSON.stringify(sent[id]) === JSON.stringify(product)) continue;
      try { await sendOne(env, source, product, fetchFn); sent[id] = product; changed++; } catch (e) { errors.push(id + ': ' + e.message); }
    }
    if (shelfOk) {
      for (const id of Object.keys(sent)) {
        if (wanted[id]) continue;
        try { await removeOne(env, source, id, fetchFn); delete sent[id]; removed++; } catch (e) { errors.push(id + ': ' + e.message); }
      }
    }
  } catch (e) {
    errors.push(e.message);
  }

  const fullDone = full && source && !errors.length;
  const result = {
    lastRun: started,
    lastError: errors.slice(0, 5).join(' | '),
    lastChanged: changed,
    lastRemoved: removed,
    listed: Object.keys(sent).length
  };
  await firestoreSet(env, STATE_DOC, {
    ...result,
    dataSource: source || state.dataSource || '',
    fullAt: fullDone ? started : state.fullAt || '',
    sent: JSON.stringify(sent)
  }, fetchFn);
  if (errors.length) console.log('merchant: ' + result.lastError);
  return { ...result, lastRun: started.toISOString() };
}

/* ---------- for the owner's page ---------- */
// what we last sent, when, and what Google says about each product (approved, waiting, or a problem to fix)
export async function merchantStatus(env, fetchFn = fetch) {
  const base = { configured: merchantConfigured(env), live: merchantLive(env), mode: squareMode(env), account: merchantAccount(env) };
  if (!base.configured) return base;
  const state = await readState(env, fetchFn);
  const out = {
    ...base,
    lastRun: state.lastRun || null,
    lastError: state.lastError || '',
    listed: Object.keys(state.sent).length,
    products: Object.values(state.sent).map((p) => ({
      offerId: p.offerId,
      title: p.productAttributes.title,
      availability: p.productAttributes.availability,
      price_cents: Math.round(Number(p.productAttributes.price.amountMicros) / 10000)
    }))
  };
  // Google's side: only worth asking once something has been sent. a failure here never hides our own side
  if (!out.listed) return out;
  try {
    const seen = {};
    const list = await call(env, 'GET', '/products/v1' + accountPath(env) + '/products?pageSize=250', null, fetchFn);
    for (const g of list.products || []) {
      const st = g.productStatus || {};
      const dest = st.destinationStatuses || [];
      seen[g.offerId] = {
        approved: dest.some((d) => (d.approvedCountries || []).length),
        pending: dest.some((d) => (d.pendingCountries || []).length),
        disapproved: dest.some((d) => (d.disapprovedCountries || []).length),
        issues: (st.itemLevelIssues || []).filter((i) => i.severity !== 'NOT_IMPACTED')
          .map((i) => ({ severity: i.severity, description: i.description || i.code || '', detail: i.detail || '', resolution: i.resolution || '' }))
      };
    }
    out.products = out.products.map((p) => ({ ...p, google: seen[p.offerId] || null }));
  } catch (e) {
    out.googleError = e.message;
  }
  return out;
}

// the one-time handshake Google asks for: link our Google Cloud project (the one the server key lives in) to the
// Merchant Center account. the owner's email gets Google's notes about the API
export async function registerMerchant(env, ownerEmail, fetchFn = fetch) {
  return call(env, 'POST', '/accounts/v1' + accountPath(env) + '/developerRegistration:registerGcp',
    ownerEmail ? { developerEmail: ownerEmail } : {}, fetchFn);
}
