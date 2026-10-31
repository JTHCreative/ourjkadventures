// j+k adventures: serves the static site, the catalog (Square prices and stock), Square checkout links,
// accounts, reviews and the owner's /admin.
// Secrets live in Cloudflare (Settings > Variables and secrets), never in the page:
//   SQUARE_ACCESS_TOKEN  (secret)  your Square access token
//   SQUARE_LOCATION_ID             the Square location that takes the sale
//   SQUARE_ENV                     "sandbox" while testing, "production" when live
//   TAX_PERCENT  (optional)        e.g. "9.25". leave empty for no tax line
//   SUPPORT_EMAIL (optional)       shown to buyers on the Square checkout page
//   FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT  accounts, see server/firebase.js
//   ADMIN_EMAILS                   who may use /admin, see server/admin.js
//
// The account code lives in ../server so it is bundled into this worker but never published as a file.

import { account, noteOrder } from '../server/account.js';
import { reviews } from '../server/reviews.js';
import { configured as firebaseConfigured, userFromRequest } from '../server/firebase.js';
import { admin } from '../server/admin.js';
import { getCatalog, catalogRoute } from '../server/catalog.js';
import { stockCounts, squareHost, SQUARE_VERSION } from '../server/square.js';

const MAX_LINES = 30;
const MAX_QTY = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/checkout') return checkout(request, env, url);
    if (url.pathname === '/api/catalog') return catalogRoute(request, env);
    if (url.pathname === '/api/account' || url.pathname === '/api/account/orders') return account(request, env);
    if (url.pathname === '/api/reviews') return reviews(request, env);
    if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) return admin(request, env);
    return env.ASSETS.fetch(request);
  }
};

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function checkout(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) return json({ error: 'not configured' }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad request' }, 400); }
  const wanted = Array.isArray(body && body.items) ? body.items : [];
  if (!wanted.length || wanted.length > MAX_LINES) return json({ error: 'bad items' }, 400);

  // the browser sends only keys ("aussie", "aussie:large") and how many. which Square item that is,
  // and its price, come from our own catalog (server/catalog.js), never from the browser
  let catalog;
  try { catalog = await getCatalog(env, url); } catch (e) { return json({ error: 'catalog' }, 500); }
  // the open sign (settings/shop in Firestore, flipped on /admin). closed, or unreadable, means nobody checks out
  if (!catalog.open) return json({ error: 'shop closed' }, 403);

  const qtyByKey = {};
  for (const w of wanted) {
    const key = w && w.key;
    const qty = Math.floor(Number(w && w.qty));
    if (typeof key !== 'string' || !catalog.byKey[key] || !(qty >= 1) || qty > MAX_QTY) return json({ error: 'bad item' }, 400);
    qtyByKey[key] = (qtyByKey[key] || 0) + qty;
    if (qtyByKey[key] > MAX_QTY) return json({ error: 'bad item' }, 400);
  }

  // a fresh look at the shelf, not the one-minute-old list, so we never sell what the booth just sold
  const keys = Object.keys(qtyByKey);
  let onShelf;
  try { onShelf = await stockCounts(env, keys.map((k) => catalog.byKey[k].variation_id)); } catch (e) {
    console.log('stock check failed', e.message);
    return json({ error: 'square unreachable' }, 502);
  }
  // the "sold out" tick in the Square dashboard counts as none on the shelf
  const left = (k) => (catalog.byKey[k].marked_sold_out ? 0 : onShelf[catalog.byKey[k].variation_id] || 0);
  const short = keys.filter((k) => qtyByKey[k] > left(k));
  if (short.length) return json({ error: 'stock', items: short.map((k) => ({ key: k, stock: left(k) })) }, 409);

  // pointing at the Square item (not typing a name and price) is what lets Square lower the stock count
  const lines = keys.map((k) => ({ catalog_object_id: catalog.byKey[k].variation_id, quantity: String(qtyByKey[k]) }));
  const currency = catalog.currency;

  const order = { location_id: env.SQUARE_LOCATION_ID, line_items: lines };

  // a signed-in buyer: tag the order with their account so the Collector's Path can find it later,
  // and fill in their email on Square's page. A missing or bad ticket just means a signed-out checkout.
  let buyer = null;
  if (firebaseConfigured(env)) {
    try { buyer = await userFromRequest(request, env); } catch (e) { buyer = null; }
  }
  if (buyer) order.metadata = { uid: buyer.sub };
  const tax = Number(env.TAX_PERCENT);
  if (tax > 0) order.taxes = [{ uid: 'sales-tax', name: 'sales tax', percentage: String(tax), scope: 'ORDER' }];

  const options = {
    redirect_url: url.origin + '/thank-you.html',
    ask_for_shipping_address: true
  };
  if (catalog.shipping_cents > 0) {
    options.shipping_fee = {
      name: catalog.shipping_label || 'shipping',
      charge: { amount: catalog.shipping_cents, currency: currency }
    };
  }
  if (env.SUPPORT_EMAIL) options.merchant_support_email = env.SUPPORT_EMAIL;
  const prefill = buyer && buyer.email ? { buyer_email: buyer.email } : null;

  let res;
  try {
    res = await fetch(squareHost(env) + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.SQUARE_ACCESS_TOKEN,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: order,
        checkout_options: options,
        ...(prefill ? { pre_populated_data: prefill } : {})
      })
    });
  } catch (e) {
    return json({ error: 'square unreachable' }, 502);
  }
  const data = await res.json().catch(() => ({}));
  const link = data && data.payment_link;
  const target = link && (link.url || link.long_url);
  if (!res.ok || !target) {
    console.log('square error', res.status, JSON.stringify(data && data.errors));
    return json({ error: 'square' }, 502);
  }
  // remember that this signed-in buyer started this order, for their order history.
  // never blocks checkout: a missed note only means the order won't be listed.
  if (buyer && link.order_id) {
    try { await noteOrder(env, buyer.sub, link.order_id); } catch (e) { console.log('order note failed', e.message); }
  }
  return json({ url: target });
}
