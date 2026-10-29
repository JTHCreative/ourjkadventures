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

export const env = { SQUARE_ACCESS_TOKEN: 'sq', SQUARE_LOCATION_ID: 'loc', FIREBASE_PROJECT_ID: PROJECT, FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ client_email: 'sa@jk-test.iam.gserviceaccount.com', private_key: saPem }) };
