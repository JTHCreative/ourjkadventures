/* j+k adventures: the owner's page (/admin). Sign in with google, then the server decides whether you are the owner
   (ADMIN_EMAILS in Cloudflare). This page only shows what the server agrees to; every change goes through /api/admin,
   which checks the sign-in again each time. Anyone else sees one line: "this page is for the shop owner." */
import { signedInUser, signInWithGoogle, signOutHere, friendlyError } from './account.js';

const $ = (sel) => document.querySelector(sel);
const NOT_OWNER = 'this page is for the shop owner.';
const RESTING = 'we could not reach the server just now. try again in a moment.';

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function money(cents) { return '$' + (cents / 100).toFixed(2); }

let user = null;
async function api(method, path, body) {
  const token = await user.getIdToken();
  const headers = { Authorization: 'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'admin ' + res.status); e.status = res.status; e.data = data; throw e; }
  return data;
}

function gate(text) {
  const g = $('#admin-gate');
  g.textContent = text;
  g.hidden = !text;
}

/* ---------- the shop switch ---------- */
function paintShop(state) {
  const sw = $('[data-shop-switch]');
  sw.setAttribute('aria-checked', state.open ? 'true' : 'false');
  sw.disabled = false;
  $('[data-shop-state]').textContent = state.open ? 'the shop is open.' : 'the shop is closed.';
}
function wireShop(state) {
  const sw = $('[data-shop-switch]');
  paintShop(state);
  sw.addEventListener('click', async () => {
    const want = sw.getAttribute('aria-checked') !== 'true';
    sw.disabled = true;
    sw.setAttribute('aria-checked', want ? 'true' : 'false');
    $('[data-shop-state]').textContent = 'saving.';
    try {
      const saved = await api('POST', '/api/admin/shop', { open: want });
      paintShop(saved);
      $('[data-shop-state]').textContent += ' saved.';
    } catch (e) {
      paintShop({ open: !want });
      $('[data-shop-state]').textContent = "that didn't save. the shop is still " + (want ? 'closed.' : 'open.') + ' try again in a moment.';
    }
  });
}

/* ---------- products: which square item is which website product ---------- */
// the pin sets, in the order the owner sees them. "series" in products.json says which set a pin is in
const SERIES = [
  { id: 'pup-club', title: 'pup club' },
  { id: 'hometown', title: 'hometown series' },
  { id: 'zodiac', title: 'chinese zodiac' }
];
function shownName(p) { return p.slug === 'golden' ? 'goldie' : p.name; }
// "1 person is interested." / "4 people are interested."
function peopleWords(n) { return !n ? 'no one has asked yet.' : n === 1 ? '1 person is interested.' : n + ' people are interested.'; }
// the line under each product's name: what the switch means for it right now, and its tally
function availableWords(on, n) {
  if (on) return n ? 'in the shop. ' + (n === 1 ? '1 person' : n + ' people') + ' asked for it before it arrived.' : 'in the shop.';
  return 'not in the shop. shows "i\'m interested". ' + peopleWords(n || 0);
}
function optionLabel(s) {
  const bits = [s.label, s.price_cents === null ? 'no fixed price' : money(s.price_cents)];
  bits.push(s.tracked ? s.stock + ' in stock' : 'stock not tracked');
  return bits.join(' · ');
}

function paintProducts(data) {
  const mode = $('[data-products-mode]');
  const note = $('[data-products-note]');
  const form = $('[data-products-form]');
  const available = data.available || {};
  const interest = data.interest || {};
  paintInterest(data);
  mode.textContent = data.mode === 'sandbox' ? 'connected to square sandbox, the practice account.' : 'connected to your square account.';
  // without square there is nothing to link, but the available switches still work
  const linking = !!data.square;
  form.querySelector('.admin-actions').hidden = !linking;
  if (!linking) {
    note.textContent = data.squareError === 'permission'
      ? 'square said no. the access token in cloudflare needs permission to read items and inventory. see docs/setup/square.md.'
      : data.squareError === 'not configured'
        ? 'square is not set up yet. see docs/setup/square.md.'
        : 'we could not reach square just now. try again in a moment.';
  } else note.textContent = data.square.length
    ? 'pick the square item for each one. anything left unlinked shows as sold out.'
    : 'square has no items at this location yet. add them in your square item library, then come back.';
  const list = $('[data-link-list]');
  // keep whichever groups were open, so saving doesn't fold everything shut
  const wasOpen = new Set([...list.querySelectorAll('details[open]')].map((d) => d.dataset.group));
  list.textContent = '';
  const linkRow = (p, only) => {
    const row = el('div', 'link-row');
    const id = 'link-' + p.key.replace(':', '-');
    // the name is said to screen readers, the size (or "square item") is what shows
    const lab = el('label', 'link-name');
    lab.append(el('span', 'sr-only', shownName(p) + ', '), only ? 'square item' : p.size);
    lab.htmlFor = id;
    const sel = el('select');
    sel.id = id;
    sel.name = p.key;
    sel.appendChild(new Option('not linked', ''));
    data.square.forEach((s) => sel.appendChild(new Option(optionLabel(s), s.id)));
    sel.value = data.links[p.key] || '';
    // a link to an item that has since left square shows as not linked, and saving clears it
    if (sel.value !== (data.links[p.key] || '')) sel.value = '';
    row.append(lab, sel);
    return row;
  };
  // one product: its name, the available switch, what that means right now, then a square link per size
  const productBlock = (keys) => {
    const p = keys[0];
    const box = el('div', 'link-product');
    const head = el('div', 'link-product-head');
    const name = el('span', 'link-product-name', shownName(p));
    const sw = el('button', 'switch switch--sm');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', shownName(p) + ' available');
    sw.appendChild(el('span', 'switch-knob'));
    sw.firstChild.setAttribute('aria-hidden', 'true');
    const swWord = el('span', 'caption', 'available');
    swWord.setAttribute('aria-hidden', 'true');
    const swWrap = el('span', 'link-product-switch');
    swWrap.append(swWord, sw);
    head.append(name, swWrap);
    const words = el('p', 'caption link-product-note');
    words.setAttribute('role', 'status');
    let on = available[p.slug] !== false;
    const show = (extra) => {
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
      box.classList.toggle('is-unavailable', !on);
      words.textContent = availableWords(on, interest[p.slug] || 0) + (extra ? ' ' + extra : '');
      // the heading's "n not available" count listens for this
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };
    show();
    // saves at once, like the shop switch, and leaves any square picks not yet saved alone
    sw.addEventListener('click', async () => {
      const want = !on;
      sw.disabled = true;
      words.textContent = 'saving.';
      try {
        await api('POST', '/api/admin/availability', { slug: p.slug, available: want });
        on = want;
        available[p.slug] = want;
        show('saved.');
        paintInterest(data);
        // in or out of the shop changes what can be featured
        loadFeatured();
      } catch (e) {
        show("that didn't save. try again in a moment.");
      }
      sw.disabled = false;
    });
    box.append(head, words);
    if (linking) keys.forEach((k) => box.appendChild(linkRow(k, keys.length === 1)));
    return box;
  };
  const productBlocks = (rows, body) => {
    const bySlug = new Map();
    rows.forEach((k) => { if (!bySlug.has(k.slug)) bySlug.set(k.slug, []); bySlug.get(k.slug).push(k); });
    bySlug.forEach((keys) => body.appendChild(productBlock(keys)));
  };
  // a fold-out box: click its heading to open or close it. the heading says how many are linked
  const group = (id, cls, title, rows, empty) => {
    const box = el('details', cls);
    box.dataset.group = id;
    if (wasOpen.has(id)) box.open = true;
    const sum = el('summary', cls + '-title');
    const count = el('span', 'link-count');
    sum.append(el('span', null, title), count);
    box.appendChild(sum);
    const body = el('div', 'link-body');
    if (rows.length) productBlocks(rows, body);
    else body.appendChild(el('p', 'caption', empty));
    box.appendChild(body);
    const recount = () => {
      const sels = [...body.querySelectorAll('select')];
      const off = body.querySelectorAll('.link-product.is-unavailable').length;
      const bits = [];
      if (sels.length) bits.push(sels.filter((s) => s.value).length + ' of ' + sels.length + ' linked');
      if (off) bits.push(off + ' not available');
      count.textContent = bits.join(' · ');
    };
    body.addEventListener('change', recount);
    recount();
    return { box, body };
  };
  // pins, by series (any series not named here lands in "other pins"), then pin boards
  const pins = data.products.filter((p) => p.kind === 'pin');
  const pinGroup = group('pins', 'link-group', 'pins', pins, 'no pins yet.');
  // inside "pins", one fold-out per set instead of one long list
  pinGroup.body.textContent = '';
  const known = SERIES.map((s) => s.id);
  SERIES.forEach((s) => {
    pinGroup.body.appendChild(group('series-' + s.id, 'link-series', s.title, pins.filter((p) => p.series === s.id), 'no pins in this set yet.').box);
  });
  const other = pins.filter((p) => !known.includes(p.series));
  if (other.length) pinGroup.body.appendChild(group('series-other', 'link-series', 'other pins', other, '').box);
  list.appendChild(pinGroup.box);
  list.appendChild(group('boards', 'link-group', 'pin boards', data.products.filter((p) => p.kind === 'board'), 'no pin boards yet.').box);
  // anything that is neither a pin nor a board still gets a row, so nothing goes missing
  const rest = data.products.filter((p) => p.kind !== 'pin' && p.kind !== 'board');
  if (rest.length) list.appendChild(group('rest', 'link-group', 'everything else', rest, '').box);
  form.hidden = false;
}

function wireProducts() {
  const form = $('[data-products-form]');
  const saved = $('[data-products-saved]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const links = {};
    form.querySelectorAll('select').forEach((s) => { links[s.name] = s.value; });
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    saved.textContent = 'saving.';
    try {
      paintProducts(await api('POST', '/api/admin/products', { links }));
      saved.textContent = 'saved. the shop shows it within a minute.';
      // a new link changes what's in stock, and so what can be featured
      loadFeatured();
    } catch (err) {
      saved.textContent = err.data && err.data.error === 'used twice'
        ? 'one square item is picked for two products. each square item can stand behind only one.'
        : "that didn't save. try again in a moment.";
    }
    btn.disabled = false;
  });
}

