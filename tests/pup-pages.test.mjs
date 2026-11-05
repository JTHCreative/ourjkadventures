// Tests for each pup club pin's own page, /pup-club/<slug> (server/pup-pages.js): the words a search engine reads,
// and the hidden product card, whose price and stock come only from Square and only while the pin can be bought.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker from '../site/_worker.js';
import { _resetCaches } from '../server/firebase.js';
import { _resetShopCache } from '../server/shop.js';
import { _resetCatalogCache } from '../server/catalog.js';
import { SPOTS } from '../server/pup-pages.js';
import { fakeWorld, env as baseEnv } from './helpers.mjs';

const ORIGIN = 'https://ourjkadventures.com';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const products = JSON.parse(read('site/products.json'));
const template = read('site/pup-club.html');
const pups = products.items.filter((p) => p.series === 'pup-club');
const str = (s) => ({ stringValue: s });

// the static files, as the worker's ASSETS sees them
const assets = {
  fetch: async (req) => {
    const path = new URL(req.url || req).pathname;
    if (path === '/products.json') return Response.json(products);
    if (path === '/pup-club') return new Response(template, { headers: { 'Content-Type': 'text/html' } });
    return new Response('not found', { status: 404 });
  }
};

// the fake Square has aussie (3 standard at $12, 48 large at $15) and the pomeranian ($12, ticked sold out); corgi is not linked
function setup({ open = true, available, square = true, firestore = true } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  const w = fakeWorld();
  w.g.docs['settings/shop'] = { open: { booleanValue: open } };
  w.g.docs['settings/square_sandbox'] = { aussie: str('V_AUS'), 'aussie:large': str('V_AUS_L'), pomeranian: str('V_POM') };
  if (available) w.g.docs['settings/available_sandbox'] = Object.fromEntries(Object.entries(available).map(([k, v]) => [k, { booleanValue: v }]));
  globalThis.fetch = async (url, opts) => {
    if (!square && String(url).includes('squareup')) throw new Error('square is resting');
    if (!firestore && String(url).includes('firestore')) throw new Error('firestore is resting');
    return w.fetchFn(url, opts);
  };
  const env = { ...baseEnv, ASSETS: assets };
  return (path, method = 'GET') => worker.fetch(new Request('https://x.test' + path, { method }), env);
}

const card = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([^<]+)<\/script>/)[1]);
const offersOf = (html) => { const o = card(html).offers; return o ? [].concat(o) : []; };

test('pup-club.html still has every spot the worker fills in, once each', () => {
  for (const [name, re] of Object.entries(SPOTS)) {
    const all = template.match(new RegExp(re.source, 'g')) || [];
    assert.equal(all.length, 1, 'pup-club.html: the ' + name + ' spot');
  }
  // without it, /pup-club/corgi would look for its pictures in /pup-club/assets/
  assert.match(template, /<meta charset="utf-8">\n(<!--[^\n]*-->\n)?<base href="\/">\n/);
});

test('every pup has a breed, its few sentences and a search description, and none of them name a price', () => {
  assert.equal(pups.length, 16);
  for (const p of pups) {
    assert.ok(p.breed && p.about && p.summary, p.slug);
    assert.ok(p.summary.length >= 70 && p.summary.length <= 160, p.slug + ': summary is ' + p.summary.length + ' characters');
    for (const words of [p.breed, p.about, p.summary]) {
      assert.equal(words, words.toLowerCase(), p.slug + ': lowercase');
      assert.doesNotMatch(words, /\$|\d+\.\d\d|price|sale|deal|hurry/i, p.slug + ': no prices or sales words');
    }
  }
});

test('the board\'s breed names in app.js match products.json', () => {
  const src = read('site/assets/app.js');
  const breeds = Function('return ' + src.match(/var PUP_BREED = (\{[\s\S]*?\n  \});/)[1])();
  for (const p of pups) assert.equal(breeds[p.slug], p.breed, p.slug);
});

