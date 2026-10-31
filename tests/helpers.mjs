// Shared fakes for the tests: a pretend Google (sign-in keys, Firestore, auth admin) and a pretend Square.
export const PROJECT = 'jk-test';
export const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function keypair() {
  return crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
}
const google = await keypair();
export const stranger = await keypair();
const googleJwk = { ...(await crypto.subtle.exportKey('jwk', google.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const saPem = '-----BEGIN PRIVATE KEY-----\n' +
  Buffer.from(await crypto.subtle.exportKey('pkcs8', (await keypair()).privateKey)).toString('base64') + '\n-----END PRIVATE KEY-----\n';

export async function sign(claims, { key = google.privateKey, kid = 'k1', alg = 'RS256' } = {}) {
  const t = Math.floor(Date.now() / 1000);
  const body = { aud: PROJECT, iss: 'https://securetoken.google.com/' + PROJECT, sub: 'uid123', iat: t - 10, exp: t + 3600, auth_time: t - 10, email: 'pup@example.com', email_verified: true, ...claims };
  const unsigned = enc({ alg, kid, typ: 'JWT' }) + '.' + enc(body);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  return unsigned + '.' + Buffer.from(sig).toString('base64url');
}

// a pretend Google (key list, token exchange, Firestore, auth admin) and a pretend Square
export function fakeGoogle() {
  const docs = {};
  const calls = [];
  const squareOrders = {};
  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    calls.push(method + ' ' + url);
    if (url.includes('securetoken@system')) return new Response(JSON.stringify({ keys: [googleJwk] }), { headers: { 'Cache-Control': 'max-age=100' } });
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'server-token', expires_in: 3600 });
    if (url.endsWith('/v2/orders/batch-retrieve')) {
      const ids = JSON.parse(opts.body).order_ids;
      return Response.json({ orders: ids.map((id) => squareOrders[id]).filter(Boolean) });
    }
    if (opts.headers && opts.headers.Authorization !== 'Bearer server-token') return new Response('no', { status: 401 });
    if (url.endsWith('/documents:runQuery')) {
      // top-level collection, equality filters only (all the server uses)
      const sq = JSON.parse(opts.body).structuredQuery;
      const col = sq.from[0].collectionId;
      const w = sq.where ? (sq.where.compositeFilter ? sq.where.compositeFilter.filters : [sq.where]) : [];
      const rows = Object.keys(docs).filter((k) => k.split('/').length === 2 && k.startsWith(col + '/'))
        .filter((k) => w.every((f) => JSON.stringify(docs[k][f.fieldFilter.field.fieldPath]) === JSON.stringify(f.fieldFilter.value)))
        .slice(0, sq.limit || 1000)
        .map((k) => ({ document: { name: 'projects/x/databases/(default)/documents/' + k, fields: docs[k] } }));
      return Response.json(rows.length ? rows : [{ readTime: 'now' }]);
    }
    const m = /documents\/([^?]+)(?:\?(.*))?$/.exec(url);
    if (m) {
      const q = new URLSearchParams(m[2] || '');
      const p = m[1].split('/').map(decodeURIComponent).join('/');
      const isCollection = p.split('/').length % 2 === 1;
      if (method === 'GET' && isCollection) {
        const documents = Object.keys(docs).filter((k) => k.startsWith(p + '/') && k.split('/').length === p.split('/').length + 1)
          .map((k) => ({ name: 'projects/x/databases/(default)/documents/' + k, fields: docs[k] }));
        return Response.json({ documents });
      }
      if (method === 'GET') return docs[p] ? Response.json({ fields: docs[p] }) : new Response('{}', { status: 404 });
      if (method === 'POST') {
        const full = p + '/' + q.get('documentId');
        if (docs[full]) return new Response('{}', { status: 409 });
        docs[full] = JSON.parse(opts.body).fields;
        return Response.json({});
      }
      if (method === 'PATCH') {
        // with currentDocument.exists=true it only updates; without it, it creates or replaces
        if (!docs[p] && q.get('currentDocument.exists') === 'true') return new Response('{}', { status: 404 });
        if (q.has('updateMask.fieldPaths')) docs[p] = Object.assign(docs[p] || {}, JSON.parse(opts.body).fields);
        else docs[p] = JSON.parse(opts.body).fields;
        return Response.json({});
      }
      if (method === 'DELETE') { delete docs[p]; return Response.json({}); }
    }
    if (url.endsWith('/accounts:delete')) return Response.json({});
    return new Response('unexpected ' + url, { status: 500 });
  };
  return { docs, calls, fetchFn, squareOrders };
}

