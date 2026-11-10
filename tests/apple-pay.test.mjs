// Apple Pay's domain check: the file Square gave us, answered exactly, at the address Apple asks for.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';

test('the Apple Pay domain file is answered at its address on ourjkadventures.com, the domain registered with Apple', async () => {
  const env = { ASSETS: { fetch: async () => new Response('nf', { status: 404 }) } };
  for (const host of ['https://ourjkadventures.com']) {
    const r = await worker.fetch(new Request(host + '/.well-known/apple-developer-merchantid-domain-association'), env);
    assert.equal(r.status, 200, host);
    const body = await r.text();
    assert.match(body, /^[0-9A-F]+$/);
    // the hex spells Square's signed note to Apple
    assert.match(Buffer.from(body, 'hex').toString(), /^\{"pspId":"[0-9A-F]+","version":1,/);
  }
});
