// j+k adventures: "email me when it's here", for products that are not in the shop yet.
// Like leaving your name at the counter: you write it down, and when the pin arrives the owner presses one button on
// /admin and everyone waiting gets one email. Then the slip is thrown away.
//
//   POST /api/notify          { slug, email }  -> { status: "added" | "already" | "limit" } or { error: "email" | "domain" }
//   POST /api/notify/stop     { code }         the stop link (also one-click from mail apps) -> { stopped: true }
//   (owner, through server/admin.js) notifySummary (who's waiting, addresses included) and sendItsHere
//
// There's no "is this you?" email. Instead the address is checked on the spot: it has to look like an email, and
// the part after the @ has to be a real domain that takes mail (asked of the internet's address book, DNS). That
// catches typos like "gmial.com" and made-up domains. It can't tell whose address it is, so someone could put a
// friend's address down: the friend gets one "it's here" email, with a stop link. The browser also offers
// "did you mean ...@gmail.com?" for common slips before anything is sent.
//
// Firestore, server only. "<mode>" is the Square mode, so practising never touches the real list:
//   notify_<mode>/{slug}_{who}    { slug, email, who, createdAt }
//                                 who = the email scrambled (HMAC), so one address is on a pin's list once
//   notify_ips_<mode>/{h}         sign-ups from one connection on one day (scrambled with the day, like the votes)
// Rules that keep this from being used to bother people:
//   - at most SIGNUPS_PER_DAY sign-ups a day from one connection
//   - nothing is ever sent at sign-up. "it's here" goes out only when the owner presses send, once per address per pin

import { configured, firestoreGet, firestoreSet, firestoreQuery, firestoreCommit } from './firebase.js';
import { squareMode } from './square.js';
import { readAvailability, isAvailable, scramble } from './interest.js';
import { readShopSwitch } from './shop.js';
import { emailConfigured, emailsLeftToday, sentToday, dailyLimit, sendBatch, escapeHtml } from './email.js';

export const SIGNUPS_PER_DAY = 5;
const BATCH = 100;
const DNS = 'https://cloudflare-dns.com/dns-query';

function list(env) { return 'notify_' + squareMode(env); }
function ips(env) { return 'notify_ips_' + squareMode(env); }

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

export function cleanEmail(s) {
  if (typeof s !== 'string') return null;
  const e = s.trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@<>()",;:\\]+@[^\s@<>()",;:\\]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

