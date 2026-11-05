// j+k adventures: a page of its own for each pup club pin, at /pup-club/<slug> (for example /pup-club/corgi),
// so a search engine can list each pin by itself, with its price and whether it's in stock.
//
// There is one page to keep, site/pup-club.html (the board). For /pup-club/corgi the worker reads that page and
// fills in the corgi's own title, description, canonical address, heading and few sentences (from products.json),
// so the board still works the same and opens the corgi. Like a form letter: one letter, a name filled in each time.
//
// It also writes a hidden product card for Google (schema.org Product, as JSON-LD) with the price and stock from
// Square, the same numbers /api/catalog uses. Prices are never in the repo. The card only offers the pin for sale
// when the shop is open, the product is switched on, it's linked to Square and Square answered. Otherwise the
// card has no offer at all (the shop fails closed, and Google never shows a price for something nobody can buy).
//
// Plain text replacement, not HTMLRewriter: the page is our own file, and this way the tests can run it in node.
// tests/pup-pages.test.mjs checks that every spot it fills is still in pup-club.html.

import { siteProducts, getCatalog } from './catalog.js';

export const SITE = 'https://ourjkadventures.com';
const BRAND = 'j+k adventures';

// the golden retriever pin is shown as "goldie"
export function pupName(p) { return p.slug === 'golden' ? 'goldie' : p.name; }

// "corgi dog enamel pin. j+k adventures", "aussie australian shepherd enamel pin. j+k adventures"
export function pupTitle(p) {
  const name = pupName(p);
  const breed = p.breed || p.name;
  let what = breed.includes(name) ? breed : name + ' ' + breed;
  if (!what.includes(' ')) what += ' dog';
  return what + ' enamel pin. ' + BRAND;
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

export function pupProductData(p, catalog) {
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
  return data;
}

// the spots in pup-club.html this fills. each must be there exactly once (the tests check)
export const SPOTS = {
  head: /<meta charset="utf-8">\n/,
  title: /<title>[^<]*<\/title>/,
  description: /<meta name="description" content="[^"]*">/,
  canonical: /<link rel="canonical" href="[^"]*">/,
  heading: /(<h1 [^>]*data-pup-heading[^>]*>)([^<]*)(<\/h1>)/,
  words: /(<p [^>]*data-pup-words[^>]*>)([^<]*)(<\/p>)/,
  end: /<\/head>/
};

export function fillPupPage(html, p, catalog) {
  const ld = JSON.stringify(pupProductData(p, catalog)).replace(/</g, '\\u003c');
  return html
    // the board's pictures and links are written as "assets/..." and "shop.html": start them all from the front door,
    // or /pup-club/corgi would look for /pup-club/assets/...
    .replace(SPOTS.head, (m) => m + '<base href="/">\n')
    .replace(SPOTS.title, (m) => '<title data-pack="' + esc(m.replace(/<\/?title>/g, '')) + '">' + esc(pupTitle(p)) + '</title>')
    .replace(SPOTS.description, () => '<meta name="description" content="' + esc(p.summary || p.about || '') + '">')
    .replace(SPOTS.canonical, () => '<link rel="canonical" href="' + SITE + pupPath(p.slug) + '">')
    // the pack's own heading and words ride along, so the board can put them back when the pin is closed
    .replace(SPOTS.heading, (m, open, text, close) => open.replace('>', ' data-pack="' + text + '">') + esc('the ' + pupName(p) + '.') + close)
    .replace(SPOTS.words, (m, open, text, close) => open.replace('>', ' data-pack="' + text + '">') + esc(p.about || '') + close)
    .replace(SPOTS.end, () => '<script type="application/ld+json">' + ld + '</script>\n</head>');
}

// GET /pup-club/<slug>. anything that isn't one of our pups falls through to the static files (a 404)
export async function pupPageRoute(request, env, slug, fetchFn = fetch) {
  const url = new URL(request.url);
  let products;
  try { products = await siteProducts(env, url); } catch (e) { return env.ASSETS.fetch(request); }
  const p = (products.items || []).find((x) => x.slug === slug && x.kind === 'pin' && x.series === 'pup-club');
  if (!p) return env.ASSETS.fetch(request);

  const page = await env.ASSETS.fetch(new Request(new URL('/pup-club', url)));
  if (!page.ok) return page;
  const html = await page.text();

  // Square or Firestore not answering only means no offer on the card: the page itself still shows
  let catalog = null;
  try { catalog = await getCatalog(env, url, fetchFn); } catch (e) { console.log('pup page catalog: ' + e.message); }

  return new Response(request.method === 'HEAD' ? null : fillPupPage(html, p, catalog), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }
  });
}
