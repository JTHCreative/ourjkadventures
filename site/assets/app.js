/* j+k adventures: shop and bag. Products live in products.json; checkout is handed to Square by /api/checkout (see _worker.js). */
(function () {
  'use strict';

  var CONTACT_EMAIL = 'support@ourjkadventures.com';
  var PIN_IMG = {};
  ['aussie', 'beagle', 'cavalier', 'corgi', 'dachshund', 'french-bulldog', 'german-shepherd', 'golden', 'husky', 'pit-bull',
    'pomeranian', 'poodle', 'pug', 'rottweiler', 'shiba', 'yorkie'].forEach(function (s) { PIN_IMG[s] = 'assets/img/pins/' + s + '.webp'; });

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

  /* ---------- the catalog (products.json) ---------- */
  var catalog = { currency: 'USD', items: {} };
  var catalogPromise = null;
  function loadCatalog() {
    if (catalogPromise) return catalogPromise;
    catalogPromise = fetch('products.json', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('catalog ' + r.status);
      return r.json();
    }).then(function (j) {
      catalog.currency = j.currency || 'USD';
      catalog.shop_open = j.shop_open === true;
      (j.items || []).forEach(function (p) { catalog.items[p.slug] = p; });
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

  /* ---------- the bag: lives in this browser until checkout ---------- */
  var cart = {};
  var drawer, scrim, bodyEl, footEl, countEls, lastFocus;

  function loadCart() {
    try {
      var o = JSON.parse(read('jka_cart') || '{}');
      cart = {};
      Object.keys(o).forEach(function (s) { var q = Math.floor(Number(o[s])); if (q > 0) cart[s] = Math.min(q, 20); });
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

  function paintDrawer() {
    bodyEl.textContent = '';
    footEl.textContent = '';
    var slugs = Object.keys(cart).filter(function (s) { return catalog.items[s]; });
    if (!slugs.length) {
      bodyEl.appendChild(el('p', 'empty', 'your bag is empty. a pin would look good in it.'));
      return;
    }
    var sum = 0;
    slugs.forEach(function (s) {
      var p = catalog.items[s];
      var q = cart[s];
      sum += p.price_cents * q;
      var row = el('div', 'line');
      var name = lineName(p);
      row.appendChild(el('div', 'lname', name));
      row.appendChild(el('div', 'lprice', money(p.price_cents * q / 100, catalog.currency)));
      var ctl = el('div', 'lctl');
      var qty = el('div', 'qty');
      var minus = el('button', null, '\u2212');
      minus.type = 'button';
      minus.setAttribute('aria-label', 'one fewer ' + name);
      var plus = el('button', null, '+');
      plus.type = 'button';
      plus.setAttribute('aria-label', 'one more ' + name);
      qty.appendChild(minus);
      qty.appendChild(el('span', null, String(q)));
      qty.appendChild(plus);
      minus.addEventListener('click', function () { changeQty(s, q - 1); });
      plus.addEventListener('click', function () { changeQty(s, q + 1); });
      var rm = el('button', 'linklike', 'remove');
      rm.type = 'button';
      rm.addEventListener('click', function () { changeQty(s, 0); });
      ctl.appendChild(qty);
      ctl.appendChild(rm);
      row.appendChild(ctl);
      bodyEl.appendChild(row);
    });
    var total = el('div', 'total');
    total.appendChild(el('span', null, 'subtotal'));
    total.appendChild(el('span', null, money(sum / 100, catalog.currency)));
    footEl.appendChild(total);
    footEl.appendChild(el('p', 'caption', 'shipping and tax are added at checkout.'));
    if (!shopOpen()) {
      footEl.appendChild(el('p', 'caption', 'the shop opens soon. your bag will keep these for you.'));
      return;
    }
    var go = el('button', 'jka-btn', 'check out');
    go.type = 'button';
    go.addEventListener('click', checkout);
    footEl.appendChild(go);
  }

  function refreshCart() {
    return loadCatalog().then(function () { paintCount(); paintDrawer(); }).catch(function () {
      bodyEl.textContent = '';
      footEl.textContent = '';
      bodyEl.appendChild(el('p', 'empty', 'we could not open your bag just now. try again in a moment.'));
    });
  }

  function changeQty(slug, qty) {
    if (qty < 1) delete cart[slug]; else cart[slug] = Math.min(qty, 20);
    saveCart();
    paintCount();
    paintDrawer();
  }

  function lineName(p) { return (p.slug === 'golden' ? 'goldie' : p.name) + (p.kind === 'board' ? '' : ' pin'); }

  function checkout() {
    var btn = footEl.querySelector('.jka-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'one moment.'; }
    var items = Object.keys(cart).map(function (s) { return { slug: s, qty: cart[s] }; });
    signInTicket().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch('/api/checkout', { method: 'POST', headers: headers, body: JSON.stringify({ items: items }) });
    }).then(function (r) {
      return r.json().then(function (j) { if (!r.ok || !j.url) throw new Error('checkout'); return j.url; });
    }).then(function (url) {
      location.href = url;
    }).catch(function () {
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
  function addToBag(slug, btn, label) {
    cart[slug] = Math.min((cart[slug] || 0) + 1, 20);
    saveCart();
    paintCount();
    btn.disabled = true;
    btn.textContent = 'in your bag.';
    setTimeout(function () { btn.textContent = label; btn.disabled = false; }, 1600);
  }

  /* ---------- the shop ---------- */
  var PUP_ORDER = ['aussie', 'beagle', 'cavalier', 'corgi', 'dachshund', 'french-bulldog', 'german-shepherd', 'golden', 'husky',
    'pit-bull', 'pomeranian', 'poodle', 'pug', 'rottweiler', 'shiba', 'yorkie'];
  var PUP_BREED = {
    'aussie': 'australian shepherd', 'beagle': 'beagle', 'cavalier': 'cavalier king charles spaniel', 'corgi': 'corgi',
    'dachshund': 'dachshund', 'french-bulldog': 'french bulldog', 'german-shepherd': 'german shepherd', 'golden': 'golden retriever',
    'husky': 'siberian husky', 'pit-bull': 'pit bull', 'pomeranian': 'pomeranian', 'poodle': 'poodle', 'pug': 'pug',
    'rottweiler': 'rottweiler', 'shiba': 'shiba inu', 'yorkie': 'yorkshire terrier'
  };
  var PUP_ABOUT = {
    'aussie': 'an australian shepherd with a merle coat and eyes that never quite match. happiest with a job to do, even if the job is following you from room to room.',
    'beagle': 'a beagle, led by the nose and a little by the heart. the one who hears a snack bag from three rooms away and sings about it.',
    'cavalier': 'a cavalier king charles spaniel, soft-eared and built for laps. a gentle shadow who is never more than one cushion away.',
    'corgi': 'a corgi, all fluff and short legs. the loaf-shaped one who trots instead of walks and is certain the whole yard belongs to them.',
    'dachshund': 'a dachshund, long and low and entirely sure of themselves. brave enough to bark at a dog ten times their size from behind the couch.',
    'french-bulldog': 'a french bulldog with bat ears and a snore like a tiny engine. sighs dramatically, then falls asleep on your feet.',
    'german-shepherd': 'a german shepherd, loyal down to the bone. keeps watch over the whole house and still wants a belly rub.',
    'golden': 'a golden retriever, sunshine with a tail. will carry a stick, a shoe or a very large branch to greet you, and means it every time.',
    'husky': 'a husky with ice-blue eyes and plenty to say. will tell you all about their day, usually right around dinner.',
    'pit-bull': 'a pit bull with a wide grin and a wagging back half. gentle with the people they love, and fully convinced they are a lap dog.',
    'pomeranian': 'a pomeranian, a small cloud with a big opinion. fluffed up like they are twice the size, and expecting you to agree.',
    'poodle': 'a poodle, quick and clever and a little bit fancy. learns the trick on the second try, then shows everyone else how it is done.',
    'pug': 'a pug with a wrinkled brow and a whole lot of love. snorts, snuffles and follows you to the kitchen on principle.',
    'rottweiler': 'a rottweiler who is mostly a big softie. all that seriousness melts the moment someone says the word walk.',
    'shiba': 'a shiba inu with a fox-like smile and a mind of their own. politely declines to do things, then does them exactly when they please.',
    'yorkie': 'a yorkshire terrier, small in size and large in personality. a tiny boss in a silky coat who runs the house with a bark and a wink.'
  };

  function priceOf(p) { return money(p.price_cents / 100, catalog.currency); }
  function shopOpen() { return catalog.shop_open === true; }
  function soldOut(p) { return !shopOpen() || !!p.sold_out; }
  function soldOutLabel() { return shopOpen() ? 'sold out' : 'coming soon'; }

  function boardCard(p) {
    var card = el('article', 'card clean product product--board');
    var art = el('div', 'art');
    var img = el('img');
    img.src = 'assets/img/bay-area-board.webp';
    img.alt = 'the ' + p.name + ' design';
    img.loading = 'lazy';
    art.appendChild(img);
    card.appendChild(art);
    var info = el('div', 'info');
    info.appendChild(el('h3', 'name', p.name));
    info.appendChild(el('p', 'price', priceOf(p)));
    info.appendChild(el('p', 'body-sm muted', p.description || ''));
    var b = el('button', 'jka-btn jka-btn--quiet jka-btn--sm', soldOut(p) ? soldOutLabel() : 'add to bag');
    b.type = 'button';
    if (soldOut(p)) b.disabled = true;
    else b.addEventListener('click', function () { addToBag(p.slug, b, 'add to bag'); });
    info.appendChild(b);
    card.appendChild(info);
    return card;
  }

  /* ---------- see in 3D ---------- */
  var MODEL_3D = {};
  ['aussie', 'beagle', 'corgi', 'german-shepherd', 'golden', 'husky', 'pit-bull', 'pomeranian', 'pug', 'shiba'].forEach(function (s) {
    MODEL_3D[s] = 'assets/3d/' + s + '.glb';
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

  function closePup() {
    var panel = document.getElementById('pup-panel');
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    panel.textContent = '';
    var on = document.querySelector('.pup-pin[aria-pressed="true"]');
    if (on) { on.setAttribute('aria-pressed', 'false'); on.focus(); }
  }

  function showPup(p, btn) {
    var panel = document.getElementById('pup-panel');
    if (!panel) return;
    Array.prototype.forEach.call(document.querySelectorAll('.pup-pin'), function (b) { b.setAttribute('aria-pressed', 'false'); });
    btn.setAttribute('aria-pressed', 'true');
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
    sheet.appendChild(el('p', 'price', priceOf(p)));
    sheet.appendChild(el('p', 'about', PUP_ABOUT[p.slug] || ''));
    var b = el('button', 'jka-btn', soldOut(p) ? soldOutLabel() : 'add to bag');
    b.type = 'button';
    if (soldOut(p)) b.disabled = true;
    else b.addEventListener('click', function () { addToBag(p.slug, b, 'add to bag'); });
    sheet.appendChild(b);
    panel.appendChild(sheet);
    panel.hidden = false;
    if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
      var b = el('button', 'pup-pin');
      b.type = 'button';
      b.setAttribute('data-breed', PUP_BREED[s] || p.name);
      b.setAttribute('aria-label', p.name + ' pin, ' + priceOf(p));
      b.setAttribute('aria-pressed', 'false');
      var img = el('img');
      img.src = PIN_IMG[s] || '';
      img.alt = '';
      img.draggable = false;
      b.appendChild(img);
      addHoldShake(b);
      b.addEventListener('click', function () {
        if (b.getAttribute('data-held')) { b.removeAttribute('data-held'); return; }
        showPup(p, b);
      });
      grid.appendChild(b);
      shown++;
    });
    if (!shown) grid.appendChild(el('p', 'notice', 'the pack is out for a walk. check back soon.'));
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !(v3d && v3d.root.classList.contains('open'))) closePup();
    });
  }

  function loadShop() {
    var pupGrid = document.getElementById('pup-grid');
    var boardSlot = document.getElementById('board-slot');
    if (!pupGrid && !boardSlot) return;
    loadCatalog().then(function () {
      if (pupGrid) buildPupBoard(pupGrid, catalog.items);
      if (boardSlot) {
        boardSlot.textContent = '';
        var b = catalog.items['bay-area-pin-board'];
        if (b) boardSlot.appendChild(boardCard(b));
        else boardSlot.appendChild(el('p', 'notice', 'the board is out for a walk too. check back soon.'));
      }
    }).catch(function () {
      var msg = 'we could not reach the shop just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
      if (pupGrid) { pupGrid.textContent = ''; pupGrid.appendChild(el('p', 'notice', msg)); }
      if (boardSlot) { boardSlot.textContent = ''; boardSlot.appendChild(el('p', 'notice', msg)); }
    });
  }

  /* ---------- home: the reel ---------- */
  // The video is set on the <video> as data-mp4 / data-webm / data-poster. Until then (or if it can't play)
  // the pins on felt behind it stay in view. Someone who asks for less motion, or to save data, gets a
  // still frame and a play button instead of autoplay.
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
    toggle.addEventListener('click', function () {
      if (video.paused) { video.play().catch(function () {}); } else { video.pause(); }
    });
    toggle.hidden = false;
    video.preload = calm ? 'metadata' : 'auto';
    video.load();
    if (calm) { paint(true); return; }
    video.autoplay = true;
    var tryPlay = video.play();
    if (tryPlay && tryPlay.catch) tryPlay.catch(function () { paint(true); });
  }

  /* ---------- start ---------- */
  function init() {
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
    loadShop();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