test('each pup page has its own title, description, canonical address, heading, words and picture', async () => {
  const call = setup();
  const titles = new Set();
  for (const p of pups) {
    const res = await call('/pup-club/' + p.slug);
    assert.equal(res.status, 200, p.slug);
    assert.match(res.headers.get('Content-Type'), /text\/html/);
    const html = await res.text();
    const name = p.slug === 'golden' ? 'goldie' : p.name;
    const title = html.match(/<title[^>]*>([^<]+)<\/title>/)[1];
    assert.ok(title.length <= 60, p.slug + ': title "' + title + '" is over 60 characters');
    assert.ok(title.includes(name) && title.endsWith('enamel pin. j+k adventures'), title);
    assert.ok(!titles.has(title), title + ' is used twice');
    titles.add(title);
    assert.ok(html.includes('<meta name="description" content="' + p.summary + '">'), p.slug + ': description');
    assert.ok(html.includes('<link rel="canonical" href="' + ORIGIN + '/pup-club/' + p.slug + '">'), p.slug + ': canonical');
    assert.match(html, new RegExp('data-pup-heading data-pack="the pack.">the ' + name + '.</h1>'));
    assert.ok(html.includes('data-pup-words data-pack="') && html.includes('>' + p.about + '</p>'), p.slug + ': words');
    assert.equal(html.split('<base href="/">').length, 2, p.slug + ': one base');
    const c = card(html);
    assert.equal(c['@type'], 'Product');
    assert.equal(c.name, name + ' enamel pin');
    assert.deepEqual(c.brand, { '@type': 'Brand', name: 'j+k adventures' });
    assert.equal(c.url, ORIGIN + '/pup-club/' + p.slug);
    assert.ok(fs.existsSync(new URL('../site' + c.image[0].slice(ORIGIN.length), import.meta.url)), c.image[0]);
  }
  assert.equal(titles.has('goldie golden retriever enamel pin. j+k adventures'), true);
  assert.equal(titles.has('corgi dog enamel pin. j+k adventures'), true);
});

test('open shop: the card offers each size at the Square price, in stock or not', async () => {
  const call = setup();
  const aussie = offersOf(await (await call('/pup-club/aussie')).text());
  assert.deepEqual(aussie.map((o) => [o.name, o.price, o.priceCurrency, o.availability]), [
    ['standard size', '12.00', 'USD', 'https://schema.org/InStock'],
    ['large size', '15.00', 'USD', 'https://schema.org/InStock']
  ]);
  assert.equal(aussie[0].url, ORIGIN + '/pup-club/aussie');
  // ticked sold out in Square: still its price, marked out of stock
  const pom = card(await (await call('/pup-club/pomeranian')).text()).offers;
  assert.equal(pom.price, '12.00');
  assert.equal(pom.availability, 'https://schema.org/OutOfStock');
  assert.equal(pom.name, undefined);
  // not linked to Square: no price is known, so no offer
  assert.deepEqual(offersOf(await (await call('/pup-club/corgi')).text()), []);
});

test('fails closed: no offer when the shop is closed, the pin is switched off, or Square or Firestore can\'t be read', async () => {
  const cases = [
    ['closed', { open: false }],
    ['switched off', { available: { aussie: false } }],
    ['square down', { square: false }],
    ['firestore down', { firestore: false }]
  ];
  for (const [why, opts] of cases) {
    const call = setup(opts);
    const res = await call('/pup-club/aussie');
    assert.equal(res.status, 200, why + ': the page still shows');
    const html = await res.text();
    assert.deepEqual(offersOf(html), [], why);
    assert.doesNotMatch(html.match(/<script type="application\/ld\+json">[^<]+/)[0], /price/, why);
  }
});

test('only our pups get a page; a trailing slash moves to the plain address', async () => {
  const call = setup();
  assert.equal((await call('/pup-club/not-a-dog')).status, 404);
  assert.equal((await call('/pup-club/bay-area-pin-board')).status, 404);
  assert.equal((await call('/pup-club/Corgi')).status, 404);
  const slash = await call('/pup-club/corgi/');
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get('Location'), 'https://x.test/pup-club/corgi');
  const head = await call('/pup-club/corgi', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});
