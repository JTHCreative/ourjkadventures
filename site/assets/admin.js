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
const FULL_MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// "december 15", or "january 8, 2028" when it's not this year
function prettyDate(date, today) {
  const [y, m, d] = date.split('-');
  return FULL_MONTHS[Number(m) - 1] + ' ' + Number(d) + (y !== String(today || '').slice(0, 4) ? ', ' + y : '');
}
// what a pre-order says about when it ships: its date. without one (or once it passes) it isn't for sale
function preorderWhen(date, today) {
  if (date && date >= today) return 'expected in stock and shipping around ' + prettyDate(date, today);
  if (date) return 'but its date (' + prettyDate(date, today) + ') has passed, so it shows "being made now. coming soon." and can\'t be bought until you set a new one with the gear';
  return 'but it has no date yet, so it shows "being made now. coming soon." and can\'t be bought until you set one with the gear';
}
function availableWords(on, n, pre, date, today) {
  // pre-order wins over the available switch
  if (pre) return 'pre-order: for sale while the shop is open and it\'s linked, ' + preorderWhen(date, today) + '. a bag with it ships all together then. no stock limit, no "i\'m interested".' + (n ? ' ' + peopleWords(n) : '');
  if (on) return n ? 'in the shop. ' + (n === 1 ? '1 person' : n + ' people') + ' asked for it before it arrived.' : 'in the shop.';
  return 'not in the shop. shows "i\'m interested". ' + peopleWords(n || 0);
}
function optionLabel(s) {
  const bits = [s.label, s.price_cents === null ? 'no fixed price' : money(s.price_cents)];
  bits.push(s.tracked ? s.stock + ' in stock' : 'stock not tracked');
  return bits.join(' · ');
}

/* ---------- "pre-order settings": the date window, behind each product's gear and its pre-order switch ---------- */
// pre-order can't be on without a date. switching it on opens this window, and it only turns on once a date is
// saved (cancel leaves it off). with pre-order already on, the gear opens it to change the date; there's no
// "clear date". one native <dialog>, made the first time it's needed: it keeps the keyboard inside while open,
// closes on escape, and hands the keyboard back to whatever opened it
let settingsDialog = null;
function preorderSettings(p, name, on, date, today, opener, saved) {
  if (!settingsDialog) {
    settingsDialog = el('dialog', 'card clean settings-dialog');
    settingsDialog.setAttribute('aria-labelledby', 'settings-title');
    settingsDialog.innerHTML =
      '<form method="dialog" class="settings-form">' +
        '<h2 class="admin-title" id="settings-title"></h2>' +
        '<p class="caption" data-settings-state></p>' +
        '<div class="field"><label for="settings-date">expected in stock and shipping</label>' +
        '<input id="settings-date" type="date" required data-settings-date>' +
        '<p class="hint" data-settings-hint></p></div>' +
        '<p class="caption" data-settings-note role="status"></p>' +
        '<div class="admin-actions">' +
          '<button class="jka-btn jka-btn--sm" type="submit" data-settings-save></button>' +
          '<button class="linklike" type="button" data-settings-cancel>cancel</button>' +
        '</div>' +
      '</form>';
    document.body.appendChild(settingsDialog);
    settingsDialog.querySelector('[data-settings-cancel]').addEventListener('click', () => settingsDialog.close());
  }
  const d = settingsDialog;
  const input = d.querySelector('[data-settings-date]');
  const note = d.querySelector('[data-settings-note]');
  d.querySelector('#settings-title').textContent = (on ? 'pre-order settings: ' : 'turn on pre-order: ') + name;
  d.querySelector('[data-settings-state]').textContent = on
    ? 'pre-order is on for the ' + name + '. change its date here.'
    : 'pre-order needs a date. pick when the ' + name + ' is expected in stock and shipping, and pre-order turns on when you save.';
  d.querySelector('[data-settings-hint]').textContent =
    'buyers see "pre-order. expected in stock and shipping around <date>." a bag with this pin ships all together then.';
  d.querySelector('[data-settings-save]').textContent = on ? 'save date' : 'save and turn on pre-order';
  input.min = today;
  // a date that has passed isn't offered again: pick a new one
  input.value = date && date >= today ? date : '';
  note.textContent = '';
  const form = d.querySelector('form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (!input.value) { note.textContent = 'pick a date first.'; input.focus(); return; }
    note.textContent = 'saving.';
    try {
      const res = on
        ? await api('POST', '/api/admin/preorder-date', { slug: p.slug, date: input.value })
        : await api('POST', '/api/admin/preorder', { slug: p.slug, preorder: true, date: input.value });
      saved(res.date || input.value);
      d.close();
    } catch (err) {
      const why = err.data && err.data.error;
      note.textContent = why === 'past' ? 'pick today or a later date.' : why === 'too far' ? 'pick a date within two years.'
        : why === 'date' || why === 'date required' ? 'that date doesn\'t look right.' : 'that didn\'t save. try again in a moment.';
    }
  };
  d.onclose = () => opener.focus();
  d.showModal();
  input.focus();
}

