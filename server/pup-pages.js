// j+k adventures: a page of its own for each pup club pin, at /pup-club/<slug> (for example /pup-club/corgi),
// so a search engine can list each pin by itself, with its price and whether it's in stock.
//
// There is one page to keep, site/pup-club.html (the board). For /pup-club/corgi the worker reads that page and
// fills in the corgi's own title, description, canonical address and heading (from products.json), and hides the pack's intro line,
// so the board still works the same and opens the corgi. Like a form letter: one letter, a name filled in each time.
//
// It also writes a hidden product card for Google (schema.org Product, as JSON-LD) with the price and stock from
// Square, the same numbers /api/catalog uses. Prices are never in the repo. The card only offers the pin for sale
// when the shop is open, the product is switched on, it's linked to Square and Square answered. Otherwise the
// card has no offer at all (the shop fails closed, and Google never shows a price for something nobody can buy).
// The card also carries the pin's approved reviews and their star average. Google only accepts a product card
// with a price, reviews or stars, so with none of those (closed and no reviews yet) the card is left out rather
// than written half empty. Next to it goes a breadcrumb trail (home › shop › pup club › corgi), which Google can
// show in a search listing in place of the bare address.
//
// Plain text replacement, not HTMLRewriter: the page is our own file, and this way the tests can run it in node.
// tests/pup-pages.test.mjs checks that every spot it fills is still in pup-club.html. pup-club.html has <base href="/">,
// so its "assets/..." pictures work from /pup-club/corgi too.

import { siteProducts, getCatalog } from './catalog.js';
import { pinReviews } from './reviews.js';
import { staticOrNotFound } from './not-found.js';

export const SITE = 'https://ourjkadventures.com';
const BRAND = 'j+k adventures';

// the golden retriever pin is shown as "goldie"
export function pupName(p) { return p.slug === 'golden' ? 'goldie' : p.name; }

// "corgi dog enamel pin. j+k adventures", "aussie australian shepherd enamel pin. j+k adventures"
export function pupTitle(p) {
  return pupLabel(p) + ' enamel pin. ' + BRAND;
}

// "corgi dog", "aussie australian shepherd": the name and breed, also Google Shopping's title (server/merchant.js)
export function pupLabel(p) {
  const name = pupName(p);
  const breed = p.breed || p.name;
  let what = breed.includes(name) ? breed : name + ' ' + breed;
  if (!what.includes(' ')) what += ' dog';
  return what;
}

export function pupPath(slug) { return '/pup-club/' + slug; }
export function pupImage(slug) { return SITE + '/assets/img/pins/' + slug + '.webp'; }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the offers for Google: one per size, only from what the catalog says can be sold right now
export function pupOffers(catalog, slug) {
  if (!catalog || catalog.open !== true) return [];
  const item = (catalog.items || []).find((p) => p.slug === slug);
  if (!item || !item.available) return [];
  return (item.sizes || []).filter((s) => Number.isInteger(s.price_cents) && s.price_cents > 0).map((s) => {
    const row = catalog.byKey && catalog.byKey[s.key];
    return {
      '@type': 'Offer',
      ...(item.sizes.length > 1 ? { name: s.size === 'standard' ? 'standard size' : s.size + ' size' } : {}),
      price: (s.price_cents / 100).toFixed(2),
      priceCurrency: (row && row.currency) || catalog.currency || 'USD',
      availability: s.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      url: SITE + pupPath(slug)
    };
  });
}

// home › shop › pup club › (the pup). the last step has no address: it's the page you're on
export function pupBreadcrumb(p) {
  const steps = [['home', SITE + '/'], ['shop', SITE + '/shop'], ['pup club', SITE + '/pup-club']];
  if (p) steps.push([pupName(p), null]);
  return {
    '@type': 'BreadcrumbList',
    itemListElement: steps.map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, ...(item ? { item } : {}) }))
  };
}

// the stars and up to five of the newest reviews with words, from what the owner approved
const MAX_REVIEWS = 5;
function reviewData(rv) {
  if (!rv || !rv.count) return {};
  return {
    aggregateRating: { '@type': 'AggregateRating', ratingValue: rv.average, reviewCount: rv.count, bestRating: 5, worstRating: 1 },
    review: rv.reviews.filter((r) => r.text).slice(0, MAX_REVIEWS).map((r) => ({
      '@type': 'Review',
      author: { '@type': 'Person', name: r.name },
      ...(r.date ? { datePublished: r.date } : {}),
      reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5, worstRating: 1 },
      reviewBody: r.text
    }))
  };
}

