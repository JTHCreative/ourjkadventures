// j+k adventures: order history. Square is the register; we only keep a note of which orders a
// signed-in buyer started. Here we ask Square about those orders and keep the ones that were paid.

const SQUARE_VERSION = '2026-09-16'; // keep in step with site/_worker.js

function squareHost(env) {
  return env.SQUARE_ENV === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}

function money(m) { return m && typeof m.amount === 'number' ? { cents: m.amount, currency: m.currency || 'USD' } : null; }

// Square calls it "COMPLETED" once you mark an order done in the dashboard
function status(order) {
  if (order.state === 'CANCELED') return 'canceled';
  if (order.state === 'COMPLETED') return 'complete';
  return 'paid';
}

export async function paidOrders(env, uid, orderIds, fetchFn = fetch) {
  if (!orderIds.length) return [];
  if (!env.SQUARE_ACCESS_TOKEN || !env.SQUARE_LOCATION_ID) throw new Error('square not configured');
  const out = [];
  for (let i = 0; i < orderIds.length; i += 100) {
    const res = await fetchFn(squareHost(env) + '/v2/orders/batch-retrieve', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN, 'Square-Version': SQUARE_VERSION, 'Content-Type': 'application/json' },
      body: JSON.stringify({ location_id: env.SQUARE_LOCATION_ID, order_ids: orderIds.slice(i, i + 100) })
    });
    if (!res.ok) throw new Error('square orders ' + res.status);
    const body = await res.json();
    for (const o of body.orders || []) {
      // only this person's orders, and only ones that were paid (checkouts left half way have no tenders)
      if (!o.metadata || o.metadata.uid !== uid) continue;
      if (!(o.tenders && o.tenders.length)) continue;
      out.push({
        id: o.id,
        number: (o.id || '').slice(-6).toUpperCase(),
        date: o.closed_at || o.updated_at || o.created_at,
        status: status(o),
        items: (o.line_items || []).map((l) => ({ name: l.name, qty: Number(l.quantity) || 1 })),
        total: money(o.total_money)
      });
    }
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return out;
}