function paintProducts(data) {
  const mode = $('[data-products-mode]');
  const note = $('[data-products-note]');
  const form = $('[data-products-form]');
  const available = data.available || {};
  const preorder = data.preorder || {};
  const dates = data.preorderDates || {};
  const today = data.today || new Date().toISOString().slice(0, 10);
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
    // the gear: "pre-order settings", a small window with this product's pre-order date
    const gear = el('button', 'icon-btn gear-btn');
    gear.type = 'button';
    gear.title = 'pre-order settings';
    gear.setAttribute('aria-label', 'pre-order settings for ' + shownName(p));
    gear.setAttribute('aria-haspopup', 'dialog');
    gear.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
    const switches = el('span', 'link-product-switches');
    switches.append(avail.wrap, pre.wrap, gear);
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
      words.textContent = availableWords(on, interest[p.slug] || 0, preOn, dates[p.slug], today) + (extra ? ' ' + extra : '');
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
    // a date saved in the window: pre-order is on with it (switching on saves both at once)
    const dateSaved = (date) => {
      dates[p.slug] = date;
      const turnedOn = !preOn;
      preOn = true;
      preorder[p.slug] = true;
      show(turnedOn ? 'pre-order is on.' : 'saved.');
      if (turnedOn) { paintInterest(data); loadFeatured(); loadNotify(); }
    };
    pre.sw.addEventListener('click', () => {
      // switching on needs a date first: the window asks for it, and pre-order turns on once it's saved
      if (!preOn) { preorderSettings(p, shownName(p), false, dates[p.slug] || '', today, pre.sw, dateSaved); return; }
      flip('/api/admin/preorder', 'preorder', false, () => { preOn = false; preorder[p.slug] = false; });
    });
    gear.addEventListener('click', () => preorderSettings(p, shownName(p), preOn, dates[p.slug] || '', today, gear, dateSaved));
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
/* ---------- interest and emails: "i'm interested" tallies and "email when it's here" lists, one row per product ---------- */
// two loaders feed it: the products list (tallies, switches) and the email lists (who's waiting, today's count).
// whichever arrives repaints the lot, so a row shows both as soon as both are in
let askingProducts = null;
let askingNotify = null;
let askingDone = null;
function paintInterest(data) { askingProducts = data; paintAsking(); }

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

function paintNotify(data, done) { askingNotify = data; askingDone = done || null; paintAsking(); }

// what the shop shows for a product right now
function shelfWords(slug) {
  const d = askingProducts || {};
  if ((d.preorder || {})[slug]) return 'on pre-order now.';
  if ((d.available || {})[slug] === false) return 'not in the shop yet.';
  return 'in the shop now.';
}

// one product's email list: how many are waiting, the send button (or what to do first), who, and the email itself
function emailBits(r, done) {
  const out = [el('p', 'caption', waitingWords(r))];
  const actions = el('div', 'admin-actions');
  const note = el('span', 'caption');
  note.setAttribute('role', 'status');
  if (r.preorder) {
    note.textContent = 'when it\'s here, switch pre-order off and available on in products and square, then send.';
  } else if (!r.available) {
    note.textContent = 'switch it on in products and square when it\'s here, then send.';
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
          : why === 'not available' ? 'switch it on in products and square first.' : "that didn't send. nothing went out. try again in a moment.";
        send.disabled = false;
      }
    });
    actions.appendChild(send);
  }
  if (done && done.slug === r.slug) note.textContent = done.words;
  actions.appendChild(note);
  out.push(actions);
  if (r.people && r.people.length) out.push(whoIsWaiting(r));
  // what they'll get, word for word, in a sealed-off frame: no scripts, nothing it can reach on this page
  const peek = el('details', 'notify-preview');
  peek.appendChild(el('summary', 'link-btn', 'see the email'));
  peek.appendChild(el('p', 'caption', 'subject: ' + r.preview.subject));
  const frame = el('iframe', 'notify-preview-frame');
  frame.setAttribute('sandbox', '');
  frame.title = 'the "it\'s here" email for the ' + r.name;
  frame.srcdoc = r.preview.html;
  peek.appendChild(frame);
  out.push(peek);
  return out;
}