/* ---------- interest: what people asked for with "i'm interested" ---------- */
// every product with at least one vote, most asked for first. products in the shop keep their old tally here
function paintInterest(data) {
  const box = $('[data-interest-list]');
  const names = {};
  data.products.forEach((p) => { names[p.slug] = shownName(p); });
  const rows = Object.entries(data.interest || {}).filter(([slug, n]) => names[slug] && n > 0).sort((a, b) => b[1] - a[1]);
  box.textContent = '';
  if (!rows.length) {
    box.appendChild(el('p', 'body-sm muted', 'no one has asked for anything yet. switch a product to not available and its "i\'m interested" button appears in the shop.'));
    return;
  }
  const list = el('ol', 'interest-admin');
  rows.forEach(([slug, n]) => {
    const li = el('li', null);
    li.append(el('span', 'feature-name', names[slug]), el('span', 'caption', peopleWords(n) + ((data.available || {})[slug] === false ? '' : ' in the shop now.')));
    list.appendChild(li);
  });
  box.appendChild(list);
}

/* ---------- featured: what turns in the carousel at the top of the shop ---------- */
// picks keep the order they were ticked in, which is the order they stand on the ring
let picks = [];
let featuredMax = 8;

function stockWords(p, picked) {
  if (p.available === false) return 'not available';
  if (!p.linked) return 'not linked to square';
  if (p.stock > 0) return p.stock + ' in stock';
  return picked ? "sold out, hidden from the carousel until it's back" : 'sold out';
}

