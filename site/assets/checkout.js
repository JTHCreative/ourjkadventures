/* j+k adventures: the checkout page (/checkout). Where it goes, shipping, payment and an optional tip, with the
   order summary beside it. The bag, the catalog and their words come from app.js (window.JKA).

   Paying: Square's own card form sits inside our page (the Web Payments SDK, loaded from Square). Like a
   payment terminal on our counter that belongs to the bank: the card number goes into Square's box, never ours.
   Square hands back a one-time token, and our server (/api/checkout/pay, server/checkout.js) makes the order and
   charges that token. Every price, the tax and the tip's percentages are worked out on the server; this page only
   shows them (/api/checkout/quote). While the card form isn't set up (no SQUARE_APPLICATION_ID), the pay button
   goes to Square's hosted payment page instead, as before. */
(function () {
  'use strict';

  var J = window.JKA;
  var page = document.querySelector('[data-checkout]');
  if (!J || !page) return;
  var el = J.el;
  var catalog = J.catalog;

  var $ = function (sel) { return page.querySelector(sel); };
  var form = $('[data-co-form]');
  var payBtn = $('[data-co-pay]');
  var errBox = $('[data-co-error]');

  var TIPS = [{ id: 'none', label: 'no tip' }, { id: '5', percent: 5 }, { id: '10', percent: 10 }, { id: '15', percent: 15 }, { id: 'own', label: 'other' }];
  var TIP_MAX = 100;

  var SAYS = {
    name: 'who should we send it to?',
    email: 'that email doesn\'t look quite right.',
    line1: 'we need a street address.',
    city: 'which city?',
    state: 'pick the state it\'s going to.',
    zip: 'that zip code doesn\'t look right. five numbers, like 94607.'
  };
  var CARD_SAYS = {
    cvv: 'the security code on the card didn\'t match. could you check it?',
    expiry: 'the expiry date on the card didn\'t work. could you check it?',
    zip: 'the zip code didn\'t match the card. it\'s the one in the card form, where your bank sends statements.',
    funds: 'the card was declined for not having enough on it. another card might work.',
    card: 'that card number didn\'t work. could you check it, or try another card?',
    verify: 'your bank wanted to check it was you, and that didn\'t finish. could you try again?',
    declined: 'your card was declined. you could try again or use another card. nothing was charged.'
  };

  var card = null;         // Square's card form, once it's on the page
  var payments = null;     // Square's payments, for Apple Pay and Google Pay
  var walletRequest = null;
  var cardMode = false;    // true: pay here with Square's form. false: Square's hosted page
  var lastQuote = null;
  // Google Pay or Apple Pay filled in, not charged yet: { name, token, key, total, card }. the pay button takes it
  var walletPay = null;
  var quoteAsk = 0;
  var busy = false;
  // one "pay" press. kept while retrying after a dropped connection, so nothing is charged twice; new after a decline.
  // remembered in this browser for half an hour (jka_pay_attempt), so a tab closed mid-payment and opened again can
  // ask whether it went through (/api/checkout/status) instead of paying a second time
  var ATTEMPT_KEEP_MS = 30 * 60 * 1000;
  var attempt = savedAttempt() || newAttempt();

  function savedAttempt() {
    try {
      var a = JSON.parse(J.read('jka_pay_attempt') || 'null');
      return a && typeof a.id === 'string' && Date.now() - a.at < ATTEMPT_KEEP_MS ? a.id : null;
    } catch (e) { return null; }
  }
  function rememberAttempt() { J.save('jka_pay_attempt', JSON.stringify({ id: attempt, at: Date.now() })); }
  // the last pay press went through after all: straight to the thank-you page, which empties the bag
  function checkLastPress() {
    var id = savedAttempt();
    if (!id) return Promise.resolve(false);
    return fetch('/api/checkout/status?attempt=' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (j) {
        if (j && j.paid && typeof j.url === 'string') { location.replace(j.url); return true; }
        return false;
      }).catch(function () { return false; });
  }

  function newAttempt() {
    try { if (crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function cents(c) { return J.money(c / 100, catalog.currency); }

  /* ---------- what's in the bag that can be bought ---------- */
  function items() {
    var cart = J.cart();
    return Object.keys(cart).filter(function (k) { return J.buyable(catalog.byKey[k]); })
      .map(function (k) { return { key: k, qty: Math.min(cart[k], catalog.byKey[k].size.stock) }; });
  }

  /* ---------- the form: remembered in this tab, so a reload or a trip to the bag keeps it ---------- */
  var boxes = {};
  ['email', 'name', 'line1', 'line2', 'city', 'state', 'zip'].forEach(function (k) {
    var input = $('#co-' + k);
    boxes[k] = { input: input, msg: $('#co-' + k + '-msg') };
    input.addEventListener('input', function () { clearFlag(k); remember(); });
  });
  var giftTick = $('[data-co-gift]');
  var giftNoteWrap = $('[data-co-gift-note]');
  var giftNote = $('#co-gift-note');
  var giftHint = $('#co-gift-hint');

  function readSaved() {
    try { return JSON.parse(sessionStorage.getItem('jka_ship_to') || '{}') || {}; } catch (e) { return {}; }
  }
  function values() {
    var o = {};
    Object.keys(boxes).forEach(function (k) { o[k] = boxes[k].input.value.trim(); });
    o.gift = giftTick.checked;
    o.message = giftNote.value;
    return o;
  }
  function remember() {
    try { sessionStorage.setItem('jka_ship_to', JSON.stringify(values())); } catch (e) {}
  }
  function flag(k, words) {
    var b = boxes[k];
    if (!b) return;
    b.input.setAttribute('aria-invalid', 'true');
    b.msg.textContent = words || SAYS[k];
    b.msg.hidden = false;
  }
  function clearFlag(k) {
    boxes[k].input.removeAttribute('aria-invalid');
    boxes[k].msg.hidden = true;
  }
  // checked here to save a trip; the server checks it all again
  function problems(o) {
    var bad = [];
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(o.email)) bad.push('email');
    if (!o.name) bad.push('name');
    if (!o.line1) bad.push('line1');
    if (!o.city) bad.push('city');
    if (!o.state) bad.push('state');
    if (!/^\d{5}(-?\d{4})?$/.test(o.zip)) bad.push('zip');
    return bad;
  }
  function stateName(code) {
    for (var i = 0; i < catalog.states.length; i++) if (catalog.states[i].code === code) return catalog.states[i].name;
    return code;
  }

  function fillForm() {
    var v = readSaved();
    var sel = boxes.state.input;
    catalog.states.forEach(function (st) {
      var o = el('option', null, st.name);
      o.value = st.code;
      sel.appendChild(o);
    });
    Object.keys(boxes).forEach(function (k) { boxes[k].input.value = v[k] || ''; });
    // "did you mean ...@gmail.com?", once, under the email box
    var hint = $('#co-email-hint');
    boxes.email.input.addEventListener('change', function () {
      hint.textContent = '';
      var typed = boxes.email.input.value.trim();
      var fix = J.suggestEmail(typed);
      if (!fix || typed.indexOf('@') < 0) return;
      hint.textContent = 'did you mean ' + fix + '? ';
      var use = el('button', 'link-btn', 'yes, use that');
      use.type = 'button';
      use.addEventListener('click', function () { boxes.email.input.value = fix; hint.textContent = ''; remember(); boxes.email.input.focus(); });
      hint.appendChild(use);
    });
    // the gift: a tick, then a short note we write by hand on a card
    giftTick.checked = v.gift === true;
    giftNote.maxLength = catalog.giftMax;
    giftNote.value = (v.message || '').slice(0, catalog.giftMax);
    function paintLeft() {
      giftHint.textContent = 'we\'ll write it by hand on a card and tuck it in with your order. put their address above. ' +
        (catalog.giftMax - giftNote.value.length) + ' letters left.';
    }
    giftNoteWrap.hidden = !giftTick.checked;
    paintLeft();
    giftNote.addEventListener('input', function () { paintLeft(); remember(); });
    giftTick.addEventListener('change', function () {
      giftNoteWrap.hidden = !giftTick.checked;
      remember();
      if (giftTick.checked) giftNote.focus();
    });
  }

  /* ---------- shipping ---------- */
  function paintShipping() {
    var box = $('[data-co-ship-options]');
    box.textContent = '';
    var chosen = J.shipChoice();
    catalog.shipping.forEach(function (o) {
      var row = el('label', 'ship-opt');
      var radio = el('input');
      radio.type = 'radio';
      radio.name = 'co-ship';
      radio.value = o.id;
      radio.checked = o.id === chosen.id;
      radio.addEventListener('change', function () {
        if (!radio.checked) return;
        J.save('jka_ship', o.id);
        paintSummary();
        askQuote();
      });
      var words = el('span', 'ship-name', o.name);
      if (o.days) words.appendChild(el('span', 'ship-days', o.days));
      row.appendChild(radio);
      row.appendChild(words);
      var c = J.shipCents(o);
      row.appendChild(el('span', 'ship-price', c === 0 ? 'free' : cents(c)));
      box.appendChild(row);
    });
    // the standing policy, said plainly once. no countdown to it
    var free = $('[data-co-free]');
    var freeOne = catalog.shipping.filter(function (o) { return o.free_over_cents; })[0];
    free.textContent = '';
    if (!freeOne) return;
    var line = cents(freeOne.free_over_cents).replace(/\.00$/, '');
    var notPin = items().some(function (it) { return catalog.byKey[it.key].product.kind !== 'pin'; });
    free.textContent = J.shipCents(freeOne) === 0
      ? freeOne.name + ' shipping is on us, since your pins come to ' + line + ' or more.'
      : notPin ? freeOne.name + ' shipping is free on orders of just pins that come to ' + line + ' or more.'
        : freeOne.name + ' shipping is free when your pins come to ' + line + ' or more.';
  }

  /* ---------- the tip: none to start with, always the buyer's own choice ---------- */
  var tipChoice = 'none';
  var tipOwn = $('#co-tip-amount');
  var tipMsg = $('#co-tip-msg');
  function itemsCents() {
    return items().reduce(function (n, it) { return n + catalog.byKey[it.key].size.price_cents * it.qty; }, 0);
  }
  // what the server is asked for: { percent } or { cents }, or null for none. the server works out the percentages
  function tipAsk() {
    var t = TIPS.filter(function (x) { return x.id === tipChoice; })[0];
    if (!t || t.id === 'none') return null;
    if (t.percent) return { percent: t.percent };
    var c = ownTipCents();
    return c > 0 ? { cents: c } : null;
  }
  // the buyer's own amount in cents, or -1 when it doesn't read as an amount
  function ownTipCents() {
    var s = tipOwn.value.trim().replace(/^\$/, '');
    if (!s) return 0;
    if (!/^\d{1,3}(\.\d{0,2})?$/.test(s)) return -1;
    var c = Math.round(parseFloat(s) * 100);
    return c > TIP_MAX * 100 ? -1 : c;
  }
  // shown before the server answers: the server's own figure replaces it a moment later
  function tipGuess() {
    var a = tipAsk();
    if (!a) return 0;
    return a.percent ? Math.round(itemsCents() * a.percent / 100) : a.cents;
  }
  function paintTips() {
    var grid = $('[data-co-tip-options]');
    grid.textContent = '';
    var sum = itemsCents();
    TIPS.forEach(function (t) {
      var b = el('button', 'co-tip');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(t.id === tipChoice));
      if (t.percent) {
        b.appendChild(el('span', 'co-tip-pct', t.percent + '%'));
        b.appendChild(el('span', 'co-tip-amt', cents(Math.round(sum * t.percent / 100))));
      } else {
        b.appendChild(el('span', 'co-tip-pct', t.label));
      }
      b.addEventListener('click', function () {
        tipChoice = t.id;
        paintTips();
        $('[data-co-tip-own]').hidden = t.id !== 'own';
        if (t.id === 'own') tipOwn.focus();
        paintSummary();
        askQuote();
      });
      grid.appendChild(b);
    });
  }
  tipOwn.addEventListener('input', function () {
    tipOwn.removeAttribute('aria-invalid');
    tipMsg.hidden = true;
    paintSummary();
    askQuote();
  });

  /* ---------- the order summary ---------- */
  function paintLines() {
    var list = $('[data-co-lines]');
    list.textContent = '';
    items().forEach(function (it) {
      var en = catalog.byKey[it.key];
      var li = el('li', 'co-line');
      var pic = el('span', 'co-pic');
      var src = J.pinImage(en.product.slug);
      if (src) {
        var img = el('img');
        img.src = src;
        img.alt = '';
        img.width = 56;
        img.height = 56;
        img.loading = 'lazy';
        pic.appendChild(img);
      }
      var qty = el('span', 'co-qty', String(it.qty));
      qty.setAttribute('aria-hidden', 'true');
      pic.appendChild(qty);
      li.appendChild(pic);
      var words = el('span', 'co-line-name', J.lineName(it.key));
      words.appendChild(el('span', 'sr-only', ', ' + it.qty + ' of them'));
      if (en.size.preorder) words.appendChild(el('span', 'co-line-note', 'pre-order'));
      li.appendChild(words);
      li.appendChild(el('span', 'co-line-price', cents(en.size.price_cents * it.qty)));
      list.appendChild(li);
    });
  }
  // the server's quote when it matches what's on screen; otherwise our own sums, with tax still to come
  function paintSummary() {
    var sum = itemsCents();
    var ship = J.shipCents(J.shipChoice());
    var tip = tipGuess();
    var q = currentQuote();
    $('[data-co-items]').textContent = cents(q ? q.items_cents : sum);
    var shipCents = q ? q.shipping.cents : ship;
    $('[data-co-ship]').textContent = shipCents === 0 ? 'free' : cents(shipCents);
    $('[data-co-tax]').textContent = q ? cents(q.tax_cents) : 'working it out';
    var tipRow = $('[data-co-tip-row]');
    var tipNow = q ? q.tip_cents : tip;
    tipRow.hidden = !tipNow;
    $('[data-co-tip]').textContent = cents(tipNow);
    var total = q ? cents(q.total_cents) : cents(sum + ship + tip) + ' plus tax';
    $('[data-co-total]').textContent = total;
    $('[data-co-head-total]').textContent = q ? cents(q.total_cents) : '';
    var pre = $('[data-co-preorder]');
    pre.hidden = !J.hasPreorder();
    if (J.hasPreorder()) pre.textContent = J.preorderTogether();
    // the wallet showed one amount: if the order, shipping or tip changed since, it has to be asked again
    if (walletPay && walletPay.key !== quoteKey()) {
      clearWallet('your order changed, so tap ' + walletPay.name + ' again for the new total.');
    }
    paintPayLabel(q);
    if (walletRequest && q) {
      try { walletRequest.update({ total: { amount: (q.total_cents / 100).toFixed(2), label: 'j+k adventures' } }); } catch (e) {}
    }
  }
  function paintPayLabel(q) {
    if (busy) return;
    if (!cardMode) { payBtn.textContent = 'continue to payment'; payBtn.disabled = !items().length; return; }
    payBtn.textContent = (q ? 'pay ' + cents(q.total_cents) : 'pay') + (walletPay ? ' with ' + walletPay.name : '');
    payBtn.disabled = !q || !(card || walletPay);
  }

  // what the quote was asked for, so an old answer never paints over a newer choice
  function quoteKey() {
    return JSON.stringify([items(), J.shipChoice().id, cardMode ? tipAsk() : null]);
  }
  var quoteTimer = null;
  function askQuote() {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 250);
  }
  function fetchQuote() {
    var its = items();
    if (!its.length) return Promise.resolve(null);
    var key = quoteKey();
    var mine = ++quoteAsk;
    var tip = cardMode ? tipAsk() : null;
    return fetch('/api/checkout/quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: its, shipping: J.shipChoice().id, tip: tip })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 409 || r.status === 403) return shelfChanged(j, r.status === 403);
        if (!r.ok) throw new Error('quote');
        if (mine !== quoteAsk) return null;
        lastQuote = { ask: key, data: j };
        paintSummary();
        return j;
      });
    }).catch(function () {
      if (mine !== quoteAsk) return null;
      $('[data-co-tax]').textContent = 'added when you pay';
      return null;
    });
  }

  // someone else got there first, or the shop just closed: show the order as it really is now
  function shelfChanged(j, closed) {
    (j.items || []).forEach(function (it) { var en = catalog.byKey[it.key]; if (en) en.size.stock = Math.max(0, Number(it.stock) || 0); });
    return J.loadCatalog(true).then(function () {
      repaint();
      showError(closed ? 'the shop has just closed. your bag will keep these for you.'
        : 'the shelf changed while you were shopping. your order now shows what we have.');
      return null;
    });
  }

  /* ---------- showing and hiding ---------- */
  function showError(words) {
    errBox.textContent = words;
    errBox.hidden = !words;
  }
  function repaint() {
    var its = items();
    var empty = !catalog.open || !its.length;
    $('[data-co-loading]').hidden = true;
    $('[data-co-empty]').hidden = !empty;
    $('[data-co-page]').hidden = empty;
    if (empty) {
      $('[data-co-empty-words]').textContent = !catalog.open
        ? 'the shop opens soon. your bag will keep these for you.'
        : 'your bag is empty. a pin would look good in it.';
      return;
    }
    paintLines();
    paintShipping();
    if (cardMode) paintTips();
    paintSummary();
    askQuote();
  }

  /* ---------- Square's card form ---------- */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (window.Square) return resolve();
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('square script')); };
      document.head.appendChild(s);
    });
  }
  // the card form lives in Square's own frame, so it can't read our stylesheet: hand it our colours from the tokens
  function cardStyle() {
    var css = getComputedStyle(document.documentElement);
    var t = function (name) { return css.getPropertyValue(name).trim(); };
    return {
      input: { color: t('--ink'), backgroundColor: t('--surface'), fontSize: '16px' },
      'input::placeholder': { color: t('--ink-muted') },
      '.input-container': { borderColor: t('--line-strong'), borderRadius: t('--radius-sm') },
      '.input-container.is-focus': { borderColor: t('--focus-ring') },
      '.input-container.is-error': { borderColor: t('--accent-text') },
      '.message-text': { color: t('--ink-muted') },
      '.message-icon': { color: t('--ink-muted') },
      '.message-text.is-error': { color: t('--accent-text') },
      '.message-icon.is-error': { color: t('--accent-text') }
    };
  }
  function startCard() {
    var cfg = catalog.card;
    $('[data-co-card-area]').hidden = false;
    $('[data-co-tip-section]').hidden = false;
    return loadScript(cfg.sdk).then(function () {
      payments = window.Square.payments(cfg.app_id, cfg.location_id);
      // our own colours first; if Square ever refuses one, its plain form is better than none
      return payments.card({ style: cardStyle() }).catch(function () { return payments.card(); });
    }).then(function (c) {
      return c.attach('#co-card').then(function () { card = c; });
    }).then(function () {
      $('[data-co-card-wait]').hidden = true;
      paintSummary();
      startWallets();
    }).catch(function (e) {
      console.log('card form', e && e.message);
      $('[data-co-card-wait]').textContent = 'square\'s card form didn\'t load. try reloading the page, or write to us at ' + J.contactEmail + '.';
    });
  }

  // Apple Pay (only on Apple devices, once the owner has verified our address with Apple through Square) and
  // Google Pay. Both use the address typed on this page, so it's checked first
  function startWallets() {
    try {
      walletRequest = payments.paymentRequest({
        countryCode: 'US', currencyCode: catalog.currency,
        total: { amount: lastQuote ? (lastQuote.data.total_cents / 100).toFixed(2) : '1.00', label: 'j+k adventures', pending: !lastQuote }
      });
    } catch (e) { return; }
    function showWallets() {
      $('[data-co-wallets]').hidden = false;
      $('[data-co-or]').hidden = false;
    }
    payments.applePay(walletRequest).then(function (ap) {
      var b = $('[data-co-apple-pay]');
      b.hidden = false;
      showWallets();
      b.addEventListener('click', function () { authorizeWallet('apple pay', function () { return ap.tokenize(); }); });
    }).catch(function () { /* not an apple device, or not set up: no button */ });
    payments.googlePay(walletRequest).then(function (gp) {
      var box = $('[data-co-google-pay]');
      box.hidden = false;
      return gp.attach(box, { buttonColor: 'black', buttonSizeMode: 'fill', buttonType: 'long' }).then(function () {
        showWallets();
        box.addEventListener('click', function () { authorizeWallet('google pay', function () { return gp.tokenize(); }); });
      });
    }).catch(function () { $('[data-co-google-pay]').hidden = true; });
  }

  // Google Pay and Apple Pay only fill the payment in: their sheet hands back Square's one-time token, kept here
  // until the buyer presses pay. tokenize() is called straight from the click, as Apple Pay needs
  function authorizeWallet(name, tokenize) {
    if (busy) return;
    var o = checkForm();
    if (!o) return;
    var q = currentQuote();
    // the amount the wallet shows has to be the real total
    if (!q) { showError('one moment, we\'re still working out the total. try again in a second.'); askQuote(); return; }
    var key = quoteKey();
    var wait;
    try { wait = Promise.resolve(tokenize()); } catch (e) { wait = Promise.reject(e); }
    wait.then(function (result) {
      if (result && result.status === 'OK') {
        walletPay = { name: name, token: result.token, key: key, total: q.total_cents, card: result.details && result.details.card };
        paintWallet();
        payBtn.focus();
        return;
      }
      // a closed sheet needs nothing said
      if (!result || (result.status !== 'Cancel' && result.status !== 'Abort')) showError(name + ' didn\'t finish. you could try again, or pay by card.');
    }).catch(function () {
      showError(name + ' didn\'t finish. you could try again, or pay by card.');
    });
  }
  function clearWallet(words) {
    walletPay = null;
    paintWallet();
    if (words) showError(words);
  }
  function paintWallet() {
    var ready = $('[data-co-wallet-ready]');
    ready.hidden = !walletPay;
    $('[data-co-card]').hidden = !!walletPay;
    if (!$('[data-co-wallets]').hidden) $('[data-co-or]').hidden = !!walletPay;
    if (walletPay) {
      var c = walletPay.card;
      var which = c && c.last4 ? ' (' + String(c.brand || 'card').toLowerCase().replace(/_/g, ' ') + ' ending ' + c.last4 + ')' : '';
      $('[data-co-wallet-words]').textContent = walletPay.name + which + ' is ready. press pay below to finish.';
    }
    paintPayLabel(currentQuote());
  }
  $('[data-co-wallet-clear]').addEventListener('click', function () { clearWallet(null); });

  /* ---------- paying ---------- */
  function checkForm() {
    showError('');
    Object.keys(boxes).forEach(clearFlag);
    var o = values();
    remember();
    var bad = problems(o);
    if (bad.length) {
      bad.forEach(function (k) { flag(k); });
      boxes[bad[0]].input.focus();
      return null;
    }
    if (cardMode && tipChoice === 'own' && ownTipCents() < 0) {
      tipOwn.setAttribute('aria-invalid', 'true');
      tipMsg.textContent = 'a tip in dollars, like 3 or 3.50, up to $' + TIP_MAX + '.';
      tipMsg.hidden = false;
      tipOwn.focus();
      return null;
    }
    return o;
  }
  function order(o) {
    return {
      items: items(), shipping: J.shipChoice().id,
      ship_to: { name: o.name, email: o.email, line1: o.line1, line2: o.line2, city: o.city, state: o.state, zip: o.zip },
      gift: o.gift ? { gift: true, message: o.message.trim() } : null
    };
  }
  function setBusy(on, words) {
    busy = on;
    payBtn.disabled = on;
    if (on) payBtn.textContent = words || 'one moment.';
    else paintSummary();
  }
  function post(path, body) {
    return J.signInTicket().then(function (token) {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(path, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { r: r, j: j }; });
    });
  }
  // an answer the server gave that isn't "paid": say what to do next. true when it was handled
  function handleRefusal(res, o) {
    var r = res.r, j = res.j;
    if (r.status === 409 && j.error === 'total') {
      // a price changed in Square while they were checking out: nothing was charged. show the new total to confirm
      lastQuote = null;
      fetchQuote();
      showError('the total changed to ' + cents(j.total_cents) + ' while you were checking out. nothing was charged. take a look, then press pay to confirm.');
      return true;
    }
    if (r.status === 409 || r.status === 403) { shelfChanged(j, r.status === 403); return true; }
    if (r.status === 400 && j.error === 'address' && boxes[j.field]) {
      flag(j.field, j.reason === 'zip not in state' ? 'that zip code isn\'t in ' + stateName(o.state) + '. could you check both?' : null);
      boxes[j.field].input.focus();
      return true;
    }
    if (r.status === 402) {
      attempt = newAttempt();
      showError(CARD_SAYS[j.reason] || CARD_SAYS.declined);
      return true;
    }
    return false;
  }

  // the server's total for exactly what's on screen, or null while it's still being worked out
  function currentQuote() { return lastQuote && lastQuote.ask === quoteKey() ? lastQuote.data : null; }

  // card or wallet: tokenize() asks Square for the one-time token. called straight from the click, as Apple Pay needs
  function payWith(tokenize) {
    if (busy) return;
    var o = checkForm();
    if (!o) return;
    // the amount the bank and the wallet show has to be the real total
    if (!currentQuote()) { showError('one moment, we\'re still working out the total. try again in a second.'); askQuote(); return; }
    var body = order(o);
    body.tip = tipAsk();
    body.attempt = attempt;
    // the total they saw: the server charges nothing if Square's total has changed since
    body.expected_total_cents = currentQuote().total_cents;
    rememberAttempt();
    setBusy(true, 'one moment.');
    var tokenWait;
    try { tokenWait = Promise.resolve(tokenize(o)); } catch (e) { tokenWait = Promise.reject(e); }
    tokenWait.then(function (result) {
      if (!result || result.status !== 'OK') {
        // the card form shows its own message under the box that needs it; a closed wallet sheet needs nothing
        if (result && (result.status === 'Cancel' || result.status === 'Abort')) return 'quiet';
        throw new Error('token');
      }
      body.source_id = result.token;
      setBusy(true, 'paying.');
      return post('/api/checkout/pay', body);
    }).then(function (res) {
      if (res === 'quiet') { setBusy(false); return; }
      if (res.r.ok && res.j.ok && res.j.url) {
        payBtn.textContent = 'paid. thank you!';
        location.href = res.j.url;
        return;
      }
      setBusy(false);
      // a wallet's token is used up once the server has tried it: a second try needs the wallet again
      if (walletPay) { walletPay = null; paintWallet(); }
      if (handleRefusal(res, o)) return;
      showError('we couldn\'t take the payment just now, and nothing was charged. try again, or write to us at ' + J.contactEmail + '.');
    }).catch(function (e) {
      setBusy(false);
      if (e && e.message === 'token') { showError('could you check the card details? the box that needs another look says why.'); return; }
      // a dropped connection: the same attempt is kept, so pressing pay again can't charge twice
      showError('we couldn\'t reach square just now. try again in a moment, or write to us at ' + J.contactEmail + '.');
    });
  }

  function payByCard() {
    payWith(function (o) {
      var total = currentQuote().total_cents;
      var parts = o.name.split(/\s+/);
      // buyer verification (the bank's "is it you?" check), when the bank asks for it, happens inside tokenize
      return card.tokenize({
        amount: (total / 100).toFixed(2),
        currencyCode: catalog.currency,
        intent: 'CHARGE',
        customerInitiated: true,
        sellerKeyedIn: false,
        billingContact: {
          givenName: parts[0], familyName: parts.slice(1).join(' '), email: o.email,
          addressLines: [o.line1, o.line2].filter(Boolean), city: o.city, state: o.state, postalCode: o.zip, countryCode: 'US'
        }
      });
    });
  }

  // no card form set up: the order goes to Square's own payment page, address already on it
  function payOnSquare() {
    if (busy) return;
    var o = checkForm();
    if (!o) return;
    setBusy(true, 'one moment.');
    post('/api/checkout', order(o)).then(function (res) {
      if (res.r.ok && res.j.url) {
        payBtn.textContent = 'taking you to square.';
        location.href = res.j.url;
        return;
      }
      setBusy(false);
      if (handleRefusal(res, o)) return;
      showError('we couldn\'t start checkout. try again, or write to us at ' + J.contactEmail + '.');
    }).catch(function () {
      setBusy(false);
      showError('we couldn\'t start checkout. try again, or write to us at ' + J.contactEmail + '.');
    });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!cardMode) { payOnSquare(); return; }
    if (walletPay) {
      var w = walletPay;
      var q = currentQuote();
      if (w.key !== quoteKey() || !q || q.total_cents !== w.total) { clearWallet('your order changed, so tap ' + w.name + ' again for the new total.'); return; }
      payWith(function () { return { status: 'OK', token: w.token }; });
      return;
    }
    if (card) payByCard();
  });
  $('[data-co-edit-bag]').addEventListener('click', function () { J.openBag(); });
  document.addEventListener('jka:cart', repaint);
  // back from Square's page with the back button: the page may come back just as it was left
  window.addEventListener('pageshow', function (e) { if (e.persisted) { busy = false; J.loadCatalog(true).then(repaint); } });
  // the summary folds up on a phone, open beside the form on a wide screen
  var wide = window.matchMedia ? window.matchMedia('(min-width: 900px)') : null;
  function fold() { $('[data-co-summary]').open = !wide || wide.matches; }
  if (wide && wide.addEventListener) wide.addEventListener('change', fold);

  // a tab closed while paying, opened again: if that payment went through, go to the thank-you page instead
  checkLastPress().then(function (paid) { return paid ? null : J.loadCatalog(true); }).then(function (got) {
    if (!got) return;
    cardMode = !!(catalog.card && catalog.card.app_id && catalog.card.sdk);
    $('[data-co-hosted]').hidden = cardMode;
    fillForm();
    fold();
    repaint();
    if (cardMode && catalog.open && items().length) startCard();
  }).catch(function () {
    $('[data-co-loading]').textContent = 'we couldn\'t open your bag just now. try again in a moment, or write to us at ' + J.contactEmail + '.';
  });
})();