function paintAsking() {
  const state = $('[data-notify-state]');
  const box = $('[data-asking-list]');
  const n = askingNotify;
  if (n) {
    state.textContent = n.configured
      ? 'emails today: ' + n.sentToday + ' of ' + n.limit + ' sent. the count starts again at midnight (utc).'
      : 'email isn\'t set up yet, so the shop only offers "i\'m interested", not the email box. see docs/setup/email.md.';
  }
  if (!askingProducts && !n) return;
  // every product with a tally or a waiting list, keyed by slug
  // names as products and square shows them ("husky"), whichever list a product comes from
  const names = {};
  if (askingProducts) askingProducts.products.forEach((p) => { names[p.slug] = shownName(p); });
  const rows = new Map();
  const row = (slug, name) => { if (!rows.has(slug)) rows.set(slug, { slug, name: names[slug] || name, interest: 0, list: null }); return rows.get(slug); };
  if (askingProducts) {
    Object.entries(askingProducts.interest || {}).forEach(([slug, count]) => { if (names[slug] && count > 0) row(slug, names[slug]).interest = count; });
  }
  if (n && n.configured) (n.products || []).forEach((r) => { row(r.slug, r.name).list = r; });
  const list = [...rows.values()].sort((a, b) => (b.interest - a.interest) || ((b.list ? b.list.waiting : 0) - (a.list ? a.list.waiting : 0)));
  box.textContent = '';
  // a send that emptied its list: say so, since that product's list is gone now
  const done = askingDone;
  if (done && !list.some((r) => r.list && r.slug === done.slug)) box.appendChild(el('p', 'body-sm', done.words));
  if (!list.length) {
    box.appendChild(el('p', 'body-sm muted', 'no one has asked for anything yet. switch a product to not available and its "i\'m interested" button appears in the shop.'));
    return;
  }
  list.forEach((r) => {
    const div = el('div', 'link-product');
    div.appendChild(el('p', 'link-product-name', r.name));
    // the tally only when there is one: a product can have people waiting for an email without any taps counted
    div.appendChild(el('p', 'caption', (r.interest ? peopleWords(r.interest) + ' ' : '') + shelfWords(r.slug)));
    if (r.list) emailBits(r.list, done).forEach((x) => div.appendChild(x));
    else if (n && n.configured) div.appendChild(el('p', 'caption', 'no one waiting for an email.'));
    box.appendChild(div);
  });
}

async function loadNotify() {
  try { paintNotify(await api('GET', '/api/admin/notify')); } catch (e) { $('[data-notify-state]').textContent = RESTING; }
}