// Does this domain take email? Asks Cloudflare's public DNS (1.1.1.1), which is free and needs no key.
// true: it has mail servers (or, the old way, just an address). false: no such domain, or it says "no mail here".
// null: we couldn't ask just now. Then the sign-up goes through: a hiccup on our side shouldn't turn anyone away.
async function lookup(name, type, fetchFn) {
  const res = await fetchFn(DNS + '?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { Accept: 'application/dns-json' } });
  if (!res.ok) throw new Error('dns ' + res.status);
  return res.json();
}
export async function domainTakesMail(domain, fetchFn = fetch) {
  try {
    const mx = await lookup(domain, 'MX', fetchFn);
    if (mx.Status === 3) return false; // NXDOMAIN: there's no such domain
    if (mx.Status !== 0) return null;
    const servers = (mx.Answer || []).filter((a) => a.type === 15).map((a) => String(a.data).trim());
    if (servers.length) return !servers.every((d) => /^\d+\s+\.$/.test(d)); // "0 ." means "this domain takes no mail"
    // no mail servers listed: mail can still go to the domain's own address, if it has one
    const a = await lookup(domain, 'A', fetchFn);
    return a.Status === 0 && (a.Answer || []).some((x) => x.type === 1);
  } catch (e) {
    console.log('dns lookup failed', e.message);
    return null;
  }
}

async function products(env, origin) {
  const res = await env.ASSETS.fetch(new Request(new URL('/products.json', origin)));
  if (!res.ok) throw new Error('products.json ' + res.status);
  return (await res.json()).items || [];
}
// "the corgi pin", "the bay area pin board"
export function productNoun(p) {
  const name = p.slug === 'golden' ? 'goldie' : p.name;
  return p.kind === 'board' ? name : name + ' pin';
}
// where a product lives on the site
export function productPath(p) {
  if (p.kind === 'board') return p.slug === 'bay-area-pin-board' ? '/bay-area-pin-board' : '/pin-boards';
  if (p.series === 'pup-club') return '/pup-club/' + encodeURIComponent(p.slug);
  return { hometown: '/hometown-series', zodiac: '/chinese-zodiac' }[p.series] || '/shop';
}

/* ---------- the words, and how the email looks ---------- */
// The pictures are PNG copies kept for email in site/assets/img/email/ (logo.png and one per product slug),
// because many mail apps (Gmail among them) don't show the site's SVG logo or WebP pictures. They're linked by
// web address, not attached: lighter, less spam-like, and Resend doesn't allow attachments in a batch send.
export function emailImages(origin) {
  return { logo: origin + '/assets/img/email/logo.png', product: (slug) => origin + '/assets/img/email/' + slug + '.png' };
}
// is there an email picture for this product? (a new pin may not have one yet: then the email simply goes without)
async function hasPicture(env, origin, slug) {
  try { return (await env.ASSETS.fetch(new Request(origin + '/assets/img/email/' + encodeURIComponent(slug) + '.png'))).ok; } catch (e) { return false; }
}

// Colors are the site's tokens written out, because mail apps can't read css variables:
// --accent #bf5249 (balloon-500), --on-accent #ffffff, --ink #3a3532, --ink-muted #6a645e,
// --surface #f9f9f7 (cream-50), --surface-paper #efe6dd (parchment), --cobalt #10407b.
// The exclamation marks are the owner's call for this one email (docs/brand-voice.md): it's good news.
export function itsHereEmail(p, link, stop, pictures) {
  const noun = productNoun(p);
  const name = p.slug === 'golden' ? 'goldie' : p.name;
  const subject = 'the ' + noun + ' is here!';
  const text = "it's here!\n\n" +
    'the ' + noun + " you've been waiting for just landed in the shop. we're so happy to finally share it with you.\n\n" +
    'go see it: ' + link + '\n\n' +
    'thank you for cheering this one on. it means a lot to us.\n\n' +
    'see you in the shop,\nj+k adventures\nourjkadventures.com\n\n' +
    "you're getting this one email because you asked to hear when the " + noun + ' arrived. ' +
    "didn't ask, or want no more of these? stop them here: " + stop;
  const e = escapeHtml;
  const font = "Georgia,'EB Garamond','Times New Roman',serif";
  const logo = pictures && pictures.logo
    ? '<a href="' + e(link.split('/').slice(0, 3).join('/')) + '/" style="text-decoration:none"><img src="' + e(pictures.logo) +
      '" width="180" height="99" alt="j+k adventures" style="display:block;margin:0 auto;border:0;width:180px;height:auto"></a>'
    : '<p style="margin:0;font-family:' + font + ';font-size:24px;color:#3a3532;text-align:center">j+k adventures</p>';
  const pin = pictures && pictures.product
    ? '<tr><td align="center" style="padding:8px 24px 8px"><a href="' + e(link) + '"><img src="' + e(pictures.product) +
      '" width="240" alt="the ' + e(noun) + '" style="display:block;margin:0 auto;border:0;width:240px;max-width:100%;height:auto"></a></td></tr>'
    : '';
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>' + e(subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#efe6dd">' +
    // the hidden line some mail apps show next to the subject in the inbox
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">the ' + e(noun) + " you've been waiting for just landed in the shop.</div>" +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#efe6dd"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#f9f9f7;border-radius:16px">' +
    '<tr><td style="padding:28px 24px 8px">' + logo + '</td></tr>' +
    '<tr><td style="padding:16px 24px 0;font-family:' + font + ';color:#3a3532;text-align:center">' +
      '<p style="margin:0;font-size:34px;line-height:40px">it\'s here!</p>' +
      '<p style="margin:12px 0 0;font-size:18px;line-height:27px">the ' + e(noun) + " you've been waiting for just landed in the shop. we're so happy to finally share it with you.</p>" +
    '</td></tr>' +
    pin +
    '<tr><td align="center" style="padding:16px 24px 8px">' +
      '<a href="' + e(link) + '" style="display:inline-block;padding:14px 28px;background:#bf5249;color:#ffffff;font-family:' + font +
      ';font-size:18px;line-height:22px;text-decoration:none;border-radius:999px">go see the ' + e(name) + '</a>' +
    '</td></tr>' +
    '<tr><td style="padding:16px 24px 28px;font-family:' + font + ';font-size:17px;line-height:26px;color:#3a3532;text-align:center">' +
      '<p style="margin:0">thank you for cheering this one on. it means a lot to us.</p>' +
      '<p style="margin:16px 0 0">see you in the shop,<br>j+k adventures</p>' +
    '</td></tr>' +
    '</table>' +
    '<p style="max-width:520px;margin:16px auto 0;font-family:' + font + ';font-size:13px;line-height:19px;color:#6a645e;text-align:center">' +
      "you're getting this one email because you asked to hear when the " + e(noun) + ' arrived. ' +
      "didn't ask, or want no more of these? " + '<a href="' + e(stop) + '" style="color:#10407b">stop them here</a>.' +
    '</p>' +
    '</td></tr></table></body></html>';
  return { subject, text, html };
}

// the stop link proves we made it (an HMAC of the scrambled address), so it needs nothing stored and can't be guessed
async function stopCode(env, who) { return who + '.' + (await scramble(env, 'stop|' + who)); }
function stopLink(origin, code) { return origin + '/email.html?stop=' + code; }

/* ---------- the public side ---------- */
export async function notifyRoute(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!configured(env)) return json({ error: 'not configured' }, 503);
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) return json({ error: 'origin' }, 403);

  let body = {};
  const type = request.headers.get('Content-Type') || '';
  if (type.includes('application/json')) { try { body = (await request.json()) || {}; } catch (e) {} }
  const route = url.pathname.replace(/^\/api\/notify\/?/, '');

  try {
    // mail apps' one-click button posts a form with the code in the link itself
    if (route === 'stop') return json(...(await stop(env, body.code || url.searchParams.get('code'), fetchFn)));
    if (route !== '') return json({ error: 'not found' }, 404);
    if (!emailConfigured(env)) return json({ error: 'email not set up' }, 503);
    return json(...(await signUp(env, request, body, fetchFn)));
  } catch (e) {
    console.log('notify error', e.message);
    return json({ error: 'unavailable' }, 503);
  }
}

