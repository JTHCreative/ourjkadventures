// j+k adventures: reading Square, the register. Square holds the real item list, prices and stock counts
// (the same ones the booth uses). This file only reads them; it never changes anything in Square.
//
// Cloudflare settings: SQUARE_ACCESS_TOKEN (secret), SQUARE_LOCATION_ID, SQUARE_ENV ("sandbox" or "production").
// The token needs the ITEMS_READ and INVENTORY_READ permissions (see docs/setup/square.md).

export const SQUARE_VERSION = '2026-09-16';

export function squareMode(env) { return env.SQUARE_ENV === 'sandbox' ? 'sandbox' : 'production'; }
export function squareHost(env) {
  return squareMode(env) === 'sandbox' ? 'https://connect.squareupsandbox.com' : 'https://connect.squareup.com';
}
export function squareConfigured(env) { return !!(env.SQUARE_ACCESS_TOKEN && env.SQUARE_LOCATION_ID); }

async function call(env, method, path, body, fetchFn) {
  const res = await fetchFn(squareHost(env) + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + env.SQUARE_ACCESS_TOKEN,
      'Square-Version': SQUARE_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data && data.errors && data.errors[0] && data.errors[0].code;
    throw new Error('square ' + path + ' ' + res.status + (code ? ' ' + code : ''));
  }
  return data;
}

// is this catalog object sold at our location?
function atLocation(obj, loc) {
  if (!obj || obj.is_deleted) return false;
  if (obj.present_at_all_locations) return !(obj.absent_at_location_ids || []).includes(loc);
  return (obj.present_at_location_ids || []).includes(loc);
}

// one variation, boiled down to what the shop needs. price is null if Square has no fixed price for it.
function describe(item, variation, loc) {
  const d = variation.item_variation_data || {};
  const over = (d.location_overrides || []).find((o) => o.location_id === loc) || {};
  const money = over.price_money || d.price_money;
  const itemName = (item && item.item_data && item.item_data.name) || '';
  const vName = d.name || '';
  return {
    id: variation.id,
    item: itemName,
    // "Regular" is Square's name for "the only one", so it is left off
    label: itemName + (vName && vName.toLowerCase() !== 'regular' ? ', ' + vName : ''),
    sku: d.sku || '',
    price_cents: d.pricing_type === 'FIXED_PRICING' && money && Number.isInteger(money.amount) ? money.amount : null,
    currency: (money && money.currency) || 'USD',
    tracked: (over.track_inventory !== undefined ? over.track_inventory : d.track_inventory) === true,
    // the "sold out" tick in the Square dashboard, which wins over any count
    marked_sold_out: over.sold_out === true,
    sellable: atLocation(variation, loc) && atLocation(item, loc) && !(item && item.item_data && item.item_data.is_archived)
  };
}

// Every variation of every item at our location: the choices in the admin page's dropdowns.
export async function listVariations(env, fetchFn = fetch) {
  const loc = env.SQUARE_LOCATION_ID;
  const out = [];
  let cursor = '';
  for (let page = 0; page < 50; page++) {
    const data = await call(env, 'GET', '/v2/catalog/list?types=ITEM' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), null, fetchFn);
    for (const item of data.objects || []) {
      for (const v of (item.item_data && item.item_data.variations) || []) {
        const one = describe(item, v, loc);
        if (one.sellable) out.push(one);
      }
    }
    cursor = data.cursor;
    if (!cursor) break;
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// The named variations, as { id: description }. Missing or deleted ones are simply left out.
export async function getVariations(env, ids, fetchFn = fetch) {
  const out = {};
  if (!ids.length) return out;
  const loc = env.SQUARE_LOCATION_ID;
  for (let i = 0; i < ids.length; i += 1000) {
    const data = await call(env, 'POST', '/v2/catalog/batch-retrieve',
      { object_ids: ids.slice(i, i + 1000), include_related_objects: true }, fetchFn);
    const items = {};
    for (const o of data.related_objects || []) if (o.type === 'ITEM') items[o.id] = o;
    for (const v of data.objects || []) {
      if (v.type !== 'ITEM_VARIATION' || v.is_deleted) continue;
      out[v.id] = describe(items[v.item_variation_data && v.item_variation_data.item_id], v, loc);
    }
  }
  return out;
}

// How many are on the shelf at our location, as { id: count }. Anything Square has no count for is 0.
export async function stockCounts(env, ids, fetchFn = fetch) {
  const out = {};
  ids.forEach((id) => { out[id] = 0; });
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 1000) {
    let cursor;
    for (let page = 0; page < 50; page++) {
      const data = await call(env, 'POST', '/v2/inventory/counts/batch-retrieve', {
        catalog_object_ids: ids.slice(i, i + 1000),
        location_ids: [env.SQUARE_LOCATION_ID],
        states: ['IN_STOCK'],
        ...(cursor ? { cursor } : {})
      }, fetchFn);
      for (const c of data.counts || []) {
        if (c.state === 'IN_STOCK' && c.location_id === env.SQUARE_LOCATION_ID && c.catalog_object_id in out) {
          out[c.catalog_object_id] = Math.max(0, Math.floor(Number(c.quantity) || 0));
        }
      }
      cursor = data.cursor;
      if (!cursor) break;
    }
  }
  return out;
}
