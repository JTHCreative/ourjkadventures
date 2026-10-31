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
function sizeLabel(p) {
  const name = p.slug === 'golden' ? 'goldie' : p.name;
  if (p.kind === 'board') return name;
  return name + ', ' + p.size;
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
  mode.textContent = data.mode === 'sandbox' ? 'connected to square sandbox, the practice account.' : 'connected to your square account.';
  if (!data.square) {
    form.hidden = true;
    note.textContent = data.squareError === 'permission'
      ? 'square said no. the access token in cloudflare needs permission to read items and inventory. see docs/setup/square.md.'
      : data.squareError === 'not configured'
        ? 'square is not set up yet. see docs/setup/square.md.'
        : 'we could not reach square just now. try again in a moment.';
    return;
  }
  note.textContent = data.square.length
    ? 'pick the square item for each one. anything left unlinked shows as sold out.'
    : 'square has no items at this location yet. add them in your square item library, then come back.';
  const list = $('[data-link-list]');
  list.textContent = '';
  data.products.forEach((p) => {
    const row = el('div', 'link-row');
    const id = 'link-' + p.key.replace(':', '-');
    const lab = el('label', 'link-name', sizeLabel(p));
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
    list.appendChild(row);
  });
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
    } catch (err) {
      saved.textContent = err.data && err.data.error === 'used twice'
        ? 'one square item is picked for two products. each square item can stand behind only one.'
        : "that didn't save. try again in a moment.";
    }
    btn.disabled = false;
  });
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
  loadReviews();
}

(async function start() {
  user = await signedInUser();
  if (!user) showSignIn();
  else open();
})();