/* ---------- orders to ship: the "on its way" email and the tracking number ---------- */
// the gift cards still to write, by square order id, from /api/admin/gifts. a gift order whose card isn't on this list
// any more has had it written. null until it has loaded
let giftCards = null;
let shipData = null;
let shipDone = '';
function paintOrders(data, done) {
  shipData = data;
  shipDone = done || '';
  const state = $('[data-orders-state]');
  const box = $('[data-order-list]');
  box.textContent = '';
  if (!data.square) { state.textContent = 'square isn\'t set up yet, so there are no orders to show.'; return; }
  const n = data.orders.length;
  const lines = [];
  if (done) lines.push(done);
  lines.push(n ? n + (n === 1 ? ' order to ship.' : ' orders to ship.') : 'nothing to ship right now.');
  const cards = giftCards ? giftCards.length : 0;
  if (cards) lines.push(cards + (cards === 1 ? ' gift card to write.' : ' gift cards to write.'));
  if (!data.email) lines.push('email isn\'t set up, so "mark shipped" only marks it in square. see docs/setup/email.md.');
  state.textContent = lines.join(' ');
  data.orders.forEach((o) => {
    const row = el('div', 'link-product order-row');
    row.appendChild(el('p', 'link-product-name', 'order ' + o.number + (o.date ? ', ' + new Date(o.date).toLocaleDateString() : '')));
    const tags = [];
    if (o.gift) tags.push('gift');
    if (o.preorder) tags.push('pre-order' + (o.expected ? ', ships about ' + new Date(o.expected).toLocaleDateString() : ''));
    if (o.shipping) tags.push(o.shipping + ' shipping');
    if (tags.length) row.appendChild(el('p', 'caption', tags.join(' · ')));
    const what = el('ul', 'order-items');
    o.items.forEach((it) => what.appendChild(el('li', null, (it.qty > 1 ? it.qty + ' × ' : '') + it.name)));
    row.appendChild(what);
    const a = o.address;
    const to = el('p', 'body-sm gift-address');
    [o.name, a.line1, a.line2, a.city + ', ' + a.state + ' ' + a.zip].filter(Boolean).forEach((l, i) => {
      if (i) to.appendChild(document.createElement('br'));
      to.appendChild(document.createTextNode(l));
    });
    row.appendChild(to);
    row.appendChild(el('p', 'caption notify-email', 'buyer: ' + o.email));
    if (o.gift) row.appendChild(giftCard(o.id, o.number));
    // the pre-order part of the shipping note (a gift's part shows as its card above)
    const extra = o.note.split(' / ').filter((x) => !/^gift\./.test(x)).join(' / ');
    if (extra) row.appendChild(el('p', 'caption', 'note: ' + extra));

    const form = el('form', 'admin-actions order-ship');
    const id = 'track-' + o.id;
    const lab = el('label', 'sr-only', 'usps tracking number for order ' + o.number);
    lab.htmlFor = id;
    const input = el('input');
    input.id = id;
    input.type = 'text';
    input.placeholder = 'usps tracking number';
    input.autocomplete = 'off';
    input.setAttribute('inputmode', 'text');
    input.maxLength = 60;
    const go = el('button', 'jka-btn jka-btn--sm', 'mark shipped');
    go.type = 'submit';
    const note = el('span', 'caption');
    note.setAttribute('role', 'status');
    form.append(lab, input, go, note);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = input.value.replace(/[\s-]/g, '');
      if (!/^[A-Za-z0-9]{8,40}$/.test(t)) { note.textContent = 'that tracking number doesn\'t look right.'; input.focus(); return; }
      if (!confirm('mark order ' + o.number + ' shipped' + (data.email ? ' and email ' + o.email : '') + '?\ntracking: ' + t)) return;
      go.disabled = true;
      note.textContent = 'sending.';
      try {
        const res = await api('POST', '/api/admin/orders', { id: o.id, tracking: t });
        paintOrders(res, 'order ' + o.number + ' is marked shipped' + (res.emailed ? ' and ' + o.email + ' has the email.' : '.'));
        // a gift's card went in the box: the server ticked it off, so fetch the cards again
        if (o.gift) loadGifts();
      } catch (err) {
        const why = err.data && err.data.error;
        note.textContent = why === 'already shipped' ? 'this one is already marked shipped.'
          : why === 'email limit' ? 'today\'s emails are used up. try again tomorrow.'
          : why === 'tracking' ? 'that tracking number doesn\'t look right.'
          : 'that didn\'t go through. press it again: the email won\'t go out twice.';
        go.disabled = false;
      }
    });
    row.appendChild(form);

    // what the buyer will get, word for word (with a stand-in tracking number)
    const peek = el('details', 'notify-preview');
    peek.appendChild(el('summary', 'link-btn', 'see the email'));
    peek.appendChild(el('p', 'caption', 'subject: ' + o.preview.subject));
    const frame = el('iframe', 'notify-preview-frame');
    frame.setAttribute('sandbox', '');
    frame.title = 'the "on its way" email for order ' + o.number;
    frame.srcdoc = o.preview.html;
    peek.appendChild(frame);
    row.appendChild(peek);
    box.appendChild(row);
  });
}

async function loadOrders() {
  try { paintOrders(await api('GET', '/api/admin/orders')); } catch (e) { $('[data-orders-state]').textContent = RESTING; }
}

/* ---------- gift cards: the note to write by hand, shown inside its order in "orders to ship" ---------- */
// the card box for one gift order: the note to write, and "card written" to tick it off
function giftCard(id, number) {
  const box = el('div', 'gift-card');
  const card = giftCards && giftCards.find((g) => g.id === id);
  box.appendChild(el('p', 'caption gift-card-title', 'card to write'));
  if (!giftCards) { box.appendChild(el('p', 'caption', 'one moment.')); return box; }
  if (!card) { box.appendChild(el('p', 'caption', 'card written.')); return box; }
  box.appendChild(el('p', 'gift-note', card.message ? '\u201c' + card.message + '\u201d' : 'no note: a blank card.'));
  const actions = el('div', 'admin-actions');
  const done = el('button', 'jka-btn jka-btn--sm jka-btn--quiet', 'card written');
  done.type = 'button';
  done.setAttribute('aria-label', 'card written for order ' + number);
  const note = el('span', 'caption');
  note.setAttribute('role', 'status');
  done.addEventListener('click', async () => {
    done.disabled = true;
    try { paintGifts(await api('POST', '/api/admin/gifts', { id })); } catch (e) {
      note.textContent = 'that didn\'t save. try again in a moment.';
      done.disabled = false;
    }
  });
  actions.append(done, note);
  box.appendChild(actions);
  return box;
}