function paintFeatured(data) {
  const note = $('[data-featured-note]');
  const form = $('[data-featured-form]');
  featuredMax = data.max || 8;
  if (!data.stockKnown) {
    form.hidden = true;
    note.textContent = 'we could not read the stock from square just now, so nothing can be picked. try again in a moment.';
    return;
  }
  const known = new Set(data.products.map((p) => p.slug));
  picks = (data.featured || []).filter((s) => known.has(s));
  note.textContent = '';
  const list = $('[data-feature-list]');
  list.textContent = '';
  const rows = [];
  const section = (title, items) => {
    if (!items.length) return;
    list.appendChild(el('p', 'link-series-title feature-head', title));
    items.forEach((p) => {
      const row = el('label', 'feature-row');
      const box = el('input');
      box.type = 'checkbox';
      box.value = p.slug;
      box.checked = picks.includes(p.slug);
      const order = el('span', 'feature-order');
      order.setAttribute('aria-hidden', 'true');
      const words = el('span', 'feature-words');
      const name = el('span', 'feature-name', p.slug === 'golden' ? 'goldie' : p.name);
      const stock = el('span', 'caption');
      words.append(name, stock);
      row.append(box, order, words);
      list.appendChild(row);
      rows.push({ p, box, order, stock });
      box.addEventListener('change', () => {
        picks = box.checked ? picks.concat(p.slug) : picks.filter((s) => s !== p.slug);
        $('[data-featured-saved]').textContent = '';
        refresh();
      });
    });
  };
  // every product, grouped the same way as the square links above
  SERIES.forEach((s) => section(s.title, data.products.filter((p) => p.kind === 'pin' && p.series === s.id)));
  section('other pins', data.products.filter((p) => p.kind === 'pin' && !SERIES.some((s) => s.id === p.series)));
  section('pin boards', data.products.filter((p) => p.kind === 'board'));
  section('everything else', data.products.filter((p) => p.kind !== 'pin' && p.kind !== 'board'));

  function refresh() {
    const full = picks.length >= featuredMax;
    rows.forEach(({ p, box, order, stock }) => {
      const picked = picks.includes(p.slug);
      // a sold-out pick can be unticked, never newly ticked; when eight are picked the rest wait
      box.disabled = !picked && (p.stock <= 0 || full);
      order.textContent = picked ? String(picks.indexOf(p.slug) + 1) : '';
      stock.textContent = stockWords(p, picked);
      box.closest('.feature-row').classList.toggle('is-off', box.disabled);
    });
    $('[data-featured-count]').textContent = picks.length + ' of ' + featuredMax + ' picked.';
  }
  refresh();
  form.hidden = false;
}

