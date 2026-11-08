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
function availableWords(on, n, pre) {
  // pre-order wins over the available switch
  if (pre) return 'pre-order: shows "being made now. coming soon." and the email box. not for sale, no "i\'m interested".' + (n ? ' ' + peopleWords(n) : '');
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
  const preorder = data.preorder || {};
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
    // a small labelled switch, like the shop switch. saves at once and leaves any square picks not yet saved alone
    const makeSwitch = (word, label) => {
      const sw = el('button', 'switch switch--sm');
      sw.type = 'button';
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-label', shownName(p) + ' ' + label);
      sw.appendChild(el('span', 'switch-knob'));
      sw.firstChild.setAttribute('aria-hidden', 'true');
      const swWord = el('span', 'caption', word);
      swWord.setAttribute('aria-hidden', 'true');
      const wrap = el('span', 'link-product-switch');
      wrap.append(swWord, sw);
      return { sw, wrap };
    };
    const avail = makeSwitch('available', 'available');
    const pre = makeSwitch('pre-order', 'on pre-order');
    const switches = el('span', 'link-product-switches');
    switches.append(avail.wrap, pre.wrap);
    head.append(name, switches);
    const words = el('p', 'caption link-product-note');
    words.setAttribute('role', 'status');
    let on = available[p.slug] !== false;
    let preOn = preorder[p.slug] === true;
    const show = (extra) => {
      avail.sw.setAttribute('aria-checked', on ? 'true' : 'false');
      pre.sw.setAttribute('aria-checked', preOn ? 'true' : 'false');
      box.classList.toggle('is-unavailable', !on && !preOn);
      box.classList.toggle('is-preorder', preOn);
      words.textContent = availableWords(on, interest[p.slug] || 0, preOn) + (extra ? ' ' + extra : '');
      // the heading's "n not available" and "n on pre-order" counts listen for this
      box.dispatchEvent(new Event('change', { bubbles: true }));
    };
    show();
    const flip = async (path, field, want, done) => {
      avail.sw.disabled = true;
      pre.sw.disabled = true;
      words.textContent = 'saving.';
      try {
        await api('POST', path, { slug: p.slug, [field]: want });
        done();
        show('saved.');
        paintInterest(data);
        // in or out of the shop changes what can be featured, and what can be emailed about
        loadFeatured();
        loadNotify();
      } catch (e) {
        show("that didn't save. try again in a moment.");
      }
      avail.sw.disabled = false;
      pre.sw.disabled = false;
    };
    avail.sw.addEventListener('click', () => {
      const want = !on;
      flip('/api/admin/availability', 'available', want, () => { on = want; available[p.slug] = want; });
    });
    pre.sw.addEventListener('click', () => {
      const want = !preOn;
      flip('/api/admin/preorder', 'preorder', want, () => { preOn = want; preorder[p.slug] = want; });
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
      const pre = body.querySelectorAll('.link-product.is-preorder').length;
      if (pre) bits.push(pre + ' on pre-order');
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
    li.append(el('span', 'feature-name', names[slug]), el('span', 'caption', peopleWords(n) + ((data.preorder || {})[slug] ? ' on pre-order now.' : (data.available || {})[slug] === false ? '' : ' in the shop now.')));
    list.appendChild(li);
  });
  box.appendChild(list);
}

/* ---------- email when it's here ---------- */
function waitingWords(r) { return (r.waiting === 1 ? '1 person' : r.waiting + ' people') + ' waiting.'; }
// "nov 4"
function shortDate(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toLowerCase();
}

// who's on a product's list, folded away like the email preview: each address and the day they signed up,
// and one button to copy them all (one per line) to paste somewhere else
function whoIsWaiting(r) {
  const peek = el('details', 'notify-preview');
  peek.appendChild(el('summary', 'link-btn', 'see who\'s waiting'));
  const ul = el('ul', 'notify-people');
  (r.people || []).forEach((p) => {
    const li = el('li');
    li.append(el('span', 'notify-email', p.email), el('span', 'caption', shortDate(p.at)));
    ul.appendChild(li);
  });
  peek.appendChild(ul);
  const copy = el('button', 'jka-btn jka-btn--quiet jka-btn--sm', 'copy the addresses');
  copy.type = 'button';
  const said = el('span', 'caption');
  said.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText((r.people || []).map((p) => p.email).join('\n'));
      said.textContent = 'copied.';
    } catch (e) {
      said.textContent = 'your browser wouldn\'t copy. you can select them above instead.';
    }
  });
  const actions = el('div', 'admin-actions');
  actions.append(copy, said);
  peek.appendChild(actions);
  return peek;
}