// the product card, or null when it would have no price, reviews or stars (Google would call it invalid)
export function pupProductData(p, catalog, rv) {
  const offers = pupOffers(catalog, p.slug);
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: pupName(p) + ' enamel pin',
    description: p.about || p.summary || '',
    image: [pupImage(p.slug)],
    brand: { '@type': 'Brand', name: BRAND },
    url: SITE + pupPath(p.slug)
  };
  if (offers.length) data.offers = offers.length === 1 ? offers[0] : offers;
  Object.assign(data, reviewData(rv));
  if (!data.offers && !data.aggregateRating) return null;
  if (data.review && !data.review.length) delete data.review;
  return data;
}

// everything Google reads about the page, in one block: the trail, and the product card when there is one
export function pupPageData(p, catalog, rv) {
  const product = pupProductData(p, catalog, rv);
  return { '@context': 'https://schema.org', '@graph': [pupBreadcrumb(p)].concat(product ? [product] : []) };
}

// the spots in pup-club.html this fills. each must be there exactly once (the tests check)
export const SPOTS = {
  title: /<title>[^<]*<\/title>/,
  description: /<meta name="description" content="[^"]*">/,
  canonical: /<link rel="canonical" href="[^"]*">/,
  heading: /(<h1 [^>]*data-pup-heading[^>]*>)([^<]*)(<\/h1>)/,
  words: /(<p [^>]*data-pup-words[^>]*>)([^<]*)(<\/p>)/,
  // what a shared link shows: the pup's own title, words, address and picture (scripts/share-pictures.py)
  ogTitle: /<meta property="og:title" content="[^"]*">/,
  ogDescription: /<meta property="og:description" content="[^"]*">/,
  ogUrl: /<meta property="og:url" content="[^"]*">/,
  ogImage: /<meta property="og:image" content="[^"]*">/,
  ogImageAlt: /<meta property="og:image:alt" content="[^"]*">/,
  // the board's own trail (home › shop › pup club), swapped for the pup's trail and product card
  data: /<script type="application\/ld\+json">[^<]*<\/script>/
};

export function fillPupPage(html, p, catalog, rv) {
  const ld = JSON.stringify(pupPageData(p, catalog, rv)).replace(/</g, '\\u003c');
  return html
    .replace(SPOTS.title, (m) => '<title data-pack="' + esc(m.replace(/<\/?title>/g, '')) + '">' + esc(pupTitle(p)) + '</title>')
    .replace(SPOTS.description, () => '<meta name="description" content="' + esc(p.summary || p.about || '') + '">')
    .replace(SPOTS.canonical, () => '<link rel="canonical" href="' + SITE + pupPath(p.slug) + '">')
    .replace(SPOTS.ogTitle, () => '<meta property="og:title" content="' + esc(pupTitle(p)) + '">')
    .replace(SPOTS.ogDescription, () => '<meta property="og:description" content="' + esc(p.summary || p.about || '') + '">')
    .replace(SPOTS.ogUrl, () => '<meta property="og:url" content="' + SITE + pupPath(p.slug) + '">')
    .replace(SPOTS.ogImage, () => '<meta property="og:image" content="' + SITE + '/assets/img/share/' + p.slug + '.jpg">')
    .replace(SPOTS.ogImageAlt, () => '<meta property="og:image:alt" content="' + esc('the ' + pupName(p) + ' enamel pin from j+k adventures') + '">')
    // the pack's own heading and words ride along, so the board can put them back when the pin is closed
    .replace(SPOTS.heading, (m, open, text, close) => open.replace('>', ' data-pack="' + text + '">') + esc('the ' + pupName(p) + '.') + close)
    // the pup's words are in its card on the board, so the pack's intro line steps aside instead of repeating them
    .replace(SPOTS.words, (m, open, text, close) => open.replace('>', ' data-pack="' + text + '" hidden>') + close)
    .replace(SPOTS.data, () => '<script type="application/ld+json">' + ld + '</script>');
}

// GET /pup-club/<slug>. anything that isn't one of our pups gets the "page not found" page (a 404)
export async function pupPageRoute(request, env, slug, fetchFn = fetch) {
  const url = new URL(request.url);
  let products;
  try { products = await siteProducts(env, url); } catch (e) { return staticOrNotFound(request, env); }
  const p = (products.items || []).find((x) => x.slug === slug && x.kind === 'pin' && x.series === 'pup-club');
  if (!p) return staticOrNotFound(request, env);

  const page = await env.ASSETS.fetch(new Request(new URL('/pup-club', url)));
  if (!page.ok) return page;
  const html = await page.text();

  // Square or Firestore not answering only means no offer on the card: the page itself still shows
  // the same for reviews: without them the card just has no stars
  const [catalog, rv] = await Promise.all([
    getCatalog(env, url, fetchFn).catch((e) => { console.log('pup page catalog: ' + e.message); return null; }),
    pinReviews(env, p.slug, fetchFn).catch((e) => { console.log('pup page reviews: ' + e.message); return null; })
  ]);

  return new Response(request.method === 'HEAD' ? null : fillPupPage(html, p, catalog, rv), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
}
