// j+k adventures: serves the static site and creates Square checkout links.
// Secrets live in Cloudflare (Settings > Variables and secrets), never in the page:
//   SQUARE_ACCESS_TOKEN  (secret)  your Square access token
//   SQUARE_LOCATION_ID             the Square location that takes the sale
//   SQUARE_ENV                     "sandbox" while testing, "production" when live
//   TAX_PERCENT  (optional)        e.g. "9.25". leave empty for no tax line
//   SUPPORT_EMAIL (optional)       shown to buyers on the Square checkout page

const SQUARE_VERSION = '2026-09-16';
const MAX_LINES = 30;
const MAX_QTY = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/checkout') return checkout(request, env, url);
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

  // prices come from products.json on the server, never from the browser
  const catRes = await env.ASSETS.fetch(new Request(new URL('/products.json', url)));
  if (!catRes.ok) return json({ error: 'catalog' }, 500);
  const catalog = await catRes.json();
  const bySlug = {};
  (catalog.items || []).forEach((p) => { bySlug[p.slug] = p; });
  const currency = catalog.currency || 'USD';

  const lines = [];
  for (const w of wanted) {
    const p = bySlug[w && w.slug];
    const qty = Math.floor(Number(w && w.qty));
    if (!p || p.sold_out || !(qty >= 1) || qty > MAX_QTY) return json({ error: 'bad item' }, 400);
    const label = (p.slug === 'golden' ? 'goldie' : p.name) + (p.kind === 'board' ? '' : ' pin');
    lines.push({
      name: label,
      quantity: String(qty),
      base_price_money: { amount: p.price_cents, currency: currency }
    });
  }

  const order = { location_id: env.SQUARE_LOCATION_ID, line_items: lines };
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

  const host = env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
  let res;
  try {
    res = await fetch(host + '/v2/online-checkout/payment-links', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + env.SQUARE_ACCESS_TOKEN,
        'Square-Version': SQUARE_VERSION,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        idempotency_key: crypto.randomUUID(),
        order: order,
        checkout_options: options
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
  return json({ url: target });
}