export const env = { SQUARE_ACCESS_TOKEN: 'sq', SQUARE_LOCATION_ID: 'loc', SQUARE_ENV: 'sandbox', FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@jk-test.iam.gserviceaccount.com', private_key: saPem }) };

// a pretend Square catalog and stock list, shaped like the real one (items with "Regular" variations)
export const LOC = 'loc';
function sqItem(id, name, varId, cents, opts = {}) {
  return {
    type: 'ITEM', id, is_deleted: false, present_at_all_locations: false, present_at_location_ids: [opts.loc || LOC],
    item_data: {
      name, is_archived: !!opts.archived,
      variations: [{
        type: 'ITEM_VARIATION', id: varId, is_deleted: false, present_at_all_locations: false, present_at_location_ids: [opts.loc || LOC],
        item_variation_data: {
          item_id: id, name: 'Regular', sku: 'SKU-' + varId, pricing_type: 'FIXED_PRICING',
          price_money: { amount: cents, currency: 'USD' }, track_inventory: true,
          location_overrides: opts.soldOutTick ? [{ location_id: LOC, track_inventory: true, sold_out: true }] : []
        }
      }]
    }
  };
}
export function fakeSquare() {
  const items = [
    sqItem('I_AUS', 'Aussie Standard Pin', 'V_AUS', 1200),
    sqItem('I_AUS_L', 'Large Aussie Pin (Exclusive)', 'V_AUS_L', 1500),
    sqItem('I_POM', 'Pomeranian Standard Pin', 'V_POM', 1200, { soldOutTick: true }),
    sqItem('I_OLD', 'Old Pin', 'V_OLD', 1000, { archived: true }),
    sqItem('I_ELSE', 'Elsewhere Pin', 'V_ELSE', 1000, { loc: 'other-loc' })
  ];
  const stock = { V_AUS: 3, V_AUS_L: 48, V_POM: 5, V_OLD: 9, V_ELSE: 9 };
  const links = [];
  const calls = [];
  const variations = () => items.flatMap((i) => i.item_data.variations);
  const fetchFn = async (url, opts = {}) => {
    calls.push((opts.method || 'GET') + ' ' + url);
    if (url.includes('/v2/catalog/list')) return Response.json({ objects: items });
    if (url.endsWith('/v2/catalog/batch-retrieve')) {
      const ids = JSON.parse(opts.body).object_ids;
      const objects = variations().filter((v) => ids.includes(v.id));
      const related = items.filter((i) => objects.some((v) => v.item_variation_data.item_id === i.id));
      return Response.json({ objects, related_objects: related });
    }
    if (url.endsWith('/v2/inventory/counts/batch-retrieve')) {
      const b = JSON.parse(opts.body);
      return Response.json({ counts: b.catalog_object_ids.filter((id) => id in stock).map((id) => ({
        catalog_object_id: id, catalog_object_type: 'ITEM_VARIATION', state: 'IN_STOCK', location_id: b.location_ids[0], quantity: String(stock[id])
      })) });
    }
    if (url.endsWith('/v2/online-checkout/payment-links')) {
      links.push(JSON.parse(opts.body));
      return Response.json({ payment_link: { url: 'https://square.link/u/abc', order_id: 'ORDER_' + links.length } });
    }
    return null;
  };
  return { items, stock, links, calls, fetchFn };
}

// Google and Square together, for code that talks to both
export function fakeWorld() {
  const g = fakeGoogle();
  const sq = fakeSquare();
  const fetchFn = async (url, opts = {}) => (await sq.fetchFn(String(url), opts)) || g.fetchFn(String(url), opts);
  return { g, sq, fetchFn };
}