function wireFeatured() {
  const form = $('[data-featured-form]');
  const saved = $('[data-featured-saved]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    saved.textContent = 'saving.';
    try {
      paintFeatured(await api('POST', '/api/admin/featured', { slugs: picks }));
      saved.textContent = 'saved. the shop shows it within a minute.';
    } catch (err) {
      const why = err.data && err.data.error;
      saved.textContent = why === 'sold out'
        ? 'one of those just sold out, so it could not be picked. the list has been refreshed.'
        : why === 'too many' ? 'eight is the most the carousel holds.' : "that didn't save. try again in a moment.";
      if (why === 'sold out') loadFeatured();
    }
    btn.disabled = false;
  });
}

async function loadFeatured() {
  try { paintFeatured(await api('GET', '/api/admin/featured')); } catch (e) {
    $('[data-featured-form]').hidden = true;
    $('[data-featured-note]').textContent = RESTING;
  }
}

async function loadProducts() {
  try { paintProducts(await api('GET', '/api/admin/products')); } catch (e) {
    $('[data-products-note]').textContent = RESTING;
  }
}

/* ---------- reviews waiting for a look ---------- */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
function dateText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) + ', ' + m[1] : '';
}
function pinName(slug) { return (slug === 'golden' ? 'goldie' : slug.replace(/-/g, ' ')) + ' pin'; }

