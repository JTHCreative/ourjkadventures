/* j+k adventures: the cookie note and the Meta Pixel (docs/setup/meta-pixel.md, docs/decisions.md).

   Nothing here talks to Meta until the visitor says "sure" on the small note at the bottom of the page. Like a
   guest book at the booth: we only write someone in once they've said it's fine. Their answer is kept in their own
   browser (jka_cookie_choice: "yes" or "no"), and "cookie choices" in the footer brings the note back to change it.
   A browser that sends the "global privacy control" signal counts as "no thanks" without being asked.

   app.js and checkout.js drop events in a tray (window.jkaPixel); this file empties the tray once there's a yes:
     PageView          every public page
     ViewContent       a pup's page or the board's page opens
     AddToCart         "add to bag"
     InitiateCheckout  /checkout opens with something in the bag
     Purchase          the thank-you page, with the ticket number the server made when the card was charged
   Each event gets a ticket number (event_id). The same number goes to our server (/api/meta-event, server/meta.js),
   which tells Meta too, so an event seen twice is counted once.

   Never on the owner's page or the account pages (QUIET): some of those addresses carry one-time codes.
   An ad blocker that stops Meta's script changes nothing for the page: every call is guarded. */
import { META_PIXEL_ID } from './pixel-id.js';

var CHOICE = 'jka_cookie_choice';
var QUIET = /^\/(admin|sign-in|create-account|account|account-details|orders|reset-password|email)(\.html)?\/?$/;
var quiet = QUIET.test(location.pathname);
var SERVER_EVENTS = { ViewContent: true, AddToCart: true, InitiateCheckout: true };
var loaded = false;
var bar = null;

function readChoice() {
  try { var v = localStorage.getItem(CHOICE); return v === 'yes' || v === 'no' ? v : null; } catch (e) { return null; }
}
function saveChoice(v) { try { localStorage.setItem(CHOICE, v); } catch (e) {} }
// the browser's own "please don't" switch (global privacy control)
function askedNotTo() { try { return navigator.globalPrivacyControl === true; } catch (e) { return false; } }
function cookie(name) {
  try {
    var m = new RegExp('(?:^|; )' + name + '=([^;]*)').exec(document.cookie);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
}
function dropCookie(name) {
  var host = location.hostname.replace(/^www\./, '');
  try {
    document.cookie = name + '=; Max-Age=0; path=/';
    document.cookie = name + '=; Max-Age=0; path=/; domain=.' + host;
  } catch (e) {}
}
function newId() {
  try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
  return 'e' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}

/* ---------- meta's script ---------- */
function fbq() {
  try { if (typeof window.fbq === 'function') window.fbq.apply(null, arguments); } catch (e) {}
}
function load() {
  if (loaded || quiet) return;
  loaded = true;
  try {
    // meta's own starter, written out plainly: a stand-in fbq that keeps a list until their script arrives. if the
    // script never arrives (an ad blocker), the list just sits there
    if (!window.fbq) {
      var n = window.fbq = function () { if (n.callMethod) n.callMethod.apply(n, arguments); else n.queue.push(arguments); };
      if (!window._fbq) window._fbq = n;
      n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      var s = document.createElement('script');
      s.async = true;
      s.src = 'https://connect.facebook.net/en_US/fbevents.js';
      s.onerror = function () {};
      document.head.appendChild(s);
    }
    // only the events we send ourselves: no reading of buttons or page details on its own
    fbq('set', 'autoConfig', false, META_PIXEL_ID);
    fbq('init', META_PIXEL_ID);
    fbq('track', 'PageView', {}, { eventID: newId() });
  } catch (e) {}
}

/* ---------- events ---------- */
// what an event says about its products. prices here are only for the report: the server looks up its own
function details(items) {
  var cat = (window.JKA && window.JKA.catalog) || {};
  var byKey = cat.byKey || {};
  var out = { content_type: 'product', content_ids: [], contents: [] };
  var value = 0, priced = true, count = 0;
  items.forEach(function (it) {
    var qty = it.qty > 0 ? it.qty : 1;
    var entry = byKey[it.key];
    var c = { id: it.key, quantity: qty };
    if (entry && entry.size && entry.size.price_cents >= 0) { c.item_price = entry.size.price_cents / 100; value += entry.size.price_cents * qty; }
    else priced = false;
    out.content_ids.push(it.key);
    out.contents.push(c);
    count += qty;
  });
  if (items.length === 1) {
    var slug = String(items[0].key).split(':')[0];
    var p = (cat.items || {})[slug];
    if (p && p.name) out.content_name = p.name;
  }
  if (items.length > 1 || count > 1) out.num_items = count;
  if (priced && items.length) { out.value = value / 100; out.currency = cat.currency || 'USD'; }
  return out;
}
function tellServer(name, id, items) {
  try {
    fetch('/api/meta-event', {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, event_id: id, items: items, path: location.pathname, fbp: cookie('_fbp'), fbc: cookie('_fbc') })
    }).catch(function () {});
  } catch (e) {}
}
function send(ev) {
  if (!ev || typeof ev.name !== 'string' || !Array.isArray(ev.items) || !ev.items.length) return;
  var id = newId();
  fbq('track', ev.name, details(ev.items), { eventID: id });
  if (SERVER_EVENTS[ev.name]) tellServer(ev.name, id, ev.items);
}
// the thank-you page: the order the checkout page left a note about (sessionStorage, this tab only)
function purchase() {
  if (!/^\/thank-you(\.html)?$/.test(location.pathname)) return;
  var note = null;
  try {
    note = JSON.parse(sessionStorage.getItem('jka_purchase') || 'null');
    sessionStorage.removeItem('jka_purchase');
  } catch (e) {}
  if (!note || typeof note.event_id !== 'string' || !(note.value >= 0)) return;
  fbq('track', 'Purchase', {
    value: note.value, currency: note.currency || 'USD', content_type: 'product',
    content_ids: note.content_ids || [], contents: note.contents || [], num_items: note.num_items
  }, { eventID: note.event_id });
}