async function signUp(env, request, body, fetchFn) {
  const email = cleanEmail(body.email);
  if (!email) return [{ error: 'email' }, 400];
  const p = typeof body.slug === 'string' && (await products(env, request.url)).find((x) => x.slug === body.slug);
  if (!p) return [{ error: 'slug' }, 400];
  // only for products that aren't here yet
  if (isAvailable(await readAvailability(env, fetchFn), p.slug)) return [{ error: 'available' }, 409];

  const who = await scramble(env, 'email|' + email);
  const path = list(env) + '/' + encodeURIComponent(p.slug + '_' + who);
  if (await firestoreGet(env, path, fetchFn)) return [{ status: 'already' }];

  const day = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const ipPath = ips(env) + '/' + (await scramble(env, 'notify-ip|' + day + '|' + ip));
  const fromHere = await firestoreGet(env, ipPath, fetchFn);
  if (fromHere && fromHere.count >= SIGNUPS_PER_DAY) return [{ status: 'limit' }];

  // an ordinary answer, not an error: a mistyped email isn't a broken request
  if ((await domainTakesMail(email.split('@')[1], fetchFn)) === false) return [{ error: 'domain' }];

  await firestoreSet(env, path, { slug: p.slug, email, who, createdAt: new Date() }, fetchFn);
  await firestoreCommit(env, [{ add: ipPath, field: 'count', data: { day } }], fetchFn);
  return [{ status: 'added' }];
}

