// Checks site/sitemap.xml and the search-engine tags on each page, so the map can't drift from the site.
// Run: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const ORIGIN = 'https://ourjkadventures.com';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const sitemap = read('site/sitemap.xml');
const pages = readdirSync(new URL('../site/', import.meta.url)).filter((f) => f.endsWith('.html'));
const noindex = (html) => /<meta name="robots" content="[^"]*noindex/.test(html);
const pathOf = (file) => (file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, ''));
const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

test('every public page is in the sitemap, and no noindex page is', () => {
  const pageLocs = locs.filter((l) => !l.includes('/assets/'));
  for (const file of pages) {
    const want = ORIGIN + pathOf(file);
    if (noindex(read('site/' + file))) assert.ok(!pageLocs.includes(want), file + ' says noindex but is in the sitemap');
    else assert.ok(pageLocs.includes(want), file + ' is public but missing from the sitemap');
  }
  assert.equal(new Set(pageLocs).size, pageLocs.length, 'a page is listed twice');
});

test('every public page has its own title, description and canonical address', () => {
  const titles = new Set();
  for (const file of pages) {
    const html = read('site/' + file);
    if (noindex(html)) continue;
    const title = html.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.ok(title && title.length <= 60, file + ': title missing or longer than 60 characters');
    assert.ok(!titles.has(title), file + ': title is used by another page');
    titles.add(title);
    const desc = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
    assert.ok(desc && desc.length >= 70 && desc.length <= 160, file + ': description missing, or not 70 to 160 characters');
    assert.match(html, new RegExp('<link rel="canonical" href="' + ORIGIN + pathOf(file) + '">'), file + ': canonical');
  }
});

test('every pup club pin has its own page in the sitemap, with its picture', () => {
  const products = JSON.parse(read('site/products.json'));
  const pups = products.items.filter((p) => p.series === 'pup-club').map((p) => p.slug);
  const pupLocs = locs.filter((l) => l.startsWith(ORIGIN + '/pup-club/'));
  assert.deepEqual(pupLocs.slice().sort(), pups.map((s) => ORIGIN + '/pup-club/' + s).sort(), 'the pup pages in the sitemap');
  for (const slug of pups) {
    const block = sitemap.split('<url>').find((u) => u.includes('<loc>' + ORIGIN + '/pup-club/' + slug + '</loc>'));
    assert.ok(block.includes('<image:loc>' + ORIGIN + '/assets/img/pins/' + slug + '.webp</image:loc>'), slug + ': picture');
  }
});

test('every lastmod is a real date and every image in the sitemap exists', () => {
  for (const m of sitemap.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) assert.match(m[1], /^\d{4}-\d{2}-\d{2}$/);
  for (const l of locs.filter((l) => l.includes('/assets/'))) {
    assert.ok(existsSync(new URL('../site' + l.slice(ORIGIN.length), import.meta.url)), l + ' is not in site/');
  }
});

test('robots.txt points at the sitemap and keeps crawlers out of the api and admin', () => {
  const robots = read('site/robots.txt');
  assert.match(robots, new RegExp('^Sitemap: ' + ORIGIN + '/sitemap.xml$', 'm'));
  assert.match(robots, /^Disallow: \/api\/$/m);
  assert.match(robots, /^Disallow: \/admin$/m);
});

test('every public page says what a shared link shows, matching its title, description and address', () => {
  const prop = (html, p) => (html.match(new RegExp('<meta property="' + p + '" content="([^"]*)">')) || [])[1];
  for (const file of pages) {
    const html = read('site/' + file);
    if (noindex(html)) continue;
    assert.equal(prop(html, 'og:title'), html.match(/<title>([^<]+)<\/title>/)[1], file + ': og:title');
    assert.equal(prop(html, 'og:description'), html.match(/<meta name="description" content="([^"]+)">/)[1], file + ': og:description');
    assert.equal(prop(html, 'og:url'), ORIGIN + pathOf(file), file + ': og:url');
    const img = prop(html, 'og:image') || '';
    assert.ok(img.startsWith(ORIGIN + '/assets/img/share/') && existsSync(new URL('../site' + img.slice(ORIGIN.length), import.meta.url)), file + ': og:image ' + img);
    assert.ok(prop(html, 'og:image:alt'), file + ': og:image:alt');
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/, file + ': twitter card');
  }
});

test('breadcrumb trails start at home and give every step but the last an address', () => {
  for (const file of pages) {
    const html = read('site/' + file);
    for (const m of html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)) {
      const ld = JSON.parse(m[1]);
      if (ld['@type'] !== 'BreadcrumbList') continue;
      const steps = ld.itemListElement;
      assert.equal(steps[0].item, ORIGIN + '/', file);
      steps.forEach((s, i) => {
        assert.equal(s.position, i + 1, file);
        if (i < steps.length - 1) assert.ok(s.item && s.item.startsWith(ORIGIN + '/'), file + ': step ' + s.name);
        else assert.equal(s.item, undefined, file + ': the last step is this page');
      });
    }
  }
});

test('links between our pages use the plain address (/shop), not the old one (shop.html) that redirects', () => {
  for (const file of pages) {
    const bad = read('site/' + file).match(/href="[a-z0-9-]+\.html[^"]*"/g);
    assert.equal(bad, null, file + ': ' + bad);
  }
});