function paintGifts(data) {
  giftCards = data.square ? data.gifts : [];
  if (shipData) paintOrders(shipData, shipDone);
  // cards for gift orders that aren't waiting to ship any more: still to write, so they aren't missed
  const box = $('[data-gift-list]');
  box.textContent = '';
  const waiting = new Set(((shipData && shipData.orders) || []).map((o) => o.id));
  const left = giftCards.filter((g) => !waiting.has(g.id));
  if (!shipData || !left.length) return;
  box.appendChild(el('h3', 'admin-subtitle', 'cards still to write'));
  box.appendChild(el('p', 'caption', 'gift orders already marked shipped (in square, say) whose card wasn\'t ticked off here.'));
  left.forEach((g) => {
    const row = el('div', 'link-product gift-row');
    row.appendChild(el('p', 'link-product-name', 'order ' + g.number + (g.date ? ', ' + new Date(g.date).toLocaleDateString() : '')));
    const a = g.address;
    const to = el('p', 'body-sm gift-address');
    [g.name, a.line1, a.line2, a.city + ', ' + a.state + ' ' + a.zip].filter(Boolean).forEach((l, n) => {
      if (n) to.appendChild(document.createElement('br'));
      to.appendChild(document.createTextNode(l));
    });
    row.appendChild(to);
    row.appendChild(el('p', 'caption notify-email', 'buyer: ' + g.email));
    row.appendChild(giftCard(g.id, g.number));
    box.appendChild(row);
  });
}

