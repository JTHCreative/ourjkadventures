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
import { _resetReviewCache } from '../server/reviews.js';
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
// reviews: [{ slug, rating, text, name, status }] put in the fake Firestore
function setup({ open = true, available, square = true, firestore = true, reviews = [] } = {}) {
  _resetCaches();
  _resetShopCache();
  _resetCatalogCache();
  _resetReviewCache();
  const w = fakeWorld();
  reviews.forEach((r, i) => {
    w.g.docs['reviews/' + r.slug + '_u' + i] = {
      slug: str(r.slug), rating: { integerValue: String(r.rating) }, text: str(r.text || ''), name: str(r.name || 'juniper h.'),
      status: str(r.status || 'approved'), createdAt: str('2026-11-0' + (i + 1) + 'T10:00:00Z')
    };
  });
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

// what the page tells Google: a breadcrumb trail, and a product card when there's a price or reviews to show
const graph = (html) => {
  const all = html.match(/<script type="application\/ld\+json">[^<]+<\/script>/g) || [];
  assert.equal(all.length, 1, 'one block for Google');
  return JSON.parse(all[0].replace(/<\/?script[^>]*>/g, ''))['@graph'];
};
const card = (html) => graph(html).find((x) => x['@type'] === 'Product') || null;
const trail = (html) => graph(html).find((x) => x['@type'] === 'BreadcrumbList');
const offersOf = (html) => { const c = card(html); return c && c.offers ? [].concat(c.offers) : []; };
const meta = (html, prop) => (html.match(new RegExp('<meta property="' + prop + '" content="([^"]*)">')) || [])[1];

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
    // the words are in the pup's card (and the product card below), not repeated under the heading
    assert.match(html, /data-pup-words data-pack="[^"]+" hidden><\/p>/, p.slug + ': intro line hidden');
    assert.equal(html.split('<base href="/">').length, 2, p.slug + ': one base');
    // home › shop › pup club › the pup
    assert.deepEqual(trail(html).itemListElement.map((s) => [s.position, s.name, s.item]), [
      [1, 'home', ORIGIN + '/'], [2, 'shop', ORIGIN + '/shop'], [3, 'pup club', ORIGIN + '/pup-club'], [4, name, undefined]
    ], p.slug + ': trail');
    // a shared link shows the pup
    assert.equal(meta(html, 'og:title'), title, p.slug + ': og:title');
    assert.equal(meta(html, 'og:description'), p.summary, p.slug + ': og:description');
    assert.equal(meta(html, 'og:url'), ORIGIN + '/pup-club/' + p.slug, p.slug + ': og:url');
    assert.equal(meta(html, 'og:image'), ORIGIN + '/assets/img/share/' + p.slug + '.jpg', p.slug + ': og:image');
    assert.ok(fs.existsSync(new URL('../site/assets/img/share/' + p.slug + '.jpg', import.meta.url)), p.slug + ': share picture');
    assert.ok(meta(html, 'og:image:alt').includes(name), p.slug + ': og:image:alt');
    // only the aussie and pomeranian are linked to the fake Square, so only they have a card here
    const c = card(html);
    if (!['aussie', 'pomeranian'].includes(p.slug)) { assert.equal(c, null, p.slug + ': no price or reviews, no card'); continue; }
    assert.equal(c.description, p.about, p.slug + ': words in the product card');
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
    // with no price and no reviews there is nothing for a product card to say, so there isn't one
    assert.equal(card(html), null, why);
    assert.doesNotMatch(html.match(/<script type="application\/ld\+json">[^<]+/)[0], /price/, why);
  }
});

test('approved reviews give the card stars, even while the shop is closed', async () => {
  const reviews = [
    { slug: 'corgi', rating: 5, text: 'wears it every day.', name: 'juniper h.' },
    { slug: 'corgi', rating: 4, text: '', name: 'sam' },
    { slug: 'corgi', rating: 1, text: 'not approved yet', status: 'waiting' },
    { slug: 'beagle', rating: 2, text: 'another pup' }
  ];
  const call = setup({ open: false, reviews });
  const c = card(await (await call('/pup-club/corgi')).text());
  assert.ok(c, 'a card');
  assert.equal(c.offers, undefined, 'closed: still no price');
  assert.deepEqual(c.aggregateRating, { '@type': 'AggregateRating', ratingValue: 4.5, reviewCount: 2, bestRating: 5, worstRating: 1 });
  // only reviews with words are written out, newest first
  assert.deepEqual(c.review.map((r) => [r.author.name, r.reviewRating.ratingValue, r.reviewBody, r.datePublished]), [
    ['juniper h.', 5, 'wears it every day.', '2026-11-01']
  ]);
  // stars only, no words: stars but no review list
  const stars = setup({ open: false, reviews: [{ slug: 'pug', rating: 5 }] });
  const pug = card(await (await stars('/pup-club/pug')).text());
  assert.equal(pug.aggregateRating.reviewCount, 1);
  assert.equal(pug.review, undefined);
  // a review can't break out of the page's script block
  const sly = setup({ open: false, reviews: [{ slug: 'husky', rating: 5, text: 'nice </script><b>pin</b>' }] });
  const html = await (await sly('/pup-club/husky')).text();
  assert.equal(html.match(/<\/script>/g).length, html.match(/<script/g).length);
});

test('the board page has its own trail and a shared-link picture', () => {
  assert.match(template, /<meta property="og:image" content="https:\/\/ourjkadventures\.com\/assets\/img\/share\/pup-club\.jpg">/);
  const ld = JSON.parse(template.match(SPOTS.data)[0].replace(/<\/?script[^>]*>/g, ''));
  assert.deepEqual(ld.itemListElement.map((s) => s.name), ['home', 'shop', 'pup club']);
});

test('the board\'s pups are real links to their own pages, for search engines to follow', () => {
  const src = read('site/assets/app.js');
  assert.match(src, /var b = el\('a', 'pup-pin'\);\n\s+b\.href = '\/pup-club\/' \+ s;/);
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