function paintReviews(list) {
  const box = $('[data-review-list]');
  box.textContent = '';
  if (!list.length) { box.appendChild(el('p', 'body-sm muted', 'no reviews waiting. all caught up.')); return; }
  list.forEach((r) => {
    const item = el('article', 'admin-review');
    const stars = el('p', 'admin-review-stars', '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating));
    stars.setAttribute('aria-label', r.rating + ' out of 5 stars');
    item.append(el('p', 'admin-review-pin', pinName(r.slug)), stars);
    item.appendChild(el('p', 'review-text', r.text || '(stars only, no words.)'));
    item.appendChild(el('p', 'caption', r.name + (dateText(r.date) ? ', ' + dateText(r.date) : '') + '.'));
    const row = el('div', 'admin-actions');
    const note = el('span', 'caption');
    note.setAttribute('role', 'status');
    const decide = (status, word) => {
      const b = el('button', status === 'approved' ? 'jka-btn jka-btn--sm' : 'jka-btn jka-btn--quiet jka-btn--sm', word);
      b.type = 'button';
      b.setAttribute('aria-label', word + ' the review of the ' + pinName(r.slug) + ' by ' + r.name);
      b.addEventListener('click', async () => {
        row.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        try {
          await api('POST', '/api/admin/reviews', { id: r.id, status });
          row.textContent = '';
          row.appendChild(el('span', 'caption', status === 'approved' ? 'approved. it shows on the pin within ten minutes.' : 'hidden. it will not show.'));
        } catch (e) {
          row.querySelectorAll('button').forEach((x) => { x.disabled = false; });
          note.textContent = "that didn't save. try again in a moment.";
        }
      });
      return b;
    };
    row.append(decide('approved', 'approve'), decide('hidden', 'hide'), note);
    item.appendChild(row);
    box.appendChild(item);
  });
}

async function loadReviews() {
  try { paintReviews((await api('GET', '/api/admin/reviews')).reviews || []); } catch (e) {
    $('[data-review-list]').textContent = RESTING;
  }
}

/* ---------- instagram: the account whose reels show on the about page ---------- */
function paintInstagram(s) {
  const state = $('[data-instagram-state]');
  const old = document.querySelector('[data-instagram-diagnostics]');
  if (old) old.remove();
  if (!s.configured) {
    state.textContent = 'instagram is not set up yet. the about page shows stand-in reels until it is. see docs/setup/instagram.md' +
      (s.missing && s.missing.length ? ' (still needed in cloudflare: ' + s.missing.join(', ') + ').' : '.');
    return;
  }
  if (!s.connected) {
    state.textContent = 'the key in cloudflare does not open @ourjkadventures (meta said: ' + (s.check_error || 'nothing') + '). see docs/setup/instagram.md.';
    // the answers to a few test questions, for working out why
    if (s.diagnostics && s.diagnostics.length) {
      const list = el('ul', 'caption');
      list.setAttribute('data-instagram-diagnostics', '');
      s.diagnostics.forEach((d) => list.appendChild(el('li', null, d)));
      state.after(list);
    }
    return;
  }
  const lines = ['connected as @' + (s.username || 'ourjkadventures') + ', with the key in cloudflare.'];
  if (s.reels_count !== null && s.reels_count !== undefined) {
    lines.push(s.reels_count === 1 ? 'one reel on the about page.' : s.reels_count + ' reels on the about page.');
  }
  if (s.last_error) lines.push('the last fetch did not work (meta said: ' + s.last_error + '). the about page keeps the last reels it saved, and tries again within 30 minutes.');
  state.textContent = lines.join(' ');
}

async function loadInstagram() {
  try { paintInstagram(await api('GET', '/api/admin/instagram')); } catch (e) { $('[data-instagram-state]').textContent = RESTING; }
}

/* ---------- start ---------- */
function showSignIn() {
  gate(NOT_OWNER);
  const box = $('#admin-signin');
  box.hidden = false;
  $('[data-admin-google]').addEventListener('click', async () => {
    $('[data-admin-signin-note]').textContent = '';
    try {
      user = await signInWithGoogle();
      box.hidden = true;
      await open();
    } catch (e) {
      $('[data-admin-signin-note]').textContent = friendlyError(e) || 'something went wrong. try again in a moment.';
    }
  });
}

async function open() {
  gate('one moment.');
  let me;
  try { me = await api('GET', '/api/admin'); } catch (e) {
    // signed in, but not the owner: one line and nothing else
    gate(e.status === 401 || e.status === 403 ? NOT_OWNER : RESTING);
    return;
  }
  gate('');
  $('[data-admin-who]').textContent = 'signed in as ' + me.email.toLowerCase() + '.';
  $('[data-admin-sign-out]').addEventListener('click', async () => {
    await signOutHere();
    location.href = 'index.html';
  });
  $('#admin-view').hidden = false;
  try { wireShop(await api('GET', '/api/admin/shop')); } catch (e) { $('[data-shop-state]').textContent = RESTING; }
  wireProducts();
  loadProducts();
  wireFeatured();
  loadFeatured();
  loadReviews();
  loadInstagram();
}

(async function start() {
  user = await signedInUser();
  if (!user) showSignIn();
  else open();
})();