async function loadGifts() {
  try { paintGifts(await api('GET', '/api/admin/gifts')); } catch (e) { /* the orders still show; their cards say "one moment." */ }
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

/* ---------- product photos: the owner's own, shown under the pup board (server/media.js) ---------- */
// photos go up one at a time, each shrunk in the browser first by app.js (the same as review photos)
let mediaProducts = [];
function paintMedia(data) {
  const note = $('[data-media-note]');
  const form = $('[data-media-form]');
  const list = $('[data-media-list]');
  list.textContent = '';
  if (!data.on) {
    note.textContent = 'photos are not set up yet: the website needs the review-photos bucket (see docs/setup/reviews.md).';
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const n = data.photos.length;
  note.textContent = n ? (n === 1 ? 'one photo up.' : n + ' photos up.') + ' up to ' + data.max + ' per product.' : 'no photos up yet. up to ' + data.max + ' per product.';
  const bySlug = {};
  data.photos.forEach((ph) => { (bySlug[ph.slug] = bySlug[ph.slug] || []).push(ph); });
  mediaProducts.filter((p) => bySlug[p.slug]).forEach((p) => {
    const group = el('section', 'admin-media-group');
    group.appendChild(el('h3', null, shownName(p) + ' (' + bySlug[p.slug].length + ')'));
    const row = el('div', 'admin-media-photos');
    bySlug[p.slug].forEach((ph) => {
      const item = el('figure', 'admin-media-photo');
      const img = el('img');
      img.src = ph.src;
      img.alt = ph.alt || 'a photo of the ' + shownName(p);
      img.width = 120;
      img.height = 120;
      img.loading = 'lazy';
      item.appendChild(img);
      item.appendChild(el('figcaption', 'caption', ph.alt || '(no words yet.)'));
      const rm = el('button', 'link-btn', 'remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'remove this photo of the ' + shownName(p));
      rm.addEventListener('click', async () => {
        if (!confirm('take this photo down? it can\'t be undone.')) return;
        rm.disabled = true;
        try { paintMedia(await api('DELETE', '/api/admin/media?id=' + encodeURIComponent(ph.id))); } catch (e) {
          rm.disabled = false;
          note.textContent = "that didn't come down. try again in a moment.";
        }
      });
      item.appendChild(rm);
      row.appendChild(item);
    });
    group.appendChild(row);
    list.appendChild(group);
  });
}
function wireMedia() {
  const form = $('[data-media-form]');
  const saved = $('[data-media-saved]');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const files = Array.from($('[data-media-file]').files || []);
    const slug = $('[data-media-product]').value;
    if (!files.length) { saved.textContent = 'pick a photo first.'; return; }
    if (!window.JKA || !window.JKA.shrinkPhoto) { saved.textContent = 'the page did not finish loading. reload and try again.'; return; }
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    let done = 0, last = null;
    const problems = [];
    for (const file of files) {
      saved.textContent = 'uploading ' + (done + 1) + ' of ' + files.length + '.';
      try {
        const pic = await window.JKA.shrinkPhoto(file);
        last = await api('POST', '/api/admin/media', { slug, jpeg: pic.jpeg, alt: $('[data-media-alt]').value });
        done++;
      } catch (err) {
        problems.push(err.data && err.data.error === 'too many' ? 'that product already has ' + err.data.max + ' photos.' : file.name + " didn't upload.");
        if (err.data && err.data.error === 'too many') break;
      }
    }
    btn.disabled = false;
    if (last) paintMedia(last);
    if (done) { form.reset(); $('[data-media-product]').value = slug; }
    saved.textContent = (done ? (done === 1 ? 'one photo up.' : done + ' photos up.') : '') + (problems.length ? ' ' + problems.join(' ') : '');
  });
}
async function loadMedia() {
  try {
    const data = await api('GET', '/api/admin/media');
    // the pup board shows pup club pins, so those come first in the list
    mediaProducts = (data.products || []).slice().sort((a, b) => (a.series === 'pup-club' ? 0 : 1) - (b.series === 'pup-club' ? 0 : 1));
    const pick = $('[data-media-product]');
    pick.textContent = '';
    mediaProducts.forEach((p) => {
      const o = el('option', null, shownName(p) + (p.series === 'pup-club' ? '' : ' (not on the pup board)'));
      o.value = p.slug;
      pick.appendChild(o);
    });
    paintMedia(data);
  } catch (e) { $('[data-media-note]').textContent = RESTING; }
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

/* ---------- sections: the menu at the top shows one card at a time, like tabs in a folder ---------- */
// built from the card titles, so a new card gets its own button on its own. the open one is kept in the address
// (/admin#admin-orders-title) and in this browser, so a reload comes back to it. localStorage can come back empty
// in a private window: then the first card (the shop) opens
const SECTION_KEY = 'jka_admin_section';
function wireSections() {
  const list = $('[data-admin-menu]');
  const cards = [...document.querySelectorAll('.admin-card')].filter((c) => c.querySelector('.admin-title[id]'));
  if (!list || !cards.length) return;
  const buttons = new Map();
  const show = (id, focus) => {
    cards.forEach((card) => {
      const on = card.querySelector('.admin-title').id === id;
      card.hidden = !on;
      const b = buttons.get(card.querySelector('.admin-title').id);
      b.setAttribute('aria-current', on ? 'page' : 'false');
      b.classList.toggle('is-current', on);
    });
    try { localStorage.setItem(SECTION_KEY, id); } catch (e) {}
    history.replaceState(null, '', '#' + id);
    if (focus) document.getElementById(id).focus({ preventScroll: true });
  };
  cards.forEach((card) => {
    const title = card.querySelector('.admin-title');
    // the title can take the keyboard after a switch, so the next tab lands inside the section
    title.tabIndex = -1;
    const b = el('button', 'admin-menu-btn', title.textContent.trim());
    b.type = 'button';
    b.setAttribute('aria-controls', card.id || (card.id = title.id + '-card'));
    b.addEventListener('click', () => show(title.id, true));
    buttons.set(title.id, b);
    const li = el('li');
    li.appendChild(b);
    list.appendChild(li);
  });
  let start = decodeURIComponent(location.hash.slice(1));
  if (!buttons.has(start)) { try { start = localStorage.getItem(SECTION_KEY) || ''; } catch (e) { start = ''; } }
  if (!buttons.has(start)) start = cards[0].querySelector('.admin-title').id;
  show(start, false);
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
  wireSections();
  try { wireShop(await api('GET', '/api/admin/shop')); } catch (e) { $('[data-shop-state]').textContent = RESTING; }
  loadOrders().then(loadGifts);
  wireProducts();
  loadProducts();
  wireFeatured();
  loadFeatured();
  loadNotify();
  wireMedia();
  loadMedia();
  loadReviews();
  loadInstagram();
}

(async function start() {
  user = await signedInUser();
  if (!user) showSignIn();
  else open();
})();