var tray = window.jkaPixel = window.jkaPixel || [];
function empty() {
  var choice = readChoice();
  if (quiet || choice === 'no' || (choice === null && askedNotTo())) { tray.length = 0; return; }
  if (choice !== 'yes') return;   // not answered yet: the tray keeps this page's events for a "sure"
  load();
  while (tray.length) { try { send(tray.shift()); } catch (e) {} }
  purchase();
}
tray.go = empty;
// the checkout page asks this before it pays: may the server tell meta about the order, and which browser is it
tray.info = function () {
  if (quiet || readChoice() !== 'yes') return null;
  return { consent: true, fbp: cookie('_fbp'), fbc: cookie('_fbc') };
};

/* ---------- the cookie note ---------- */
function answer(yes) {
  var was = readChoice();
  saveChoice(yes ? 'yes' : 'no');
  if (bar) { bar.remove(); bar = null; }
  if (yes) { empty(); return; }
  tray.length = 0;
  try { sessionStorage.removeItem('jka_purchase'); } catch (e) {}
  dropCookie('_fbp');
  dropCookie('_fbc');
  // meta's script can't be taken back out of an open page: a fresh page has none of it
  if (was === 'yes' && loaded) location.reload();
}
function showBar(focus) {
  if (bar) { if (focus) bar.querySelector('button').focus(); return; }
  bar = document.createElement('section');
  bar.className = 'cookie-note';
  bar.setAttribute('aria-label', 'cookies');
  var p = document.createElement('p');
  p.appendChild(document.createTextNode('hi! is it okay if we use a cookie to learn how folks find our little shop? '));
  var more = document.createElement('a');
  more.href = '/privacy#ads';
  more.textContent = 'more in privacy';
  p.appendChild(more);
  p.appendChild(document.createTextNode('.'));
  var row = document.createElement('div');
  row.className = 'cookie-note-row';
  var yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'jka-btn jka-btn--sm';
  yes.textContent = 'sure';
  yes.addEventListener('click', function () { answer(true); });
  var no = document.createElement('button');
  no.type = 'button';
  no.className = 'jka-btn jka-btn--quiet jka-btn--sm';
  no.textContent = 'no thanks';
  no.addEventListener('click', function () { answer(false); });
  row.appendChild(yes);
  row.appendChild(no);
  bar.appendChild(p);
  bar.appendChild(row);
  document.body.appendChild(bar);
  if (focus) yes.focus();
}
// "cookie choices" in every footer: the way back to the note
function footerLink() {
  var links = document.querySelector('.site-footer .links');
  if (!links || links.querySelector('[data-cookie-choices]')) return;
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'link-btn';
  b.setAttribute('data-cookie-choices', '');
  b.textContent = 'cookie choices';
  b.addEventListener('click', function () { showBar(true); });
  links.appendChild(b);
}

function start() {
  footerLink();
  var choice = readChoice();
  if (!quiet && choice === null && !askedNotTo()) showBar(false);
  empty();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
else start();