function paintNotify(data, done) {
  const state = $('[data-notify-state]');
  const box = $('[data-notify-list]');
  box.textContent = '';
  if (!data.configured) {
    state.textContent = 'email isn\'t set up yet, so the shop doesn\'t offer it. see docs/setup/email.md.';
    return;
  }
  state.textContent = 'today: ' + data.sentToday + ' of ' + data.limit + ' emails sent. the count starts again at midnight (utc).';
  // a send that emptied its list: say so, since that product's row is gone now
  if (done && !data.products.some((r) => r.slug === done.slug)) box.appendChild(el('p', 'body-sm', done.words));
  if (!data.products.length) {
    box.appendChild(el('p', 'body-sm muted', 'no one is waiting for an email yet.'));
    return;
  }
  data.products.forEach((r) => {
    const row = el('div', 'link-product');
    row.appendChild(el('p', 'link-product-name', r.name));
    row.appendChild(el('p', 'caption', waitingWords(r)));
    const actions = el('div', 'admin-actions');
    const note = el('span', 'caption');
    note.setAttribute('role', 'status');
    if (r.preorder) {
      note.textContent = 'when it\'s here, switch pre-order off and available on above, then send.';
    } else if (!r.available) {
      note.textContent = 'switch it on above when it\'s here, then send.';
    } else if (r.waiting) {
      const send = el('button', 'jka-btn jka-btn--sm', 'send "it\'s here" to ' + r.waiting);
      send.type = 'button';
      send.addEventListener('click', async () => {
        if (!confirm('send "' + r.preview.subject + '" to ' + r.waiting + (r.waiting === 1 ? ' person' : ' people') + '?')) return;
        send.disabled = true;
        note.textContent = 'sending.';
        try {
          const res = await api('POST', '/api/admin/notify', { slug: r.slug });
          paintNotify(res, { slug: r.slug, words: res.left
            ? 'sent to ' + res.sent + '. ' + res.left + ' still waiting: that\'s today\'s emails used up, so press send again tomorrow.'
            : 'sent to ' + res.sent + '.' });
        } catch (e) {
          const why = e.data && e.data.error;
          note.textContent = why === 'shop closed' ? 'the shop is closed. open it first, so the link leads somewhere.'
            : why === 'not available' ? 'switch it on above first.' : "that didn't send. nothing went out. try again in a moment.";
          send.disabled = false;
        }
      });
      actions.appendChild(send);
    }
    if (done && done.slug === r.slug) note.textContent = done.words;
    actions.appendChild(note);
    row.appendChild(actions);
    if (r.people && r.people.length) row.appendChild(whoIsWaiting(r));
    // what they'll get, word for word
    const peek = el('details', 'notify-preview');
    peek.appendChild(el('summary', 'link-btn', 'see the email'));
    peek.appendChild(el('p', 'caption', 'subject: ' + r.preview.subject));
    // the real email, shown in a sealed-off frame: no scripts, nothing it can reach on this page
    const frame = el('iframe', 'notify-preview-frame');
    frame.setAttribute('sandbox', '');
    frame.title = 'the "it\'s here" email for the ' + r.name;
    frame.srcdoc = r.preview.html;
    peek.appendChild(frame);
    row.appendChild(peek);
    box.appendChild(row);
  });
}

async function loadNotify() {
  try { paintNotify(await api('GET', '/api/admin/notify')); } catch (e) { $('[data-notify-state]').textContent = RESTING; }
}

/* ---------- featured: what turns in the carousel at the top of the shop ---------- */
// picks keep the order they were ticked in, which is the order they stand on the ring
let picks = [];
let featuredMax = 8;

function stockWords(p, picked) {
  if (p.preorder) return 'on pre-order';
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

// a review's photos, fetched with the owner's ticket (they aren't public until approved). tap one to see it full size
function reviewPhotos(r) {
  const row = el('div', 'admin-review-photos');
  r.photos.forEach(async (ph, i) => {
    const link = el('a');
    link.target = '_blank';
    link.rel = 'noopener';
    const img = el('img');
    img.alt = 'photo ' + (i + 1) + ' of ' + r.photos.length + ' with the review by ' + r.name;
    img.width = 96;
    img.height = 96;
    link.appendChild(img);
    row.appendChild(link);
    try {
      const token = await user.getIdToken();
      const res = await fetch('/api/admin/photo?id=' + encodeURIComponent(ph.id), { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('photo ' + res.status);
      const url = URL.createObjectURL(await res.blob());
      img.src = url;
      link.href = url;
    } catch (e) { link.replaceWith(el('span', 'caption', "photo " + (i + 1) + " didn't load.")); }
  });
  return row;
}

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
    if (r.photos && r.photos.length) item.appendChild(reviewPhotos(r));
    item.appendChild(el('p', 'caption', r.name + (r.guest ? ' (a guest, no account)' : '') + (dateText(r.date) ? ', ' + dateText(r.date) : '') + '.'));
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
  if (s.last_error) lines.push('the last fetch did not work (meta said: ' + s.last_error + '). the about page keeps the last reels it saved, and tries again within 10 minutes.');
  // share counts need one extra permission on the key (docs/setup/instagram.md, step 4)
  if (Array.isArray(s.permissions)) {
    lines.push(s.permissions.includes('instagram_manage_insights')
      ? 'the key can read share counts.'
      : 'the key can\'t read share counts yet: it needs instagram_manage_insights (it has ' + (s.permissions.join(', ') || 'none') + ').');
  }
  if (s.shares_error) lines.push('the last time we asked for share counts, meta said: ' + s.shares_error + '.');
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
  loadNotify();
  loadReviews();
  loadInstagram();
}

(async function start() {
  user = await signedInUser();
  if (!user) showSignIn();
  else open();
})();
