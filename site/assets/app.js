/* j+k adventures: shop and bag. The shelf comes from /api/catalog (our products, with Square's prices and stock);
   checkout is handed to Square by /api/checkout (see _worker.js). The bag holds keys: "aussie" is the standard
   aussie pin, "aussie:large" the large one. */
(function () {
  'use strict';

  var CONTACT_EMAIL = 'support@ourjkadventures.com';
  var PIN_IMG = {};
  ['aussie', 'beagle', 'cavalier', 'corgi', 'dachshund', 'doodle', 'french-bulldog', 'german-shepherd', 'golden', 'husky',
    'pit-bull', 'pomeranian', 'pug', 'rottweiler', 'shiba', 'yorkie'].forEach(function (s) {
    // ?v= changes whenever pin pictures are redone, so browsers don't keep showing an old one for a week (see _headers)
    PIN_IMG[s] = 'assets/img/pins/' + s + '.webp?v=6';
  });

  /* ---------- storage that survives a blocked localStorage ---------- */
  var mem = {};
  function save(k, v) {
    mem[k] = v;
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
  }
  function read(k) {
    try { var v = localStorage.getItem(k); if (v !== null) return v; } catch (e) {}
    return mem[k] === undefined ? null : mem[k];
  }

  /* ---------- the catalog (/api/catalog) ---------- */
  var catalog = { currency: 'USD', open: false, items: {}, byKey: {}, featured: [] };
  var catalogPromise = null;
  function loadCatalog(fresh) {
    if (catalogPromise && !fresh) return catalogPromise;
    catalogPromise = fetch('/api/catalog', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('catalog ' + r.status);
      return r.json();
    }).then(function (j) {
      catalog.currency = j.currency || 'USD';
      catalog.open = j.open === true;
      catalog.items = {};
      catalog.byKey = {};
      // the owner's picks for the carousel at the top of the shop: slugs, already only ones in stock
      catalog.featured = Array.isArray(j.featured) ? j.featured : [];
      // whether "email me when it's here" is offered (the site's email is set up)
      catalog.email = j.email === true;
      (j.items || []).forEach(function (p) {
        p.sizes = p.sizes || [];
        catalog.items[p.slug] = p;
        p.sizes.forEach(function (sz) { catalog.byKey[sz.key] = { product: p, size: sz }; });
      });
      return catalog;
    });
    catalogPromise.catch(function () { catalogPromise = null; });
    return catalogPromise;
  }

  /* ---------- helpers ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function money(n, cur) {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD' }).format(n); }
    catch (e) { return '$' + Number(n).toFixed(2); }
  }
  function svg(paths) {
    var s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.5');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      s.appendChild(p);
    });
    return s;
  }

  // pups whose name changed: an old link or a bag saved before the change still finds the new one
  var RENAMED_PUPS = { poodle: 'doodle' };

  /* ---------- the bag: lives in this browser until checkout ---------- */
  var cart = {};
  var drawer, scrim, bodyEl, footEl, countEls, lastFocus;

  function loadCart() {
    try {
      var o = JSON.parse(read('jka_cart') || '{}');
      cart = {};
      var renamed = false;
      Object.keys(o).forEach(function (s) {
        var q = Math.floor(Number(o[s]));
        var k = s.replace(/^[a-z0-9-]+/, function (slug) { return RENAMED_PUPS[slug] || slug; });
        if (k !== s) renamed = true;
        if (/^[a-z0-9-]{1,40}(:large)?$/.test(k) && q > 0) cart[k] = Math.min((cart[k] || 0) + q, 20);
      });
      if (renamed) saveCart();
    } catch (e) { cart = {}; }
  }
  function saveCart() { save('jka_cart', Object.keys(cart).length ? JSON.stringify(cart) : null); }
  function itemCount() { return Object.keys(cart).reduce(function (n, s) { return n + cart[s]; }, 0); }
  function paintCount() {
    var n = itemCount();
    countEls.forEach(function (c) { c.textContent = String(n); c.hidden = n === 0; });
  }

  function buildDrawer() {
    scrim = el('div', 'scrim');
    scrim.addEventListener('click', closeBag);
    drawer = el('aside', 'drawer');
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', 'your bag');
    drawer.setAttribute('aria-hidden', 'true');

    var head = el('div', 'drawer-head');
    head.appendChild(el('h2', null, 'your bag'));
    var close = el('button', 'icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', 'close your bag');
    close.appendChild(svg(['M6 6l12 12', 'M18 6L6 18']));
    close.addEventListener('click', closeBag);
    head.appendChild(close);

    bodyEl = el('div', 'drawer-body');
    footEl = el('div', 'drawer-foot');
    drawer.appendChild(head);
    drawer.appendChild(bodyEl);
    drawer.appendChild(footEl);
    document.body.appendChild(scrim);
    document.body.appendChild(drawer);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && drawer.classList.contains('open')) closeBag();
    });
  }

  function openBag() {
    lastFocus = document.activeElement;
    drawer.classList.add('open');
    scrim.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    refreshCart();
    var c = drawer.querySelector('.icon-btn');
    if (c) c.focus();
  }
  function closeBag() {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function showError(msg) {
    var old = footEl.querySelector('.err');
    if (old) old.remove();
    footEl.insertBefore(el('p', 'err', msg), footEl.firstChild);
  }

  // the most of one thing the bag may hold: what is on the shelf, and never more than 20
  function maxQty(entry) { return catalog.open ? Math.min(20, entry.size.stock) : 20; }
  function buyable(entry) { return !!entry && catalog.open && entry.size.stock > 0; }

  function paintDrawer() {
    bodyEl.textContent = '';
    footEl.textContent = '';
    // keys for products we know, even ones not for sale right now, so the bag can say so
    var keys = Object.keys(cart).filter(function (k) { return catalog.items[k.split(':')[0]]; });
    if (!keys.length) {
      bodyEl.appendChild(el('p', 'empty', 'your bag is empty. a pin would look good in it.'));
      return;
    }
    var sum = 0;
    var ready = 0;
    var trimmed = false;
    keys.forEach(function (k) {
      var entry = catalog.byKey[k];
      var name = lineName(k);
      var row = el('div', 'line');
      row.appendChild(el('div', 'lname', name));
      var ctl = el('div', 'lctl');
      var rm = el('button', 'linklike', 'remove');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'remove ' + name);
      rm.addEventListener('click', function () { changeQty(k, 0); });

      if (catalog.open && !buyable(entry)) {
        // gone from the shelf since it went in the bag
        row.appendChild(el('div', 'lprice', 'sold out.'));
        ctl.appendChild(el('span', 'caption', 'it will not be in this order.'));
        ctl.appendChild(rm);
        row.appendChild(ctl);
        bodyEl.appendChild(row);
        return;
      }
      if (entry && cart[k] > maxQty(entry)) { cart[k] = maxQty(entry); trimmed = true; }
      var q = cart[k];
      if (entry) { sum += entry.size.price_cents * q; ready++; }
      row.appendChild(el('div', 'lprice', entry ? money(entry.size.price_cents * q / 100, catalog.currency) : ''));
      var qty = el('div', 'qty');
      var minus = el('button', null, '−');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'one fewer ' + name);
      var plus = el('button', null, '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'one more ' + name);
      if (entry && q >= maxQty(entry)) plus.disabled = true;
      qty.appendChild(minus);
      qty.appendChild(el('span', null, String(q)));
      qty.appendChild(plus);
      minus.addEventListener('click', function () { changeQty(k, q - 1); });
      plus.addEventListener('click', function () { changeQty(k, q + 1); });
      ctl.appendChild(qty);
      ctl.appendChild(rm);
      row.appendChild(ctl);
      if (catalog.open && entry && q >= entry.size.stock) row.appendChild(el('p', 'caption lnote', 'that is all we have of this one.'));
      bodyEl.appendChild(row);
    });
    if (trimmed) { saveCart(); paintCount(); }
    var total = el('div', 'total');
    total.appendChild(el('span', null, 'subtotal'));
    total.appendChild(el('span', null, money(sum / 100, catalog.currency)));
    footEl.appendChild(total);
    footEl.appendChild(el('p', 'caption', 'shipping and tax are added at checkout.'));
    if (!catalog.open) {
      footEl.appendChild(el('p', 'caption', 'the shop opens soon. your bag will keep these for you.'));
      return;
    }
    if (!ready) return;
    var go = el('button', 'jka-btn', 'check out');
    go.type = 'button';
    go.addEventListener('click', checkout);
    footEl.appendChild(go);
  }

  function refreshCart(fresh) {
    return loadCatalog(fresh).then(function () { paintCount(); paintDrawer(); }).catch(function () {
      bodyEl.textContent = '';
      footEl.textContent = '';
      bodyEl.appendChild(el('p', 'empty', 'we could not open your bag just now. try again in a moment.'));
    });
  }

  function changeQty(key, qty) {
    var entry = catalog.byKey[key];
    if (qty < 1) delete cart[key]; else cart[key] = Math.min(qty, entry ? maxQty(entry) : 20);
    saveCart();
    paintCount();
    paintDrawer();
  }

  // "aussie pin", "large aussie pin", "goldie pin", "bay area pin board"
  function lineName(key) {
    var parts = key.split(':');
    var p = catalog.items[parts[0]];
    if (!p) return key;
    return (parts[1] === 'large' ? 'large ' : '') + pupName(p) + (p.kind === 'board' ? '' : ' pin');
  }

  function checkout() {
    var btn = footEl.querySelector('.jka-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'one moment.'; }
    var items = Object.keys(cart).filter(function (k) { return buyable(catalog.byKey[k]); })
      .map(function (k) { return { key: k, qty: cart[k] }; });
    signInTicket().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch('/api/checkout', { method: 'POST', headers: headers, body: JSON.stringify({ items: items }) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 409 || r.status === 403) {
          // the server says exactly how many are left; the shared list may be up to a minute behind
          (j.items || []).forEach(function (it) { var en = catalog.byKey[it.key]; if (en) en.size.stock = Math.max(0, Number(it.stock) || 0); });
          var e = new Error('changed'); e.changed = true; e.closed = r.status === 403; throw e;
        }
        if (!r.ok || !j.url) throw new Error('checkout');
        return j.url;
      });
    }).then(function (url) {
      location.href = url;
    }).catch(function (err) {
      if (err && err.changed) {
        // someone else got there first, or the shop just closed: show the bag as it really is now
        (err.closed ? refreshCart(true) : Promise.resolve(paintDrawer())).then(function () {
          showError(err.closed ? 'the shop has just closed. your bag will keep these for you.'
            : 'the shelf changed while you were shopping. your bag now shows what we have.');
        });
        return;
      }
      if (btn) { btn.disabled = false; btn.textContent = 'check out'; }
      showError('we could not start checkout. try again, or write to us at ' + CONTACT_EMAIL + '.');
    });
  }

  /* ---------- accounts: the header link, and a sign-in ticket for checkout (see account.js) ---------- */
  function paintAccountLink() {
    var name = read('jka_user');
    Array.prototype.forEach.call(document.querySelectorAll('[data-account-link]'), function (a) {
      a.textContent = name === null ? 'sign in' : (name.toLowerCase() || 'your account');
    });
  }
  // signed-out buyers, or a slow or blocked sign-in service, simply check out without a ticket
  function signInTicket() {
    if (read('jka_user') === null) return Promise.resolve(null);
    var ticket = import('/assets/account.js').then(function (m) { return m.currentToken(); });
    var giveUp = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 4000); });
    return Promise.race([ticket, giveUp]).catch(function () { return null; });
  }

  /* ---------- adding things ---------- */
  function addToBag(key, btn, label) {
    var entry = catalog.byKey[key];
    if (!buyable(entry)) return;
    var before = cart[key] || 0;
    cart[key] = Math.min(before + 1, maxQty(entry));
    saveCart();
    paintCount();
    btn.disabled = true;
    btn.textContent = cart[key] > before ? 'in your bag.' : 'that is all we have.';
    setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 1600);
  }

  /* ---------- the shop ---------- */
  var PUP_ORDER = ['aussie', 'beagle', 'cavalier', 'corgi', 'dachshund', 'doodle', 'french-bulldog', 'german-shepherd', 'golden',
    'husky', 'pit-bull', 'pomeranian', 'pug', 'rottweiler', 'shiba', 'yorkie'];
  var PUP_BREED = {
    'aussie': 'australian shepherd', 'beagle': 'beagle', 'cavalier': 'cavalier king charles spaniel', 'corgi': 'corgi',
    'dachshund': 'dachshund', 'doodle': 'doodle', 'french-bulldog': 'french bulldog', 'german-shepherd': 'german shepherd', 'golden': 'golden retriever',
    'husky': 'siberian husky', 'pit-bull': 'pit bull', 'pomeranian': 'pomeranian', 'pug': 'pug',
    'rottweiler': 'rottweiler', 'shiba': 'shiba inu', 'yorkie': 'yorkshire terrier'
  };

  function priceOf(sz) { return money(sz.price_cents / 100, catalog.currency); }
  // the price line: "$12", or "$12 or $15" when a pin comes in two sizes. empty until it is linked to square
  function priceRange(p) {
    var prices = p.sizes.map(function (sz) { return sz.price_cents; }).filter(function (c, i, a) { return a.indexOf(c) === i; });
    return prices.map(function (c) { return money(c / 100, catalog.currency); }).join(' or ');
  }
  function buttonLabel(sz) {
    if (!catalog.open) return 'coming soon';
    return sz && sz.stock > 0 ? 'add to bag' : 'sold out';
  }
  // a plain count, the same calm words whether there are 2 or 200
  function stockText(sz) { return catalog.open && sz && sz.stock > 0 ? sz.stock + ' in stock.' : ''; }

  /* ---------- "i'm interested": products the owner marked not available yet (see server/interest.js) ---------- */
  // the server is what counts one vote each; this only remembers which buttons this browser already tapped
  function interestedIn() {
    try { var a = JSON.parse(read('jka_interest') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }
  function rememberInterest(slug) {
    var a = interestedIn();
    if (a.indexOf(slug) < 0) { a.push(slug); save('jka_interest', JSON.stringify(a)); }
  }
  function forgetInterest(slug) {
    var a = interestedIn().filter(function (s) { return s !== slug; });
    save('jka_interest', a.length ? JSON.stringify(a) : null);
  }

  // "1 is interested." / "4 are interested."
  function interestedWords(n) { return n === 1 ? '1 is interested.' : n + ' are interested.'; }

  // same shape as buyArea (a price line, a stock line, a button) so every page places it the same way.
  // above the button only ever "not in the shop yet." and the count. below it, once tapped, a thank you and
  // (when the site's email is set up) a box to be emailed when it arrives
  function interestArea(p, btnClass) {
    var area = el('div', 'buy');
    var price = el('p', 'price', '');
    var line = el('p', 'caption stock-line', '');
    line.setAttribute('aria-live', 'polite');
    var btn = el('button', btnClass + ' interest-btn', '');
    btn.type = 'button';
    var name = p.kind === 'board' ? p.name : pupName(p) + ' pin';
    // an on and off button, like a light switch: tap to say you're interested, tap again to take it back
    btn.setAttribute('aria-label', 'i\'m interested in the ' + name);
    var after = el('div', 'notify');
    var thanks = notifyBox(p);
    var msg = el('p', 'caption notify-note');
    msg.setAttribute('role', 'status');
    after.appendChild(thanks);
    after.appendChild(msg);
    var voted = interestedIn().indexOf(p.slug) >= 0;
    var sorry = 'we could not count that just now. try again in a moment.';
    function paint(note) {
      line.textContent = 'not in the shop yet.' + (p.interest > 0 ? ' ' + interestedWords(p.interest) : '');
      btn.textContent = voted ? 'you\'re interested.' : 'i\'m interested!';
      btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
      btn.disabled = false;
      thanks.hidden = !voted;
      msg.textContent = note || '';
    }
    function send(method) {
      return fetch('/api/interest', { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: p.slug }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status_code = r.status; return j; }); });
    }
    btn.addEventListener('click', function () {
      btn.disabled = true;
      btn.textContent = 'one moment.';
      if (voted) {
        send('DELETE').then(function (j) {
          if (j.status_code !== 200) { paint(sorry); return; }
          if (typeof j.count === 'number') p.interest = j.count;
          // "not counted" means this browser's vote was already gone (a cleared cookie, say): off either way
          voted = false;
          forgetInterest(p.slug);
          paint();
        }).catch(function () { paint(sorry); });
        return;
      }
      send('POST').then(function (j) {
        if (typeof j.count === 'number') p.interest = j.count;
        if (j.counted || j.reason === 'already') {
          voted = true;
          rememberInterest(p.slug);
          paint();
        } else if (j.reason === 'limit') {
          // lots of taps from one connection today (a shared wifi, say): this one wasn't added, and that's fine
          paint('we have counted plenty from this connection today. thank you all the same.');
          btn.disabled = true;
        } else if (j.error === 'preorder') {
          paint('this one is being made now. refresh the page to leave your email for it.');
          btn.disabled = true;
        } else if (j.status_code === 409) {
          paint('this one just arrived in the shop. refresh the page to see it.');
          btn.disabled = true;
        } else {
          paint(sorry);
        }
      }).catch(function () { paint(sorry); });
    });
    area.appendChild(price);
    area.appendChild(line);
    area.appendChild(btn);
    area.appendChild(after);
    paint();
    return area;
  }

  /* ---------- pre-order: the owner says it's being made (see server/interest.js) ---------- */
  // same shape as buyArea. no price, no button to buy and no vote: just that it's on its way, and (when the
  // site's email is set up) the box to be emailed when it arrives
  function preorderArea(p) {
    var area = el('div', 'buy');
    area.appendChild(el('p', 'price', ''));
    area.appendChild(el('p', 'caption stock-line', 'being made now. coming soon.'));
    var after = el('div', 'notify');
    after.appendChild(notifyBox(p, ''));
    area.appendChild(after);
    return area;
  }

  /* ---------- "did you mean ...@gmail.com?": the slips people make most, caught before anything is sent ---------- */
  var MAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'icloud.com',
    'me.com', 'mac.com', 'aol.com', 'comcast.net', 'att.net', 'sbcglobal.net', 'verizon.net', 'proton.me', 'protonmail.com',
    'ymail.com', 'mail.com', 'gmx.com'];
  // how many single-letter fixes apart two words are (a swapped pair of letters counts as one)
  function editsApart(a, b) {
    var d = [];
    for (var i = 0; i <= a.length; i++) { d[i] = [i]; }
    for (var j = 0; j <= b.length; j++) { d[0][j] = j; }
    for (i = 1; i <= a.length; i++) {
      for (j = 1; j <= b.length; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  }
  // "pup@gmial.com" -> "pup@gmail.com". nothing for a domain that's fine as it is, or not close to a common one
  function suggestEmail(email) {
    var at = email.lastIndexOf('@');
    var domain = email.slice(at + 1).toLowerCase();
    if (MAIL_DOMAINS.indexOf(domain) >= 0) return null;
    for (var k = 0; k < MAIL_DOMAINS.length; k++) {
      if (editsApart(domain, MAIL_DOMAINS[k]) === 1) return email.slice(0, at + 1) + MAIL_DOMAINS[k];
    }
    return null;
  }

  // the line under a tapped "i'm interested": "thank you!", and when the site's email is set up,
  // "be notified when it's available:" with one email box. checked on the spot (looks like an email, a common
  // typo, a domain that takes mail), then on the list. nothing is sent until the pin arrives
  // lead: the words before the box ("thank you!" after a tap; nothing for a pin on pre-order)
  function notifyBox(p, lead) {
    if (lead === undefined) lead = 'thank you!';
    var box = el('div', 'notify-thanks');
    var ask = lead ? ' be notified when it\'s available:' : 'be notified when it\'s here:';
    var words = el('p', 'notify-words', lead + (catalog.email ? ask : ''));
    if (!lead && !catalog.email) words.hidden = true;
    box.appendChild(words);
    if (!catalog.email) return box;
    var form = el('form', 'notify-form');
    form.noValidate = true;
    var id = 'notify-' + p.slug;
    var lab = el('label', 'sr-only', 'your email');
    lab.htmlFor = id;
    var input = el('input');
    input.type = 'email';
    input.id = id;
    input.name = 'email';
    input.placeholder = 'enter email';
    input.autocomplete = 'email';
    input.setAttribute('inputmode', 'email');
    var go = el('button', 'jka-btn jka-btn--quiet jka-btn--sm', 'notify me');
    go.type = 'submit';
    var note = el('p', 'caption notify-note');
    note.setAttribute('role', 'status');
    form.appendChild(lab);
    form.appendChild(input);
    form.appendChild(go);
    box.appendChild(form);
    box.appendChild(note);
    function say(text, keepForm) {
      note.textContent = text;
      form.hidden = !keepForm;
      // the box is done with: "be notified when it's available:" would point at nothing
      if (!keepForm) { words.textContent = lead; words.hidden = !lead; }
      go.disabled = false;
    }
    // the address we already offered a fix for: pressing notify me again keeps it as typed
    var offered = null;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        input.setAttribute('aria-invalid', 'true');
        say('that email doesn\'t look quite right.', true);
        input.focus();
        return;
      }
      var fix = email !== offered && suggestEmail(email);
      if (fix) {
        offered = email;
        note.textContent = 'did you mean ' + fix + '? ';
        var use = el('button', 'link-btn', 'yes, use that');
        use.type = 'button';
        use.addEventListener('click', function () {
          input.value = fix;
          offered = fix;
          note.textContent = '';
          if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event('submit', { cancelable: true }));
        });
        note.appendChild(use);
        note.appendChild(document.createTextNode(' or press notify me to keep it.'));
        return;
      }
      input.removeAttribute('aria-invalid');
      go.disabled = true;
      note.textContent = 'one moment.';
      fetch('/api/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: p.slug, email: email }) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status_code = r.status; return j; }); })
        .then(function (j) {
          if (j.status === 'added') say('you\'re on the list. we\'ll email ' + email.toLowerCase() + ' when it\'s here.');
          else if (j.status === 'already') say('you\'re already on the list for this one.');
          else if (j.status === 'limit') say('we have had a lot of sign-ups from this connection today. try again tomorrow.');
          else if (j.error === 'email') { input.setAttribute('aria-invalid', 'true'); say('that email doesn\'t look quite right.', true); }
          else if (j.error === 'domain') {
            input.setAttribute('aria-invalid', 'true');
            say('we couldn\'t find mail at "' + email.slice(email.lastIndexOf('@') + 1) + '". check the part after the @.', true);
            input.focus();
          }
          else if (j.status_code === 409) say('this one just arrived in the shop. refresh the page to see it.');
          else say('we could not do that just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.', true);
        }).catch(function () { say('we could not do that just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.', true); });
    });
    return box;
  }

  /* ---------- email.html: the stop link from our emails lands here ---------- */
  // nothing happens until the button is pressed, because some mail apps open every link in an email to check it
  function initEmailPage() {
    var page = document.querySelector('[data-email-page]');
    if (!page) return;
    var stopCode = new URLSearchParams(location.search).get('stop');
    var title = page.querySelector('[data-email-title]');
    var words = page.querySelector('[data-email-words]');
    var go = page.querySelector('[data-email-go]');
    var status = page.querySelector('[data-email-status]');
    if (!stopCode) {
      title.textContent = 'nothing to do here.';
      words.textContent = 'this page is for the links in our emails.';
      return;
    }
    title.textContent = 'stop these emails?';
    words.textContent = 'we\'ll take this address off every list. you won\'t hear from us about new pins.';
    go.textContent = 'stop emailing me';
    go.hidden = false;
    go.addEventListener('click', function () {
      go.disabled = true;
      status.textContent = 'one moment.';
      fetch('/api/notify/stop', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: stopCode })
      }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (j) {
        status.textContent = '';
        if (j.stopped) {
          title.textContent = 'done.';
          words.textContent = 'this address is off every list. you won\'t hear from us again unless you ask.';
        } else {
          title.textContent = 'that link didn\'t work.';
          words.textContent = 'it may be cut short. write to us at ' + CONTACT_EMAIL + ' and we\'ll take you off.';
        }
        go.hidden = true;
        // the code has done its job: keep it out of the address bar and history
        try { history.replaceState(null, '', location.pathname); } catch (e) {}
      }).catch(function () {
        go.disabled = false;
        status.textContent = 'we could not reach the server. try again in a moment.';
      });
    });
  }

  // the buy button, the price and the stock line for one size, kept in step when the size changes
  function buyArea(p, btnClass) {
    if (p.preorder) return preorderArea(p);
    if (p.available === false) return interestArea(p, btnClass);
    var area = el('div', 'buy');
    var price = el('p', 'price', '');
    var stock = el('p', 'caption stock-line', '');
    stock.setAttribute('aria-live', 'polite');
    var btn = el('button', btnClass, '');
    btn.type = 'button';
    var current = p.sizes[0] || null;
    function show(sz) {
      current = sz;
      price.textContent = sz ? priceOf(sz) : '';
      stock.textContent = stockText(sz);
      stock.hidden = !stock.textContent;
      btn.textContent = buttonLabel(sz);
      btn.disabled = !(sz && buyable(catalog.byKey[sz.key]));
    }
    btn.addEventListener('click', function () { if (current) addToBag(current.key, btn, 'add to bag'); });
    area.appendChild(price);
    if (p.sizes.length > 1) area.appendChild(sizePicker(p, show));
    area.appendChild(stock);
    area.appendChild(btn);
    show(current);
    return area;
  }

  function sizePicker(p, onPick) {
    var fs = el('fieldset', 'size-pick');
    fs.appendChild(el('legend', 'sr-only', 'size'));
    p.sizes.forEach(function (sz, i) {
      var id = 'size-' + p.slug + '-' + sz.size;
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'size-' + p.slug;
      radio.id = id;
      radio.value = sz.key;
      if (i === 0) radio.checked = true;
      radio.addEventListener('change', function () { if (radio.checked) onPick(sz); });
      var lab = el('label', null, sz.size + ', ' + priceOf(sz));
      lab.htmlFor = id;
      fs.appendChild(radio);
      fs.appendChild(lab);
    });
    return fs;
  }

  // boards with a page of their own, for a closer look
  var BOARD_PAGE = { 'bay-area-pin-board': '/bay-area-pin-board' };

  function boardCard(p) {
    var card = el('article', 'card clean product product--board');
    var art = el(BOARD_PAGE[p.slug] ? 'a' : 'div', 'art');
    if (BOARD_PAGE[p.slug]) {
      art.href = BOARD_PAGE[p.slug];
      art.setAttribute('aria-label', 'see the ' + p.name + ' up close');
    }
    var img = el('img');
    img.src = BOARD_IMG[p.slug] || BOARD_IMG['bay-area-pin-board'];
    if (BOARD_SRCSET[p.slug]) { img.srcset = BOARD_SRCSET[p.slug]; img.sizes = '280px'; }
    img.alt = BOARD_PAGE[p.slug] ? '' : 'the ' + p.name + ' design';
    img.loading = 'lazy';
    art.appendChild(img);
    card.appendChild(art);
    var info = el('div', 'info');
    info.appendChild(el('h3', 'name', p.name));
    var buy = buyArea(p, 'jka-btn jka-btn--quiet jka-btn--sm');
    var desc = el('p', 'body-sm muted', p.description || '');
    buy.insertBefore(desc, buy.querySelector('.stock-line'));
    info.appendChild(buy);
    card.appendChild(info);
    return card;
  }

  /* ---------- see in 3D ---------- */
  var MODEL_3D = {};
  ['aussie', 'beagle', 'corgi', 'doodle', 'german-shepherd', 'golden', 'husky', 'pit-bull', 'pomeranian', 'pug', 'rottweiler', 'shiba'].forEach(function (s) {
    // ?v= changes whenever the model files are redone: /assets/3d/ is cached as never-changing (see _headers)
    MODEL_3D[s] = 'assets/3d/' + s + '.glb?v=6';
  });
  var MV_SRC = 'https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js';
  var mvPromise = null;
  function loadViewerLib() {
    if (window.customElements && customElements.get('model-viewer')) return Promise.resolve();
    if (mvPromise) return mvPromise;
    mvPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.type = 'module';
      s.src = MV_SRC;
      s.onload = function () { resolve(); };
      s.onerror = function () { mvPromise = null; reject(new Error('viewer library')); };
      document.head.appendChild(s);
    });
    return mvPromise;
  }

  var v3d = null;
  function buildViewer() {
    var root = el('div', 'v3d');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', '3D view');
    root.setAttribute('aria-hidden', 'true');
    var card = el('div', 'v3d-card');
    var head = el('div', 'v3d-head');
    var title = el('h2', 'v3d-title');
    var close = el('button', 'icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', 'close the 3D view');
    close.appendChild(svg(['M6 6l12 12', 'M18 6L6 18']));
    head.appendChild(title);
    head.appendChild(close);
    var stage = el('div', 'v3d-stage');
    var status = el('p', 'v3d-status', 'loading the pin.');
    stage.appendChild(status);
    var hint = el('p', 'caption v3d-hint', 'drag to turn it. pinch or scroll to zoom.');
    card.appendChild(head);
    card.appendChild(stage);
    card.appendChild(hint);
    root.appendChild(card);
    document.body.appendChild(root);
    root.addEventListener('click', function (e) { if (e.target === root) close3d(); });
    close.addEventListener('click', close3d);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && root.classList.contains('open')) close3d();
    });
    v3d = { root: root, title: title, stage: stage, status: status, close: close, last: null };
  }

  function close3d() {
    if (!v3d || !v3d.root.classList.contains('open')) return;
    v3d.root.classList.remove('open');
    v3d.root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    var mv = v3d.stage.querySelector('model-viewer');
    if (mv) mv.remove();
    if (v3d.last && v3d.last.focus) v3d.last.focus();
  }

  function open3d(name, url, trigger) {
    if (!v3d) buildViewer();
    v3d.last = trigger;
    v3d.title.textContent = name;
    v3d.status.textContent = 'loading the pin.';
    v3d.status.hidden = false;
    var old = v3d.stage.querySelector('model-viewer');
    if (old) old.remove();
    v3d.root.classList.add('open');
    v3d.root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    v3d.close.focus();
    loadViewerLib().then(function () {
      var mv = document.createElement('model-viewer');
      mv.setAttribute('alt', 'a 3D model of the ' + name + ' pin');
      mv.setAttribute('camera-controls', '');
      mv.setAttribute('shadow-intensity', '1');
      mv.setAttribute('exposure', '1.1');
      mv.setAttribute('environment-image', 'neutral');
      mv.setAttribute('interaction-prompt', 'none');
      var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!calm) mv.setAttribute('auto-rotate', '');
      mv.addEventListener('load', function () { v3d.status.hidden = true; });
      mv.addEventListener('error', function () {
        v3d.status.hidden = false;
        v3d.status.textContent = 'we could not load the 3D view just now. try again in a moment.';
      });
      v3d.stage.appendChild(mv);
      mv.setAttribute('src', url);
    }).catch(function () {
      v3d.status.textContent = 'we could not load the 3D view just now. try again in a moment.';
    });
  }

  function pupName(p) { return p.slug === 'golden' ? 'goldie' : p.name; }

  // each pup has its own page, /pup-club/corgi (server/pup-pages.js). while a pup is open the address, the tab title
  // and the heading follow it, so a copied or shared link is to that pup; closing it goes back to the whole pack.
  // the pack's own words wait in data-pack (the worker puts them there on a pup's page). the pup's words are in its
  // card, so the intro line under the heading steps aside while a pup is open instead of saying them twice
  function pupTitle(p) {
    var name = pupName(p), breed = p.breed || p.name;
    var what = breed.indexOf(name) >= 0 ? breed : name + ' ' + breed;
    if (what.indexOf(' ') < 0) what += ' dog';
    return what + ' enamel pin. j+k adventures';
  }
  function packSpot(node) {
    if (node && !node.hasAttribute('data-pack')) node.setAttribute('data-pack', node.textContent);
    return node;
  }
  function pupAddress(p) {
    var heading = packSpot(document.querySelector('[data-pup-heading]'));
    if (!heading) return;
    var words = packSpot(document.querySelector('[data-pup-words]'));
    var title = packSpot(document.querySelector('title'));
    var path = p ? '/pup-club/' + p.slug : '/pup-club';
    if (location.pathname !== path || location.hash) {
      try { history.replaceState(null, '', path); } catch (e) {}
    }
    heading.textContent = p ? 'the ' + pupName(p) + '.' : heading.getAttribute('data-pack');
    if (words) { words.textContent = p ? '' : words.getAttribute('data-pack'); words.hidden = !!p; }
    if (title) document.title = p ? pupTitle(p) : title.getAttribute('data-pack');
  }

  function closePup() {
    var panel = document.getElementById('pup-panel');
    if (!panel || panel.hidden) return;
    pupAddress(null);
    panel.hidden = true;
    panel.textContent = '';
    var on = document.querySelector('.pup-pin[aria-current]');
    if (on) { on.removeAttribute('aria-current'); on.focus(); }
  }

  function showPup(p, btn) {
    var panel = document.getElementById('pup-panel');
    if (!panel) return;
    Array.prototype.forEach.call(document.querySelectorAll('.pup-pin'), function (b) { b.removeAttribute('aria-current'); });
    btn.setAttribute('aria-current', 'page');
    pupAddress(p);
    panel.textContent = '';
    var sheet = el('div', 'card clean pup-sheet');
    var close = el('button', 'icon-btn close');
    close.type = 'button';
    close.setAttribute('aria-label', 'close');
    close.appendChild(svg(['M6 6l12 12', 'M18 6L6 18']));
    close.addEventListener('click', closePup);
    sheet.appendChild(close);
    var modelUrl = MODEL_3D[p.slug];
    var see = el('button', 'pup-3d');
    see.type = 'button';
    see.appendChild(svg(['M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z', 'M4 7.5l8 4.5 8-4.5', 'M12 12v9']));
    see.appendChild(el('span', null, 'See in 3D'));
    if (modelUrl) {
      see.setAttribute('aria-label', 'see the ' + pupName(p) + ' pin in 3D');
      see.addEventListener('click', function () { open3d(pupName(p), modelUrl, see); });
    } else {
      see.disabled = true;
      see.setAttribute('aria-label', 'see in 3D, not available for this pin yet');
      see.title = '3D view coming soon';
    }
    sheet.appendChild(see);
    var art = el('div', 'art');
    var img = el('img');
    img.src = PIN_IMG[p.slug] || '';
    img.alt = 'the ' + pupName(p) + ' pin';
    art.appendChild(img);
    sheet.appendChild(art);
    sheet.appendChild(el('h2', 'name', pupName(p)));
    var buy = buyArea(p, 'jka-btn');
    var starLine = el('p', 'pup-star-line');
    starLine.hidden = true;
    var about = el('p', 'about', p.about || '');
    // name, price, stars, about, then size, stock and the button
    sheet.appendChild(buy.querySelector('.price'));
    sheet.appendChild(starLine);
    sheet.appendChild(about);
    sheet.appendChild(buy);
    panel.appendChild(sheet);
    panel.appendChild(reviewBlock(p, starLine));
    panel.hidden = false;
    if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /* ---------- reviews: stars and notes on each pup, approved by us first (see server/reviews.js) ---------- */
  // five stars, filled to the nearest half
  function starsEl(value) {
    var wrap = el('span', 'stars');
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', value + ' out of 5 stars');
    wrap.appendChild(el('span', 'stars-empty', '\u2605\u2605\u2605\u2605\u2605'));
    var full = el('span', 'stars-full', '\u2605\u2605\u2605\u2605\u2605');
    full.style.width = (Math.round(value * 2) / 2 / 5 * 100) + '%';
    wrap.appendChild(full);
    return wrap;
  }
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function monthYear(iso) {
    var m = /^(\d{4})-(\d{2})/.exec(iso || '');
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[1] : '';
  }
  function reviewItem(r, showPin) {
    var item = el('article', 'review');
    var top = el('div', 'review-top');
    if (showPin && PIN_IMG[r.slug]) {
      var img = el('img', 'review-pin');
      img.src = PIN_IMG[r.slug];
      img.alt = 'the ' + (r.slug === 'golden' ? 'goldie' : (PUP_BREED[r.slug] || r.slug)) + ' pin';
      img.width = 48;
      img.height = 48;
      img.loading = 'lazy';
      top.appendChild(img);
    }
    top.appendChild(starsEl(r.rating));
    item.appendChild(top);
    if (r.text) item.appendChild(el('p', 'review-text', r.text));
    if (r.photos && r.photos.length) {
      item.appendChild(photoStrip(r.photos.map(function (ph) { return { src: photoUrl(ph.id), w: ph.w, h: ph.h }; }), r.name));
    }
    item.appendChild(el('p', 'review-by', r.name + (monthYear(r.date) ? ', ' + monthYear(r.date) : '') + '.'));
    return item;
  }

  /* ---------- review photos: up to four on a review, shown once we approve it (see server/photos.js) ---------- */
  var MAX_PHOTOS = 4;
  function photoUrl(id) { return '/api/reviews/photo?id=' + encodeURIComponent(id); }
  function photoAlt(name, i, n) { return 'photo ' + (i + 1) + ' of ' + n + ' from ' + name + '\'s review'; }

  // a row of small square photos; tapping one opens it big
  function photoStrip(pics, name) {
    var row = el('div', 'review-photos');
    pics.forEach(function (pic, i) {
      var b = el('button', 'review-photo');
      b.type = 'button';
      b.setAttribute('aria-label', 'open ' + photoAlt(name, i, pics.length));
      var img = el('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 72;
      img.height = 72;
      img.src = pic.src;
      b.appendChild(img);
      b.addEventListener('click', function () { openPhotos(pics, i, name, b); });
      row.appendChild(b);
    });
    return row;
  }

  // the big view: one photo at a time, with previous and next when there are more. escape or the x closes it
  var pv = null;
  function buildPhotoViewer() {
    var root = el('div', 'v3d photo-view');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'review photo');
    root.setAttribute('aria-hidden', 'true');
    var card = el('div', 'v3d-card photo-view-card');
    var head = el('div', 'v3d-head');
    var count = el('p', 'caption', '');
    count.setAttribute('aria-live', 'polite');
    var close = el('button', 'icon-btn');
    close.type = 'button';
    close.setAttribute('aria-label', 'close the photo');
    close.appendChild(svg(['M6 6l12 12', 'M18 6L6 18']));
    head.appendChild(count);
    head.appendChild(close);
    var stage = el('div', 'photo-view-stage');
    var img = el('img');
    stage.appendChild(img);
    var nav = el('div', 'photo-view-nav');
    var prev = el('button', 'icon-btn');
    prev.type = 'button';
    prev.setAttribute('aria-label', 'previous photo');
    prev.appendChild(svg(['M15 6l-6 6 6 6']));
    var next = el('button', 'icon-btn');
    next.type = 'button';
    next.setAttribute('aria-label', 'next photo');
    next.appendChild(svg(['M9 6l6 6-6 6']));
    nav.appendChild(prev);
    nav.appendChild(next);
    card.appendChild(head);
    card.appendChild(stage);
    card.appendChild(nav);
    root.appendChild(card);
    document.body.appendChild(root);
    pv = { root: root, img: img, count: count, close: close, nav: nav, pics: [], at: 0, name: '', last: null };
    function show(i) {
      pv.at = (i + pv.pics.length) % pv.pics.length;
      var pic = pv.pics[pv.at];
      pv.img.src = pic.src;
      if (pic.w && pic.h) { pv.img.width = pic.w; pv.img.height = pic.h; } else { pv.img.removeAttribute('width'); pv.img.removeAttribute('height'); }
      pv.img.alt = photoAlt(pv.name, pv.at, pv.pics.length);
      pv.count.textContent = pv.pics.length > 1 ? 'photo ' + (pv.at + 1) + ' of ' + pv.pics.length + '.' : '';
    }
    pv.show = show;
    prev.addEventListener('click', function () { show(pv.at - 1); });
    next.addEventListener('click', function () { show(pv.at + 1); });
    close.addEventListener('click', closePhotos);
    root.addEventListener('click', function (e) { if (e.target === root) closePhotos(); });
    document.addEventListener('keydown', function (e) {
      if (!root.classList.contains('open')) return;
      if (e.key === 'Escape') closePhotos();
      else if (e.key === 'ArrowLeft' && pv.pics.length > 1) show(pv.at - 1);
      else if (e.key === 'ArrowRight' && pv.pics.length > 1) show(pv.at + 1);
    });
  }
  function openPhotos(pics, i, name, trigger) {
    if (!pv) buildPhotoViewer();
    pv.pics = pics;
    pv.name = name;
    pv.last = trigger;
    pv.nav.hidden = pics.length < 2;
    pv.show(i);
    pv.root.classList.add('open');
    pv.root.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    pv.close.focus();
  }
  function closePhotos() {
    if (!pv || !pv.root.classList.contains('open')) return;
    pv.root.classList.remove('open');
    pv.root.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    if (pv.last && pv.last.focus) pv.last.focus();
  }

  // Before a photo leaves the phone: shrink it (long side 1600px) and save it as a JPEG. Drawing it fresh like
  // this leaves behind the hidden notes a camera writes inside the file, like where the photo was taken.
  var PHOTO_SIDE = 1600;
  var PHOTO_GOAL = 600 * 1024;
  function openImage(file) {
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).catch(function () { return viaImgTag(file); });
    }
    return viaImgTag(file);
  }
  function viaImgTag(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('photo')); };
      img.src = url;
    });
  }
  function canvasJpeg(c, quality) {
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { if (b) resolve(b); else reject(new Error('photo')); }, 'image/jpeg', quality);
    });
  }
  function shrinkPhoto(file) {
    return openImage(file).then(function (pic) {
      var w = pic.naturalWidth || pic.width, h = pic.naturalHeight || pic.height;
      if (!w || !h) throw new Error('photo');
      var scale = Math.min(1, PHOTO_SIDE / Math.max(w, h));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w * scale));
      c.height = Math.max(1, Math.round(h * scale));
      var ctx = c.getContext('2d');
      // a see-through png would turn black as a jpeg, so lay it on white paper first
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(pic, 0, 0, c.width, c.height);
      if (pic.close) pic.close();
      return canvasJpeg(c, 0.82).then(function (b) { return b.size > PHOTO_GOAL ? canvasJpeg(c, 0.6) : b; });
    }).then(function (blob) {
      if (blob.size > PHOTO_GOAL * 1.15) throw new Error('photo');
      return new Promise(function (resolve, reject) {
        var r = new FileReader();
        r.onload = function () { resolve({ blob: blob, jpeg: String(r.result).replace(/^data:image\/jpeg;base64,/, '') }); };
        r.onerror = function () { reject(new Error('photo')); };
        r.readAsDataURL(blob);
      });
    });
  }

  // the photo part of a review form: the ones it has, a remove button on each, and "add photos."
  // start: [{ keep: id, src }] for photos the review already has
  function photoPicker(id, start) {
    var items = (start || []).slice();
    var working = 0;
    var field = el('div', 'field photo-pick');
    var lab = el('p', 'photo-pick-label', 'photos, if you like. up to ' + MAX_PHOTOS + '.');
    lab.id = id + '-label';
    var grid = el('div', 'photo-pick-grid');
    grid.setAttribute('role', 'list');
    grid.setAttribute('aria-labelledby', lab.id);
    var input = el('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = true;
    input.id = id;
    input.className = 'sr-only';
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    var add = el('button', 'jka-btn jka-btn--quiet jka-btn--sm photo-add', 'add photos.');
    add.type = 'button';
    var note = el('p', 'review-note');
    note.setAttribute('role', 'status');
    field.appendChild(lab);
    field.appendChild(grid);
    field.appendChild(add);
    field.appendChild(input);
    field.appendChild(note);

    function paint() {
      grid.textContent = '';
      items.forEach(function (it, i) {
        var cell = el('div', 'photo-pick-item');
        cell.setAttribute('role', 'listitem');
        var img = el('img');
        img.alt = 'your photo ' + (i + 1);
        img.width = 72;
        img.height = 72;
        if (it.src) img.src = it.src;
        cell.appendChild(img);
        var x = el('button', 'photo-remove');
        x.type = 'button';
        x.setAttribute('aria-label', 'remove your photo ' + (i + 1));
        x.appendChild(svg(['M6 6l12 12', 'M18 6L6 18']));
        x.addEventListener('click', function () {
          var gone = items.splice(i, 1)[0];
          if (gone && gone.blobUrl) URL.revokeObjectURL(gone.blobUrl);
          note.textContent = '';
          paint();
          add.focus();
        });
        cell.appendChild(x);
        grid.appendChild(cell);
      });
      for (var k = 0; k < working; k++) grid.appendChild(el('div', 'photo-pick-item is-working', ''));
      add.hidden = items.length + working >= MAX_PHOTOS;
      grid.hidden = !items.length && !working;
    }
    add.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      var room = MAX_PHOTOS - items.length - working;
      var files = Array.prototype.slice.call(input.files || []);
      input.value = '';
      if (!files.length) return;
      note.textContent = files.length > room ? 'that\'s more than ' + MAX_PHOTOS + ', so we kept the first ' + (room === 1 ? 'one.' : room + '.') : '';
      files.slice(0, room).forEach(function (file) {
        working++;
        shrinkPhoto(file).then(function (pic) {
          var url = URL.createObjectURL(pic.blob);
          items.push({ jpeg: pic.jpeg, src: url, blobUrl: url });
        }).catch(function () {
          note.textContent = 'we couldn\'t open one of those photos. try a different one.';
        }).then(function () { working--; paint(); });
      });
      paint();
    });
    paint();
    return {
      field: field,
      busy: function () { return working > 0; },
      refresh: paint,
      value: function () { return items.map(function (it) { return it.keep ? { keep: it.keep } : { jpeg: it.jpeg }; }); }
    };
  }

  // a photo on your own review that we haven't approved yet: only you can see it, so ask with your ticket
  function ownPhoto(token, slug, id) {
    return fetch(photoUrl(id) + '&slug=' + encodeURIComponent(slug), { headers: { Authorization: 'Bearer ' + token } })
      .then(function (r) { if (!r.ok) throw new Error('photo'); return r.blob(); })
      .then(function (b) { return URL.createObjectURL(b); });
  }
  function photoError(r) {
    if (r.status_code === 413) return 'those photos are too big together. try fewer.';
    if (r.error === 'photo') return 'one of the photos didn\'t come through. try a different one.';
    if (r.error === 'photos off') return 'we can\'t take photos just yet. try again without them.';
    return '';
  }
  var THANKS = 'thank you! your feedback means the world to us.';
  function reviewRequest(method, query, token, body) {
    var headers = {};
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch('/api/reviews' + query, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status_code = r.status; return j; }); });
  }

  function reviewBlock(p, starLine) {
    var block = el('section', 'card clean pup-reviews');
    block.setAttribute('aria-label', 'reviews of the ' + pupName(p) + ' pin');
    block.hidden = true;
    var list = el('div', 'review-list');
    var form = el('div', 'review-form');
    block.appendChild(el('h3', 'pup-reviews-title', 'reviews'));
    block.appendChild(list);
    block.appendChild(form);
    var photosOn = false;

    signInTicket().then(function (token) {
      return reviewRequest('GET', '?slug=' + encodeURIComponent(p.slug), token).then(function (data) {
        // no reviews service (or it is resting): leave the panel as it was
        if (data.status_code !== 200) return;
        photosOn = data.photos === true;
        paintSummary(data);
        paintList(data.reviews || []);
        paintForm(token, data.mine);
        block.hidden = false;
      });
    }).catch(function () {});

    function paintSummary(data) {
      starLine.textContent = '';
      if (!data.count) { starLine.appendChild(el('span', 'muted', 'no reviews yet.')); }
      else {
        starLine.appendChild(starsEl(data.average));
        starLine.appendChild(el('span', 'muted', ' ' + data.average + ', ' + data.count + (data.count === 1 ? ' review.' : ' reviews.')));
      }
      starLine.hidden = false;
    }
    function paintList(items) {
      list.textContent = '';
      items.slice(0, 3).forEach(function (r) { list.appendChild(reviewItem(r, false)); });
      if (items.length > 3) {
        var more = el('button', 'link-btn', 'show all ' + items.length + ' reviews.');
        more.type = 'button';
        more.addEventListener('click', function () {
          more.remove();
          items.slice(3).forEach(function (r) { list.appendChild(reviewItem(r, false)); });
        });
        list.appendChild(more);
      }
    }
    function paintForm(token, mine) {
      form.textContent = '';
      if (!token) { paintGuestForm(); return; }
      var f = el('form');
      f.noValidate = true;
      var fs = el('fieldset', 'star-input');
      fs.appendChild(el('legend', null, mine ? 'your review' : 'leave a review'));
      var picked = mine ? mine.rating : 0;
      var labels = [];
      for (var i = 1; i <= 5; i++) {
        var radio = el('input');
        radio.type = 'radio';
        radio.name = 'rating';
        radio.value = String(i);
        radio.id = 'rating-' + p.slug + '-' + i;
        radio.className = 'sr-only';
        if (i === picked) radio.checked = true;
        var lab = el('label', null, '\u2605');
        lab.htmlFor = radio.id;
        lab.appendChild(el('span', 'sr-only', i === 1 ? '1 star' : i + ' stars'));
        fs.appendChild(radio);
        fs.appendChild(lab);
        labels.push(lab);
      }
      function light(n) { labels.forEach(function (l, k) { l.classList.toggle('on', k < n); }); }
      light(picked);
      fs.addEventListener('change', function (e) { picked = Number(e.target.value); light(picked); });
      f.appendChild(fs);
      var field = el('div', 'field');
      var tl = el('label', null, 'a few words, if you like.');
      tl.htmlFor = 'review-text-' + p.slug;
      var ta = el('textarea');
      ta.id = tl.htmlFor;
      ta.rows = 3;
      ta.maxLength = 600;
      ta.value = mine ? mine.text : '';
      field.appendChild(tl);
      field.appendChild(ta);
      f.appendChild(field);
      var had = (mine && mine.photos) || [];
      var picker = null;
      if (photosOn || had.length) {
        var start = had.map(function (ph) { return { keep: ph.id, src: '' }; });
        picker = photoPicker('review-photos-' + p.slug, start);
        f.appendChild(picker.field);
        // your own photos may still be waiting for us, so they come with your ticket
        start.forEach(function (it) {
          ownPhoto(token, p.slug, it.keep).then(function (url) {
            it.src = url;
            it.blobUrl = url;
            picker.refresh();
          }).catch(function () {});
        });
      }
      var note = el('p', 'review-note');
      note.setAttribute('role', 'status');
      if (mine) {
        note.textContent = mine.status === 'approved' ? 'your review is up. you can change it here.'
          : mine.status === 'hidden' ? 'we did not post this review. write to us at ' + CONTACT_EMAIL + ' if you would like to know why.'
          : 'your review is waiting for us to read it.';
      }
      var row = el('div', 'review-actions');
      var send = el('button', 'jka-btn jka-btn--quiet jka-btn--sm', mine ? 'update your review.' : 'share your review.');
      send.type = 'submit';
      row.appendChild(send);
      if (mine) {
        var remove = el('button', 'link-btn', 'remove it.');
        remove.type = 'button';
        remove.addEventListener('click', function () {
          remove.disabled = true;
          reviewRequest('DELETE', '?slug=' + encodeURIComponent(p.slug), token).then(function (r) {
            if (r.status_code !== 200) { remove.disabled = false; note.textContent = 'we could not remove it just now. try again in a moment.'; return; }
            paintForm(token, null);
            form.querySelector('.review-note').textContent = 'your review is gone.';
          }).catch(function () { remove.disabled = false; });
        });
        row.appendChild(remove);
      }
      f.appendChild(row);
      f.appendChild(note);
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!picked) { note.textContent = 'pick from one to five stars first.'; return; }
        if (picker && picker.busy()) { note.textContent = 'one moment, your photos are still getting ready.'; return; }
        send.disabled = true;
        send.textContent = 'one moment.';
        var sending = { slug: p.slug, rating: picked, text: ta.value };
        if (picker) sending.photos = picker.value();
        reviewRequest('POST', '', token, sending).then(function (r) {
          send.disabled = false;
          if (r.status_code === 200) {
            var thanks = function () { form.querySelector('.review-note').textContent = THANKS; };
            // ask again so the form shows the photos as we saved them
            reviewRequest('GET', '?slug=' + encodeURIComponent(p.slug), token).then(function (d) {
              paintForm(token, d.mine || { rating: picked, text: ta.value.trim(), status: 'pending' });
              thanks();
            }).catch(function () {
              paintForm(token, { rating: picked, text: ta.value.trim(), status: 'pending' });
              thanks();
            });
            return;
          }
          send.textContent = mine ? 'update your review.' : 'share your review.';
          note.textContent = photoError(r) || (r.error === 'confirm email' ? 'please confirm your email first. the link is in your inbox, or send a new one from your account page.'
            : r.status_code === 401 ? 'please sign in again, then try once more.'
            : 'we could not save your review. try again, or write to us at support@ourjkadventures.com.');
        }).catch(function () {
          send.disabled = false;
          send.textContent = mine ? 'update your review.' : 'share your review.';
          note.textContent = 'we could not save your review. try again, or write to us at support@ourjkadventures.com.';
        });
      });
      form.appendChild(f);
    }

    // the stars, as radio buttons that light up to the one picked. used by both forms
    function starPicker(legend, picked, onPick) {
      var fs = el('fieldset', 'star-input');
      fs.appendChild(el('legend', null, legend));
      var labels = [];
      for (var i = 1; i <= 5; i++) {
        var radio = el('input');
        radio.type = 'radio';
        radio.name = 'rating';
        radio.value = String(i);
        radio.id = 'rating-' + p.slug + '-' + i;
        radio.className = 'sr-only';
        if (i === picked) radio.checked = true;
        var lab = el('label', null, '\u2605');
        lab.htmlFor = radio.id;
        lab.appendChild(el('span', 'sr-only', i === 1 ? '1 star' : i + ' stars'));
        fs.appendChild(radio);
        fs.appendChild(lab);
        labels.push(lab);
      }
      function light(n) { labels.forEach(function (l, k) { l.classList.toggle('on', k < n); }); }
      light(picked);
      fs.addEventListener('change', function (e) { var n = Number(e.target.value); light(n); onPick(n); });
      return fs;
    }
    function textField(id, label, type, hint) {
      var field = el('div', 'field');
      var lab = el('label', null, label);
      lab.htmlFor = id;
      var input = el(type === 'textarea' ? 'textarea' : 'input');
      input.id = id;
      if (type === 'textarea') { input.rows = 3; input.maxLength = 600; } else { input.type = type; input.maxLength = type === 'email' ? 254 : 40; }
      field.appendChild(lab);
      field.appendChild(input);
      if (hint) {
        var h = el('span', 'hint', hint);
        h.id = id + '-hint';
        input.setAttribute('aria-describedby', h.id);
        field.appendChild(h);
      }
      return { field: field, input: input };
    }

    // no account: stars, words, a name and an email, and a tick box to make an account too. the server keeps the
    // email private and the review waits for us like any other (see server/reviews.js)
    function paintGuestForm() {
      var f = el('form', 'guest-review');
      f.noValidate = true;
      var picked = 0;
      f.appendChild(starPicker('leave a review', 0, function (n) { picked = n; }));
      var words = textField('review-text-' + p.slug, 'a few words, if you like.', 'textarea');
      var who = textField('review-name-' + p.slug, 'your name', 'text', 'we show your first name and last initial.');
      who.input.autocomplete = 'name';
      var mail = textField('review-email-' + p.slug, 'your email', 'email', 'never shown. it lets us reach you about your review.');
      mail.input.autocomplete = 'email';
      mail.input.setAttribute('inputmode', 'email');
      f.appendChild(words.field);
      var picker = photosOn ? photoPicker('review-photos-' + p.slug, []) : null;
      if (picker) f.appendChild(picker.field);
      f.appendChild(who.field);
      f.appendChild(mail.field);
      var tick = el('label', 'tick');
      var box = el('input');
      box.type = 'checkbox';
      box.id = 'review-account-' + p.slug;
      tick.appendChild(box);
      tick.appendChild(el('span', null, 'create an account with us too. it keeps your reviews and orders in one place.'));
      f.appendChild(tick);
      var note = el('p', 'review-note');
      note.setAttribute('role', 'status');
      var row = el('div', 'review-actions');
      var send = el('button', 'jka-btn jka-btn--quiet jka-btn--sm', 'share your review.');
      send.type = 'submit';
      row.appendChild(send);
      var signIn = el('a', 'caption', 'have an account? sign in.');
      signIn.href = 'sign-in.html?next=pup-club.html';
      row.appendChild(signIn);
      f.appendChild(row);
      f.appendChild(note);
      var offered = null;
      function wrong(input, words) {
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        note.textContent = words;
      }
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        [who.input, mail.input].forEach(function (i) { i.removeAttribute('aria-invalid'); });
        var name = who.input.value.trim();
        var email = mail.input.value.trim();
        if (!picked) { note.textContent = 'pick from one to five stars first.'; return; }
        if (!name) { wrong(who.input, 'please add your name.'); return; }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { wrong(mail.input, 'that email doesn\'t look quite right.'); return; }
        var fix = email !== offered && suggestEmail(email);
        if (fix) {
          offered = email;
          note.textContent = 'did you mean ' + fix + '? ';
          var use = el('button', 'link-btn', 'yes, use that');
          use.type = 'button';
          use.addEventListener('click', function () { mail.input.value = fix; offered = fix; note.textContent = ''; });
          note.appendChild(use);
          note.appendChild(document.createTextNode(' or press share again to keep it.'));
          return;
        }
        if (picker && picker.busy()) { note.textContent = 'one moment, your photos are still getting ready.'; return; }
        send.disabled = true;
        send.textContent = 'one moment.';
        var sending = { slug: p.slug, rating: picked, text: words.input.value, name: name, email: email };
        if (picker) sending.photos = picker.value();
        reviewRequest('POST', '', null, sending).then(function (r) {
          send.disabled = false;
          send.textContent = 'share your review.';
          if (r.saved) {
            if (box.checked) {
              // the create page fills these in. kept for this tab only, and never in the page address
              try { sessionStorage.setItem('jka_signup', JSON.stringify({ firstName: name.split(' ')[0], email: email, from: 'review' })); } catch (err) {}
              location.href = 'create-account.html';
              return;
            }
            form.textContent = '';
            form.appendChild(el('p', 'review-note', THANKS));
            return;
          }
          if (r.error === 'already') note.textContent = 'we already have a review of this pin from that email. to change it, write to us at ' + CONTACT_EMAIL + '.';
          else if (r.error === 'limit') note.textContent = 'we have had a lot of reviews from this connection today. try again tomorrow.';
          else if (r.error === 'domain') wrong(mail.input, 'we couldn\'t find mail at "' + email.slice(email.lastIndexOf('@') + 1) + '". check the part after the @.');
          else if (r.error === 'email') wrong(mail.input, 'that email doesn\'t look quite right.');
          else if (r.error === 'name') wrong(who.input, 'please add your name.');
          else if (photoError(r)) note.textContent = photoError(r);
          else note.textContent = 'we could not save your review. try again, or write to us at ' + CONTACT_EMAIL + '.';
        }).catch(function () {
          send.disabled = false;
          send.textContent = 'share your review.';
          note.textContent = 'we could not save your review. try again, or write to us at ' + CONTACT_EMAIL + '.';
        });
      });
      form.appendChild(f);
    }
    return block;
  }

  // the home page: approved 4 and 5 star reviews with words. the section stays hidden until there is one.
  function initKindWords() {
    var section = document.getElementById('kind-words');
    var list = section && section.querySelector('[data-kind-words]');
    if (!list) return;
    reviewRequest('GET', '?featured=1').then(function (data) {
      var items = (data.status_code === 200 && data.reviews) || [];
      if (!items.length) return;
      items.forEach(function (r) {
        var card = reviewItem(r, true);
        card.classList.add('card', 'clean');
        list.appendChild(card);
      });
      section.hidden = false;
    }).catch(function () {});
  }

  // phones can't hover, so pressing and holding a pin does what hovering does: a shake and a woof.
  // letting go after a hold does not open the pin; a quick tap still does.
  function addHoldShake(b) {
    var timer = null;
    function stop() { clearTimeout(timer); timer = null; b.classList.remove('is-held'); }
    b.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      b.removeAttribute('data-held');
      timer = setTimeout(function () { b.setAttribute('data-held', '1'); b.classList.add('is-held'); }, 300);
    });
    b.addEventListener('pointerup', stop);
    b.addEventListener('pointercancel', function () { stop(); b.removeAttribute('data-held'); });
    b.addEventListener('pointerleave', stop);
    b.addEventListener('contextmenu', function (e) { if (timer || b.classList.contains('is-held')) e.preventDefault(); });
  }

  function buildPupBoard(grid, bySlug) {
    grid.textContent = '';
    var shown = 0;
    PUP_ORDER.forEach(function (s) {
      var p = bySlug[s];
      if (!p) return;
      // a real link to the pup's own page, so search engines can follow it (they don't press buttons) and a
      // ctrl-click or long press opens it in a new tab. a plain tap still opens the pup right here on the board
      var b = el('a', 'pup-pin');
      b.href = '/pup-club/' + s;
      b.setAttribute('data-breed', PUP_BREED[s] || p.name);
      b.setAttribute('data-slug', s);
      b.setAttribute('aria-label', pupName(p) + ' pin' + (priceRange(p) ? ', ' + priceRange(p) : ''));
      var img = el('img');
      img.src = PIN_IMG[s] || '';
      img.width = 900;
      img.height = 900;
      img.alt = 'the ' + pupName(p) + ' enamel pin';
      img.draggable = false;
      b.appendChild(img);
      addHoldShake(b);
      b.addEventListener('click', function (e) {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button > 0) return;
        e.preventDefault();
        if (b.getAttribute('data-held')) { b.removeAttribute('data-held'); return; }
        showPup(p, b);
      });
      grid.appendChild(b);
      shown++;
    });
    if (!shown) grid.appendChild(el('p', 'notice', 'the pack is out for a walk. check back soon.'));
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !(v3d && v3d.root.classList.contains('open')) && !(pv && pv.root.classList.contains('open'))) closePup();
    });
  }

  // a pup's own page, /pup-club/corgi, opens that pup straight away. so does an older link like pup-club.html#corgi,
  // which then moves to the pup's own address
  function openPupFromAddress(grid) {
    var m = /^\/pup-club\/([a-z0-9-]+)$/.exec(location.pathname);
    var slug = m ? m[1] : decodeURIComponent((location.hash || '').slice(1));
    slug = RENAMED_PUPS[slug] || slug;
    var p = slug && catalog.items[slug];
    if (!p || p.kind !== 'pin') return;
    var btn = Array.prototype.find.call(grid.querySelectorAll('.pup-pin'), function (b) { return b.getAttribute('data-slug') === slug; });
    if (btn) showPup(p, btn);
  }

  /* ---------- the shop: featured carousel ---------- */
  // the framed board: a small copy, and the full-size one for sharp screens
  var BOARD_IMG = { 'bay-area-pin-board': 'assets/img/bay-area-board-wall.webp' };
  var BOARD_SRCSET = { 'bay-area-pin-board': 'assets/img/bay-area-board-wall.webp 280w, assets/img/bay-area-board-full.webp 1118w' };
  var SERIES_PAGE = { 'pup-club': '/pup-club', hometown: '/hometown-series', zodiac: '/chinese-zodiac' };
  // where a featured product's picture is, and which page it opens
  function featuredItem(p) {
    var img = p.kind === 'board' ? BOARD_IMG[p.slug] : PIN_IMG[p.slug];
    var href = p.kind === 'board' ? (BOARD_PAGE[p.slug] || '/pin-boards')
      : p.series === 'pup-club' ? '/pup-club/' + encodeURIComponent(p.slug) : (SERIES_PAGE[p.series] || '/shop');
    if (!img) return null;
    var name = p.kind === 'board' ? p.name : pupName(p);
    var price = priceRange(p);
    return { href: href, img: img, srcset: p.kind === 'board' ? BOARD_SRCSET[p.slug] : '', board: p.kind === 'board', name: name, price: price, label: name + (p.kind === 'board' ? '' : ' pin') + (price ? ', ' + price : '') };
  }
  function buildFeatured(band) {
    var ring = band.querySelector('[data-featured-ring]');
    var items = catalog.featured.map(function (slug) { return catalog.items[slug]; })
      .filter(Boolean).map(featuredItem).filter(Boolean);
    if (!ring || !items.length || !window.Featured) { band.hidden = true; return; }
    band.hidden = false;
    window.Featured.mount(ring, items);
  }

  // "most asked for": products not in the shop yet, by how many said "i'm interested". hidden until someone has
  var WANTED_MAX = 6;
  function buildWanted(box) {
    var list = box.querySelector('[data-wanted-list]');
    var rows = Object.keys(catalog.items).map(function (s) { return catalog.items[s]; })
      .filter(function (p) { return p.available === false && !p.preorder && p.interest > 0; })
      .sort(function (a, b) { return b.interest - a.interest; }).slice(0, WANTED_MAX);
    if (!list || !rows.length) { box.hidden = true; return; }
    list.textContent = '';
    rows.forEach(function (p) {
      var f = featuredItem(p);
      var li = el('li', 'wanted-row');
      var a = el('a', 'wanted-link');
      a.href = f ? f.href : '/shop';
      if (f && f.img) {
        var img = el('img');
        img.src = f.img;
        img.alt = '';
        img.width = 48;
        img.height = 48;
        img.loading = 'lazy';
        a.appendChild(img);
      }
      var words = el('span', 'set-btn-words');
      words.appendChild(el('span', 'set-btn-name', f ? f.name : p.name));
      words.appendChild(el('span', 'set-btn-note', interestedWords(p.interest)));
      a.appendChild(words);
      li.appendChild(a);
      list.appendChild(li);
    });
    box.hidden = false;
  }

  function loadShop() {
    var pupGrid = document.getElementById('pup-grid');
    var boardSlot = document.getElementById('board-slot');
    var boardBuy = document.getElementById('board-buy');
    var featured = document.querySelector('[data-featured]');
    var wanted = document.querySelector('[data-wanted]');
    if (!pupGrid && !boardSlot && !boardBuy && !featured && !wanted) return;
    function draw() {
      if (boardBuy) {
        boardBuy.textContent = '';
        var bb = catalog.items['bay-area-pin-board'];
        if (!bb) { boardBuy.appendChild(el('p', 'notice', 'the board is out for a walk. check back soon.')); }
        else {
          var area = buyArea(bb, 'jka-btn');
          area.insertBefore(el('p', 'body-lg muted', bb.description || ''), area.querySelector('.stock-line'));
          boardBuy.appendChild(area);
        }
      }
      if (pupGrid) { buildPupBoard(pupGrid, catalog.items); openPupFromAddress(pupGrid); }
      if (boardSlot) {
        boardSlot.textContent = '';
        var b = catalog.items['bay-area-pin-board'];
        if (b) boardSlot.appendChild(boardCard(b));
        else boardSlot.appendChild(el('p', 'notice', 'the board is out for a walk too. check back soon.'));
      }
    }
    loadCatalog().then(function () {
      if (featured) buildFeatured(featured);
      if (wanted) buildWanted(wanted);
      draw();
    }).catch(function () {
      // the shop's live list (/api/catalog) didn't answer. still show the pups and the board from products.json,
      // with nothing for sale (no sizes, no prices, the shop counts as closed), so the page is never just an
      // error: an empty board reads as a dead page to people, and to google (a "soft 404")
      var msg = 'we could not reach the shop just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
      function sorry() {
        if (pupGrid) { pupGrid.textContent = ''; pupGrid.appendChild(el('p', 'notice', msg)); }
        if (boardSlot) { boardSlot.textContent = ''; boardSlot.appendChild(el('p', 'notice', msg)); }
        if (boardBuy) { boardBuy.textContent = ''; boardBuy.appendChild(el('p', 'notice', msg)); }
      }
      fetch('/products.json').then(function (r) {
        if (!r.ok) throw new Error('products ' + r.status);
        return r.json();
      }).then(function (j) {
        catalog.open = false;
        catalog.items = {};
        catalog.byKey = {};
        (j.items || []).forEach(function (p) {
          var copy = {};
          Object.keys(p).forEach(function (k) { copy[k] = p[k]; });
          copy.sizes = [];
          catalog.items[p.slug] = copy;
        });
        draw();
        [pupGrid, boardSlot, boardBuy].forEach(function (box) {
          if (box) box.appendChild(el('p', 'notice', 'we could not reach the shop just now, so nothing can go in the bag. try again in a moment.'));
        });
      }).catch(sorry);
    });
  }

  /* ---------- pin boards: the board on the living room wall ---------- */
  // it wiggles like a pup pin on hover, or on a long press on phones. a quick tap or click opens its page.
  function initRoom() {
    Array.prototype.forEach.call(document.querySelectorAll('.room-board'), function (board) {
      addHoldShake(board);
      board.addEventListener('click', function (e) {
        // letting go after a long press only wiggles; it doesn't leave the page
        if (board.getAttribute('data-held')) { e.preventDefault(); board.removeAttribute('data-held'); }
      });
    });
  }

  /* ---------- a board's own page: tap or click to look closer ---------- */
  // like a magnifying glass: zoomed in, the picture follows your mouse, or your finger as you drag
  function initZoom() {
    var view = document.querySelector('[data-zoom]');
    if (!view) return;
    var img = view.querySelector('img');
    var hint = document.querySelector('[data-zoom-hint]');
    var zoomed = false, x = 50, y = 50, drag = null, moved = false;
    function place() { img.style.transformOrigin = x + '% ' + y + '%'; }
    function at(e) {
      var r = view.getBoundingClientRect();
      x = Math.max(0, Math.min(100, (e.clientX - r.left) / r.width * 100));
      y = Math.max(0, Math.min(100, (e.clientY - r.top) / r.height * 100));
    }
    function set(on) {
      zoomed = on;
      view.classList.toggle('is-zoomed', on);
      view.setAttribute('aria-pressed', on ? 'true' : 'false');
      view.setAttribute('aria-label', on ? 'step back from the bay area pin board' : 'look closer at the bay area pin board');
      // phones and tablets have no mouse to hover with, so they get the words for fingers
      var fingers = window.matchMedia && window.matchMedia('(hover: none)').matches;
      if (hint) hint.textContent = on ? (fingers ? 'drag to look around. tap to step back.' : 'move around to look closer. click to step back.')
        : 'tap or click the board to look closer, and again to step back.';
      if (!on) { x = 50; y = 50; }
      place();
    }
    view.addEventListener('pointerdown', function (e) {
      drag = { touch: e.pointerType !== 'mouse', sx: e.clientX, sy: e.clientY, ox: x, oy: y };
      moved = false;
      if (zoomed && drag.touch) view.setPointerCapture(e.pointerId);
    });
    view.addEventListener('pointermove', function (e) {
      if (!zoomed) return;
      if (e.pointerType === 'mouse') { at(e); place(); return; }
      if (!drag) return;
      // a finger pushes the picture the way it moves, like sliding a photo on a table
      var r = view.getBoundingClientRect();
      var dx = (e.clientX - drag.sx) / r.width * 100, dy = (e.clientY - drag.sy) / r.height * 100;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      x = Math.max(0, Math.min(100, drag.ox - dx * 1.5));
      y = Math.max(0, Math.min(100, drag.oy - dy * 1.5));
      place();
    });
    view.addEventListener('pointerup', function () { setTimeout(function () { drag = null; }, 0); });
    view.addEventListener('pointercancel', function () { drag = null; });
    view.addEventListener('click', function (e) {
      if (moved) { moved = false; return; }
      if (!zoomed && e.detail) at(e);
      set(!zoomed);
    });
    // keyboard: enter or space zooms (the button does that), arrows look around, escape steps back
    view.addEventListener('keydown', function (e) {
      var step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[e.key];
      if (zoomed && step) {
        e.preventDefault();
        x = Math.max(0, Math.min(100, x + step[0]));
        y = Math.max(0, Math.min(100, y + step[1]));
        place();
      } else if (zoomed && e.key === 'Escape') { set(false); }
    });
  }

  /* ---------- home: the reel ---------- */
  // The video is set on the <video> as data-mp4 / data-webm / data-poster. Until then (or if it can't play)
  // the felt behind it shows. Someone who asks for less motion, or to save data, gets a still frame and a
  // play button instead of autoplay. It loops while any of it is on screen and rests once it's scrolled
  // fully out of view, picking up again when it comes back (unless someone paused it themselves).
  function initReel() {
    var reel = document.querySelector('.reel');
    var video = reel && reel.querySelector('.reel-video');
    if (!video) return;
    var mp4 = video.getAttribute('data-mp4'), webm = video.getAttribute('data-webm'), poster = video.getAttribute('data-poster');
    if (!mp4 && !webm) return;
    // phones held upright get a tall, cropped copy: fewer bytes, and sharper than the wide one stretched to fit
    var phone = window.matchMedia && (video.getAttribute('data-mp4-phone') || video.getAttribute('data-webm-phone')) ?
      window.matchMedia('(max-width: 760px) and (orientation: portrait)') : null;
    var toggle = reel.querySelector('.reel-toggle');
    var calm = (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) ||
      (navigator.connection && navigator.connection.saveData);

    if (poster) { video.poster = poster; reel.classList.add('reel--ready'); }
    function addSources() {
      var small = phone && phone.matches;
      video.textContent = '';
      [[small ? video.getAttribute('data-webm-phone') : webm, 'video/webm'],
       [small ? video.getAttribute('data-mp4-phone') : mp4, 'video/mp4']].forEach(function (f) {
        if (!f[0]) return;
        var src = document.createElement('source');
        src.src = f[0];
        src.type = f[1];
        video.appendChild(src);
      });
    }
    addSources();
    // turning the phone sideways swaps copies, picking up at the same moment
    if (phone) {
      var swap = function () {
        var at = video.currentTime, wasPlaying = !video.paused;
        addSources();
        video.addEventListener('loadedmetadata', function resume() {
          video.removeEventListener('loadedmetadata', resume);
          video.currentTime = at;
        });
        video.load();
        if (wasPlaying) video.play().catch(function () {});
      };
      if (phone.addEventListener) phone.addEventListener('change', swap); else if (phone.addListener) phone.addListener(swap);
    }
    function paint(paused) {
      reel.classList.toggle('reel--paused', paused);
      toggle.setAttribute('aria-label', paused ? 'play the video' : 'pause the video');
    }
    video.addEventListener('playing', function () { reel.classList.add('reel--playing'); paint(false); });
    video.addEventListener('pause', function () { paint(true); });
    // a missing or broken file: quietly keep the pins on felt
    video.addEventListener('error', function () { reel.classList.remove('reel--playing', 'reel--ready'); toggle.hidden = true; }, true);
    // wanted: should it play when it's on screen? off for less motion until someone presses play
    var wanted = !calm;
    toggle.addEventListener('click', function () {
      wanted = video.paused;
      if (wanted) { video.play().catch(function () {}); } else { video.pause(); }
    });
    if (window.IntersectionObserver) {
      new IntersectionObserver(function (entries) {
        if (!entries[entries.length - 1].isIntersecting) { if (!video.paused) video.pause(); }
        else if (wanted && video.paused) video.play().catch(function () {});
      }).observe(reel);
    }
    toggle.hidden = false;
    video.preload = calm ? 'metadata' : 'auto';
    video.load();
    if (calm) { paint(true); return; }
    video.autoplay = true;
    var tryPlay = video.play();
    if (tryPlay && tryPlay.catch) tryPlay.catch(function () { paint(true); });
  }

  // a small shop + bag pill that floats bottom right once the header has scrolled away,
  // or on the home page once you're halfway past the video
  function buildFloatShop() {
    var header = document.querySelector('.site-header');
    if (!header) return;
    var bar = el('div', 'float-shop');
    var shop = el('a', 'float-shop-link', 'shop');
    shop.href = '/shop';
    var bag = el('button', 'cart-btn');
    bag.type = 'button';
    bag.setAttribute('data-cart', '');
    bag.setAttribute('aria-label', 'open your bag');
    bag.appendChild(svg(['M5 8h14l-1 12H6L5 8z', 'M9 8V6.5a3 3 0 0 1 6 0V8']));
    var count = el('span', 'cart-count', '0');
    count.setAttribute('data-cart-count', '');
    count.hidden = true;
    bag.appendChild(count);
    bar.appendChild(shop);
    bar.appendChild(bag);
    document.body.appendChild(bar);

    var reel = document.querySelector('.reel');
    var queued = false;
    function place() {
      queued = false;
      var edge = reel ? reel.getBoundingClientRect().top + reel.offsetHeight / 2 : header.getBoundingClientRect().bottom;
      bar.classList.toggle('show', edge < 0);
    }
    function queue() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(place);
    }
    window.addEventListener('scroll', queue, { passive: true });
    window.addEventListener('resize', queue);
    place();
  }

  /* ---------- start ---------- */
  function init() {
    buildFloatShop();
    countEls = Array.prototype.slice.call(document.querySelectorAll('[data-cart-count]'));
    // square sends people back to thank-you.html after paying: empty the bag
    if (/thank-you(\.html)?$/.test(location.pathname)) save('jka_cart', null);
    loadCart();
    buildDrawer();
    Array.prototype.forEach.call(document.querySelectorAll('[data-cart]'), function (b) {
      b.addEventListener('click', openBag);
    });
    paintCount();
    paintAccountLink();
    initReel();
    initKindWords();
    loadShop();
    initEmailPage();
    initRoom();
    initZoom();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