async function stop(env, code, fetchFn) {
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(typeof code === 'string' ? code : '');
  if (!m || (await stopCode(env, m[1])) !== code) return [{ stopped: false }, 400];
  const mine = await firestoreQuery(env, list(env), { who: m[1] }, 100, fetchFn);
  if (mine.length) await firestoreCommit(env, mine.map((d) => ({ remove: list(env) + '/' + encodeURIComponent(d.id), any: true })), fetchFn);
  return [{ stopped: true }];
}

/* ---------- the owner's side (server/admin.js has already checked who is asking) ---------- */
// who is waiting for what, today's email count, and a preview of each "it's here" email
export async function notifySummary(env, origin, fetchFn = fetch) {
  const items = await products(env, origin);
  const availability = await readAvailability(env, fetchFn);
  const rows = {};
  // who's on each list, oldest sign-up first. only ever sent to the owner (server/admin.js checks first)
  const people = {};
  for (const d of await firestoreQuery(env, list(env), {}, 5000, fetchFn)) {
    rows[d.slug] = (rows[d.slug] || 0) + 1;
    (people[d.slug] = people[d.slug] || []).push({ email: d.email, at: d.createdAt || '' });
  }
  for (const l of Object.values(people)) l.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const pics = emailImages(origin);
  const out = [];
  for (const p of items.filter((x) => rows[x.slug])) {
    const pictures = { logo: pics.logo, product: (await hasPicture(env, origin, p.slug)) ? pics.product(p.slug) : null };
    const preview = itsHereEmail(p, origin + productPath(p), origin + '/email.html?stop=...', pictures);
    out.push({ slug: p.slug, name: productNoun(p), available: isAvailable(availability, p.slug), waiting: rows[p.slug], people: people[p.slug], preview });
  }
  out.sort((a, b) => b.waiting - a.waiting);
  return {
    configured: emailConfigured(env),
    limit: dailyLimit(env),
    sentToday: await sentToday(env, fetchFn),
    products: out
  };
}

// one press of "send": up to today's allowance (and 100 at a time). sent slips are thrown away
export async function sendItsHere(env, origin, slug, fetchFn = fetch) {
  if (!emailConfigured(env)) return { error: 'email not set up', status: 503 };
  const p = (await products(env, origin)).find((x) => x.slug === slug);
  if (!p) return { error: 'unknown product' };
  // "it's in the shop now" has to be true when it lands
  if (!isAvailable(await readAvailability(env, fetchFn), slug)) return { error: 'not available' };
  if (!(await readShopSwitch(env, fetchFn)).open) return { error: 'shop closed' };

  const waiting = await firestoreQuery(env, list(env), { slug }, 5000, fetchFn);
  const room = Math.min(BATCH, await emailsLeftToday(env, fetchFn));
  const now = waiting.slice(0, room);
  if (!now.length) return { sent: 0, left: waiting.length, full: waiting.length > 0 };

  const link = origin + productPath(p);
  const pics = emailImages(origin);
  const pictures = { logo: pics.logo, product: (await hasPicture(env, origin, slug)) ? pics.product(slug) : null };
  const messages = [];
  for (const d of now) {
    const stopUrl = stopLink(origin, await stopCode(env, d.who));
    messages.push({ to: d.email, ...itsHereEmail(p, link, stopUrl, pictures), unsubscribe: origin + '/api/notify/stop?code=' + (await stopCode(env, d.who)) });
  }
  // the same people for the same pin on the same day: a second press after a hiccup isn't sent twice
  const key = 'its-here-' + slug + '-' + (await scramble(env, now.map((d) => d.id).sort().join(','))).slice(0, 24);
  await sendBatch(env, messages, key, fetchFn);
  await firestoreCommit(env, now.map((d) => ({ remove: list(env) + '/' + encodeURIComponent(d.id), any: true })), fetchFn);
  return { sent: now.length, left: waiting.length - now.length };
}
