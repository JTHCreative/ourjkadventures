/* j+k adventures: accounts. Firebase Authentication holds passwords and hands out sign-in tickets (ID tokens).
   This file runs the sign-in, create, reset, account, details, orders, register-your-pin and my-collection pages, and lends a ticket to checkout (see app.js).
   Customer details come from our own server at /api/account, never straight from Firestore. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signInWithPopup, GoogleAuthProvider, signOut, updateProfile, EmailAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup, verifyBeforeUpdateEmail
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';

// the web config is not secret: it only says which Firebase project this site uses
const app = initializeApp({
  apiKey: 'AIzaSyB0boe_hhQC9JdM0bieYJTj1yGEiqAe_Fk',
  authDomain: 'jk-adventures-website.firebaseapp.com',
  projectId: 'jk-adventures-website',
  storageBucket: 'jk-adventures-website.firebasestorage.app',
  messagingSenderId: '5132579299',
  appId: '1:5132579299:web:2b814e3274d611d37ff0d6'
});
const auth = getAuth(app);
const CONTACT_EMAIL = 'support@ourjkadventures.com';
const HINT = 'jka_user'; // the header reads this so other pages need not load Firebase

/* ---------- small helpers ---------- */
function setHint(name) { try { if (name === null) localStorage.removeItem(HINT); else localStorage.setItem(HINT, name); } catch (e) {} }
function getHint() { try { return localStorage.getItem(HINT); } catch (e) { return null; } }
function $(sel) { return document.querySelector(sel); }
function paintHeader(name) {
  document.querySelectorAll('[data-account-link]').forEach(function (a) { a.textContent = name === null ? 'sign in' : (name.toLowerCase() || 'your account'); });
}

let firstState = null;
const ready = new Promise(function (resolve) { firstState = resolve; });
onAuthStateChanged(auth, function (user) {
  if (!user) setHint(null);
  else if (getHint() === null) setHint(user.displayName ? user.displayName.split(' ')[0] : '');
  paintHeader(getHint());
  firstState(user);
});

// checkout asks for this. null when signed out.
export async function currentToken() {
  const user = await ready;
  return user ? user.getIdToken() : null;
}

// for the owner's page (admin.js): who is signed in, a google sign-in, and signing out
export function signedInUser() { return ready; }
export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, new GoogleAuthProvider());
  await hello(cred.user).catch(function () {});
  return cred.user;
}
export async function signOutHere() {
  await signOut(auth);
  setHint(null);
}
export { friendly as friendlyError };

/* ---------- the account emails ---------- */
// Our own server sends "confirm your email", "choose a new password" and "confirm your new email" in the shop's
// letterhead (server/account-emails.js). If it can't (email not set up, or a hiccup), Firebase sends its own
// plainer one instead, so a link always goes out. Returns true when ours went, false when Firebase should send.
// Answers that mean "no" (too many tries, that email is taken) come back as errors friendly() understands.
async function ourEmail(kind, body, user) {
  let res;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = 'Bearer ' + (await user.getIdToken(kind === 'change'));
    res = await fetch('/api/account/email/' + kind, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
  } catch (e) { return false; }
  if (res.ok) return true;
  const data = await res.json().catch(function () { return {}; });
  const code = { limit: 'auth/too-many-requests', taken: 'auth/email-already-in-use', email: 'auth/invalid-email', 'sign in again': 'auth/requires-recent-login' }[data.error];
  if (code) { const e = new Error(data.error); e.code = code; throw e; }
  return false;
}

function friendly(err) {
  const code = (err && err.code) || '';
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'that email and password do not match. try again, or reset your password.';
    case 'auth/email-already-in-use':
      return 'there is already an account with that email. try signing in instead.';
    case 'auth/invalid-email':
      return 'that email does not look quite right.';
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return 'please choose a longer password, at least 8 characters.';
    case 'auth/too-many-requests':
      return 'too many tries for now. wait a few minutes and try again.';
    case 'auth/popup-blocked':
      return 'your browser blocked the google window. allow pop-ups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'that email already has an account with a password. sign in with it below.';
    case 'auth/requires-recent-login':
      return 'for safety, please sign out and back in, then try again.';
    case 'auth/network-request-failed':
      return 'we could not reach the sign-in service. check your connection and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return '';
    default:
      console.log('sign-in error', code);
      return 'something went wrong. try again, or write to us at ' + CONTACT_EMAIL + '.';
  }
}

function formKit(form) {
  const msg = form.querySelector('.form-msg');
  const btn = form.querySelector('button[type="submit"]');
  const label = btn ? btn.textContent : '';
  return {
    say(text, ok) {
      if (!msg) return;
      msg.textContent = text;
      msg.hidden = !text;
      msg.classList.toggle('ok', !!ok);
    },
    busy(on) {
      if (!btn) return;
      btn.disabled = on;
      btn.textContent = on ? 'one moment.' : label;
    }
  };
}

// talk to our server with this person's ticket
async function api(user, method, path, body) {
  const token = await user.getIdToken();
  const headers = { Authorization: 'Bearer ' + token };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { const e = new Error('account ' + res.status); e.status = res.status; throw e; }
  return res.json();
}

// where to go after signing in: a page of ours named in ?next=, like pup-club.html, or the account page
function afterSignIn() {
  const next = new URLSearchParams(location.search).get('next');
  return next && /^[a-z0-9-]+\.html$/.test(next) ? next : 'account.html';
}

function remember(me) {
  setHint(me.firstName || '');
  paintHeader(me.firstName || '');
  return me;
}

// say hello to our server: it creates the customer's folder the first time and returns it
async function hello(user, firstName) {
  return remember(await api(user, 'POST', '/api/account', firstName ? { firstName: firstName } : {}));
}

async function googleSignIn(kit) {
  kit.say('');
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await hello(cred.user).catch(function () {});
    location.href = afterSignIn();
  } catch (err) {
    kit.say(friendly(err));
  }
}

function wireGoogle(kit) {
  const g = $('[data-google]');
  if (g) g.addEventListener('click', function () { googleSignIn(kit); });
}

/* ---------- pages ---------- */
async function signInPage() {
  const form = $('#sign-in-form');
  const kit = formKit(form);
  wireGoogle(kit);
  if (await ready) { location.replace('account.html'); return; }
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    kit.say('');
    kit.busy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, form.email.value.trim(), form.password.value);
      await hello(cred.user).catch(function () {});
      location.href = afterSignIn();
    } catch (err) {
      kit.busy(false);
      kit.say(friendly(err));
    }
  });
}

async function createPage() {
  const form = $('#create-form');
  const kit = formKit(form);
  wireGoogle(kit);
  if (await ready) { location.replace('account.html'); return; }
  // came from a guest review with "create an account" ticked: their name and email are filled in already
  let fromReview = null;
  try { fromReview = JSON.parse(sessionStorage.getItem('jka_signup') || 'null'); sessionStorage.removeItem('jka_signup'); } catch (e) {}
  if (fromReview && fromReview.from === 'review') {
    if (typeof fromReview.firstName === 'string') form.firstName.value = fromReview.firstName.slice(0, 40);
    if (typeof fromReview.email === 'string') form.email.value = fromReview.email.slice(0, 254);
    const note = $('[data-create-note]');
    if (note) note.hidden = false;
    form.password.focus();
  }
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    kit.say('');
    const name = form.firstName.value.trim();
    if (form.password.value.length < 8) {
      form.password.setAttribute('aria-invalid', 'true');
      form.password.focus();
      kit.say('please choose a longer password, at least 8 characters.');
      return;
    }
    form.password.removeAttribute('aria-invalid');
    kit.busy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, form.email.value.trim(), form.password.value);
      if (name) await updateProfile(cred.user, { displayName: name }).catch(function () {});
      // the folder first, so the confirm email can say hi with their name
      await hello(cred.user, name).catch(function () {});
      await sendVerify(cred.user).catch(function () {});
      location.href = 'account.html';
    } catch (err) {
      kit.busy(false);
      kit.say(friendly(err));
    }
  });
}

function resetPage() {
  const form = $('#reset-form');
  const kit = formKit(form);
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    kit.say('');
    kit.busy(true);
    try {
      const email = form.email.value.trim();
      if (!(await ourEmail('reset', { email: email }))) await sendPasswordResetEmail(auth, email);
    } catch (err) {
      // the same answer whether or not the account exists, so nobody can check who has one
      if (err && (err.code === 'auth/invalid-email' || err.code === 'auth/network-request-failed' || err.code === 'auth/too-many-requests')) {
        kit.busy(false);
        kit.say(friendly(err));
        return;
      }
    }
    kit.busy(false);
    kit.say('if there is an account for that email, a link to choose a new password is on its way. check your inbox.', true);
  });
}

// every signed-in page starts the same way: no ticket, go to sign in
async function signedIn() {
  const user = await ready;
  if (!user) { location.replace('sign-in.html'); return null; }
  return user;
}
function usesPassword(user) { return user.providerData.some(function (p) { return p.providerId === 'password'; }); }
function couldNotOpen(notice) {
  notice.textContent = 'we could not open your account just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
  notice.hidden = false;
}
async function sendVerify(user) {
  if (await ourEmail('verify', {}, user)) return;
  return sendEmailVerification(user, { url: location.origin + '/account.html' }).catch(function () { return sendEmailVerification(user); });
}

/* ---------- code cards: registering a pin (server/codes.js) ---------- */
// A code is 8 characters, like AUS7K2M9: three letters for the pin, then five from CODE_LETTERS (the same list the
// server draws from: no vowels, and no 0, 1 or L). The code someone is part way through registering is kept in this
// browser (CODE_KEY) so it's still here after they confirm their email or make an account.
const CODE_LETTERS = '23456789BCDFGHJKMNPQRSTVWXYZ';
const CODE_KEY = 'jka_code';
function tidyCode(s) {
  const code = String(s || '').toUpperCase().replace(/[\s\-_.]/g, '');
  if (code.length !== 8 || !/^[A-Z]{3}/.test(code)) return null;
  for (let i = 3; i < 8; i++) if (CODE_LETTERS.indexOf(code[i]) < 0) return null;
  return code;
}
function savedCode() { try { return tidyCode(localStorage.getItem(CODE_KEY)); } catch (e) { return null; } }
function saveCode(code) { try { if (code) localStorage.setItem(CODE_KEY, code); else localStorage.removeItem(CODE_KEY); } catch (e) {} }
function aPin(name) { return (/^[aeiou]/.test(name) ? 'an ' : 'a ') + name + ' pin'; }

// the line under the box: once three letters are in, it says which pin they belong to ("an aussie pin!")
function codeBox(form) {
  const input = form.code;
  const hint = form.querySelector('[data-code-pin]');
  const resting = hint ? hint.textContent : '';
  let names = null;
  function paint() {
    if (!hint) return;
    const start = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
    if (!names || start.length < 3) { hint.textContent = resting; return; }
    hint.textContent = names[start] ? aPin(names[start]) + '!' : 'we don\'t have a pin that starts with ' + start.toLowerCase() + '. have another look at the first three letters.';
  }
  input.addEventListener('input', paint);
  fetch('/products.json').then(function (r) { return r.json(); }).then(function (data) {
    names = {};
    (data.items || []).forEach(function (p) { if (p.code) names[p.code] = p.slug === 'golden' ? 'goldie' : p.name; });
    paint();
  }).catch(function () {});
  return { set: function (v) { input.value = v || ''; paint(); } };
}

// { http, status?, error?, pin?, charges? }. never throws
async function sendCode(user, code) {
  try {
    const res = await fetch('/api/codes/register', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (await user.getIdToken()), 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code })
    });
    const data = await res.json().catch(function () { return {}; });
    data.http = res.status;
    return data;
  } catch (e) { return { http: 0 }; }
}
const CODE_WORDS = {
  shape: 'a code is 8 characters, like aus7k2m9. have another look at the card.',
  unknown: 'we couldn\'t find that code. have another look at the card and try again.',
  taken: 'that card has already been registered to another account. if that doesn\'t sound right, write to us at ' + CONTACT_EMAIL + '.',
  limit: 'that\'s a lot of tries. give it an hour, then try again.',
  resting: 'we could not register it just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.'
};
function countWords(n) { return n === 1 ? 'that\'s 1 pin on your collector\'s path.' : 'that\'s ' + n + ' pins on your collector\'s path.'; }

// One try at registering what's in the box. Returns the server's answer once the pin is theirs ("registered" or
// "yours"), or null after saying why not. needsConfirm is called when their email isn't confirmed yet.
async function tryCode(user, form, kit, needsConfirm) {
  kit.say('');
  const code = tidyCode(form.code.value);
  if (!code) { kit.say(CODE_WORDS.shape); form.code.focus(); return null; }
  saveCode(code);
  kit.busy(true);
  // back from the confirm link, this browser may still hold the old "not confirmed" answer
  if (!user.emailVerified) {
    try { await user.reload(); if (user.emailVerified) await user.getIdToken(true); } catch (e) {}
  }
  if (!user.emailVerified) { kit.busy(false); needsConfirm(); return null; }
  const out = await sendCode(user, code);
  kit.busy(false);
  if (out.status === 'registered' || out.status === 'yours') { saveCode(null); return out; }
  if (out.error === 'confirm') { needsConfirm(); return null; }
  if (out.status === 'taken') saveCode(null);
  kit.say(out.error === 'code' ? CODE_WORDS.shape : CODE_WORDS[out.status] || CODE_WORDS.resting);
  return null;
}

async function registerPage() {
  const form = $('#code-form');
  const kit = formKit(form);
  const box = codeBox(form);
  const card = $('[data-code-card]');
  const join = $('[data-code-join]');
  const done = $('[data-code-done]');
  const confirmBox = $('[data-code-confirm]');

  // the card's QR code brings the code along in the address (?code=AUS7K2M9). it goes in the box, and comes out
  // of the address straight away so it isn't kept in the browser's history
  const fromCard = new URLSearchParams(location.search).get('code');
  if (fromCard !== null) {
    box.set(fromCard.slice(0, 12));
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  } else {
    box.set(savedCode() || '');
  }

  let user = await ready;
  join.hidden = !!user;

  function needsConfirm() {
    $('[data-confirm-email]').textContent = user.email || 'your email';
    confirmBox.hidden = false;
  }
  $('[data-verify-again]').addEventListener('click', async function () {
    const again = this;
    again.disabled = true;
    try { await sendVerify(user); again.textContent = 'sent. check your inbox.'; } catch (err) {
      again.textContent = friendly(err) || 'we could not send it just now. try again in a few minutes.';
      again.disabled = false;
    }
  });

  async function go() {
    if (!user) {
      const code = tidyCode(form.code.value);
      if (!code) { kit.say(CODE_WORDS.shape); form.code.focus(); return; }
      saveCode(code);
      kit.say('got it. sign in or make an account below, and we\'ll add your pin right after.', true);
      join.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    const out = await tryCode(user, form, kit, needsConfirm);
    if (!out) return;
    confirmBox.hidden = true;
    const img = $('[data-done-img]');
    img.onerror = function () { img.hidden = true; };
    img.src = 'assets/img/pins/' + out.pin.slug + '.webp';
    img.hidden = false;
    $('[data-done-line]').textContent = out.status === 'yours'
      ? 'this ' + out.pin.name + ' pin is already in your collection.'
      : 'your ' + out.pin.name + ' pin is in your collection. thank you!';
    const count = $('[data-done-count]');
    // a card that came with a pin on us joins the collection without adding a step
    count.textContent = out.status !== 'registered' ? '' : out.full ? 'you\'ve already walked all ten steps of the path, so this one is just for your board.'
      : out.counted === false ? 'this one came as a pin on us, so it joins your collection without adding a step.'
        : REACHED_WORDS[out.reached] || countWords(out.charges);
    count.hidden = !count.textContent;
    card.hidden = true;
    done.hidden = false;
    done.focus();
  }
  form.addEventListener('submit', function (e) { e.preventDefault(); go(); });
  $('[data-code-another]').addEventListener('click', function () {
    box.set('');
    kit.say('');
    done.hidden = true;
    card.hidden = false;
    form.code.focus();
  });

  // signed out: make an account or sign in right here, then the pin is added
  function arrived(u) {
    user = u;
    join.hidden = true;
    kit.say('');
    if (tidyCode(form.code.value)) go(); else form.code.focus();
  }
  const joinMsg = $('[data-join-msg]');
  $('[data-google]').addEventListener('click', async function () {
    joinMsg.hidden = true;
    try {
      const cred = await signInWithPopup(auth, new GoogleAuthProvider());
      await hello(cred.user).catch(function () {});
      arrived(cred.user);
    } catch (err) {
      joinMsg.textContent = friendly(err);
      joinMsg.hidden = !joinMsg.textContent;
    }
  });
  const create = $('#create-form');
  const ckit = formKit(create);
  create.addEventListener('submit', async function (e) {
    e.preventDefault();
    ckit.say('');
    if (create.password.value.length < 8) {
      create.password.setAttribute('aria-invalid', 'true');
      create.password.focus();
      ckit.say('please choose a longer password, at least 8 characters.');
      return;
    }
    create.password.removeAttribute('aria-invalid');
    ckit.busy(true);
    try {
      const name = create.firstName.value.trim();
      const cred = await createUserWithEmailAndPassword(auth, create.email.value.trim(), create.password.value);
      if (name) await updateProfile(cred.user, { displayName: name }).catch(function () {});
      // the folder first, so the confirm email can say hi with their name
      await hello(cred.user, name).catch(function () {});
      await sendVerify(cred.user).catch(function () {});
      ckit.busy(false);
      arrived(cred.user);
    } catch (err) {
      ckit.busy(false);
      ckit.say(friendly(err));
    }
  });
  const signIn = $('#sign-in-form');
  const skit = formKit(signIn);
  signIn.addEventListener('submit', async function (e) {
    e.preventDefault();
    skit.say('');
    skit.busy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, signIn.email.value.trim(), signIn.password.value);
      await hello(cred.user).catch(function () {});
      skit.busy(false);
      arrived(cred.user);
    } catch (err) {
      skit.busy(false);
      skit.say(friendly(err));
    }
  });
  const swap = $('[data-join-swap]');
  swap.addEventListener('click', function () {
    const toSignIn = signIn.hidden;
    signIn.hidden = !toSignIn;
    create.hidden = toSignIn;
    $('[data-join-forgot]').hidden = !toSignIn;
    swap.textContent = toSignIn ? 'new here? create an account.' : 'already have an account? sign in.';
    (toSignIn ? signIn.email : create.firstName).focus();
  });
}

// "my collection": the collector's path, the pin board (assets/collection.js) and a box to register another pin
const PATH_END = 10;
const PATH_MARKS = [3, 6, 10];
function paintPath(charges, rewards) {
  const n = Math.max(0, Math.min(PATH_END, charges || 0));
  $('[data-path-line]').textContent = !n ? 'register your first pin and you\'re on your way.'
    : n >= PATH_END ? 'all ' + PATH_END + ' pins. you made it the whole way!'
      : n === 1 ? '1 pin so far, on the way to ' + PATH_END + '.' : n + ' pins so far, on the way to ' + PATH_END + '.';
  const track = $('[data-path-track]');
  track.textContent = '';
  for (let i = 1; i <= PATH_END; i++) {
    const li = document.createElement('li');
    if (i <= n) li.className = 'is-done';
    if (PATH_MARKS.indexOf(i) >= 0) li.classList.add('is-mark');
    track.appendChild(li);
  }
  // what's theirs right now, and what has already been sent
  const r = rewards || {};
  const notes = {
    3: r.early ? 'yours.' : '',
    6: r.gift === 'coming' ? 'yours. it\'ll be in your next order from our shop.' : r.gift === 'sent' ? 'sent with one of your orders.' : '',
    10: r.pin === 'ready' ? 'it\'s ready! pick your pin at checkout, the next time you order.' : r.pin === 'used' ? 'sent with one of your orders. thank you for collecting with us!' : ''
  };
  document.querySelectorAll('[data-path-step]').forEach(function (li) {
    const step = li.getAttribute('data-path-step');
    li.classList.toggle('is-reached', !!notes[step] || n >= Number(step));
    const note = li.querySelector('[data-path-note]');
    if (note) { note.textContent = notes[step]; note.hidden = !notes[step]; }
  });
}
const REACHED_WORDS = {
  early: 'that\'s three: you\'ll get a first look at new pins from now on.',
  gift: 'that\'s six: a little something extra will be in your next order from our shop.',
  pin: 'that\'s ten: your next order comes with a pin on us. pick it at checkout.'
};
async function collectionPage() {
  const user = await signedIn();
  if (!user) return;
  const notice = $('#account-notice');
  async function read() {
    const res = await fetch('/api/collection', { headers: { Authorization: 'Bearer ' + (await user.getIdToken()) } });
    if (!res.ok) throw new Error('collection ' + res.status);
    return res.json();
  }
  let mine, kit;
  try {
    await hello(user).catch(function () {});
    mine = await read();
    kit = await import('./collection.js');
  } catch (e) {
    notice.textContent = 'we could not open your collection just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
    notice.hidden = false;
    return;
  }
  paintPath(mine.charges, mine.rewards);
  $('#collection-view').hidden = false;
  const board = kit.mountBoard({
    board: $('[data-board]'), tools: $('[data-board-tools]'), toolsName: $('[data-board-name]'), trayWrap: $('[data-tray-wrap]'),
    tray: $('[data-tray]'), empty: $('[data-board-empty]'), status: $('[data-board-status]'), pins: mine.pins,
    save: async function (list) {
      const res = await fetch('/api/collection/board', {
        method: 'POST', keepalive: true,
        headers: { Authorization: 'Bearer ' + (await user.getIdToken()), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pins: list })
      });
      return res.ok;
    }
  });

  // registering another pin here drops it straight into the tray
  const form = $('#code-form');
  const fkit = formKit(form);
  const box = codeBox(form);
  box.set(savedCode() || '');
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    const out = await tryCode(user, form, fkit, function () {
      fkit.say('confirm your email first: use the link we sent you (you can send it again from your account page), then press the button once more.');
    });
    if (!out) return;
    box.set('');
    if (out.status === 'yours') { fkit.say('this ' + out.pin.name + ' pin is already in your collection.', true); return; }
    fkit.say('your ' + out.pin.name + ' pin is in your collection. thank you! you\'ll find it under the board, ready to put up.' + (REACHED_WORDS[out.reached] ? ' ' + REACHED_WORDS[out.reached] : ''), true);
    try {
      const now = await read();
      paintPath(now.charges, now.rewards);
      board.setPins(now.pins);
    } catch (err) {}
  });
}

async function accountPage() {
  const user = await signedIn();
  if (!user) return;
  // fresh from the confirm link, the browser may still hold the old "not confirmed" answer: ask again, and get a
  // new ticket that says so (the server moves reviews left as a guest with this email once it's confirmed)
  try {
    await user.reload();
    if (user.emailVerified) await user.getIdToken(true);
  } catch (e) {}
  const view = $('#account-view');
  const notice = $('#account-notice');

  $('[data-email]').textContent = user.email || '';
  $('[data-sign-out]').addEventListener('click', async function () {
    await signOut(auth);
    setHint(null);
    location.href = 'index.html';
  });

  // a check mark once the email is confirmed; until then, a quiet way to send the link again
  if (user.emailVerified) {
    $('[data-verified]').hidden = false;
  } else {
    const box = $('[data-unverified]');
    const again = $('[data-verify-again]');
    box.hidden = false;
    again.addEventListener('click', async function () {
      again.disabled = true;
      try {
        await sendVerify(user);
        again.textContent = 'sent. check your inbox.';
      } catch (err) {
        again.textContent = friendly(err) || 'we could not send it just now. try again in a few minutes.';
        again.disabled = false;
      }
    });
  }

  try {
    const me = await hello(user);
    $('[data-greeting]').textContent = me.firstName ? 'hello, ' + me.firstName.toLowerCase() + '.' : 'hello.';
    // only the owner sees the way in. the admin page checks again on the server, every time
    const adminLink = $('[data-admin-link]');
    if (adminLink && me.admin === true) adminLink.hidden = false;
    const n = me.pins || 0;
    $('[data-pin-count]').textContent = !n ? 'no pins registered yet.' : n === 1 ? '1 pin registered.' : n + ' pins registered.';
  } catch (e) {
    couldNotOpen(notice);
  }
  view.hidden = false;
}

async function detailsPage() {
  const user = await signedIn();
  if (!user) return;
  const view = $('#details-view');
  const notice = $('#account-notice');
  const passwordUser = usesPassword(user);

  // name and phone
  const form = $('#details-form');
  const kit = formKit(form);
  try {
    const me = await hello(user);
    form.firstName.value = me.firstName;
    form.lastName.value = me.lastName;
    form.phone.value = me.phone;
  } catch (e) {
    couldNotOpen(notice);
    return;
  }
  view.hidden = false;
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    kit.say('');
    form.phone.removeAttribute('aria-invalid');
    kit.busy(true);
    try {
      remember(await api(user, 'PATCH', '/api/account', {
        firstName: form.firstName.value, lastName: form.lastName.value, phone: form.phone.value
      }));
      kit.busy(false);
      kit.say('saved.', true);
    } catch (err) {
      kit.busy(false);
      if (err.status === 400) {
        form.phone.setAttribute('aria-invalid', 'true');
        form.phone.focus();
        kit.say('that phone number does not look quite right. use digits, like 415 555 0134.');
      } else {
        kit.say('we could not save just now. try again, or write to us at ' + CONTACT_EMAIL + '.');
      }
    }
  });

  // email: Firebase sends a link to the new address and only switches once it is clicked
  $('[data-current-email]').textContent = user.email || '';
  if (!passwordUser) {
    $('#email-form').hidden = true;
    $('[data-google-email]').hidden = false;
  } else {
    const ef = $('#email-form');
    const ekit = formKit(ef);
    ef.addEventListener('submit', async function (e) {
      e.preventDefault();
      ekit.say('');
      const next = ef.newEmail.value.trim();
      if (!next || next.toLowerCase() === (user.email || '').toLowerCase()) {
        ekit.say('type the new email you would like to use.');
        ef.newEmail.focus();
        return;
      }
      ekit.busy(true);
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, ef.password.value));
        if (!(await ourEmail('change', { newEmail: next }, user))) {
          await verifyBeforeUpdateEmail(user, next, { url: location.origin + '/account.html' })
            .catch(function (err) { if (err && err.code === 'auth/unauthorized-continue-uri') return verifyBeforeUpdateEmail(user, next); throw err; });
        }
        ekit.busy(false);
        ef.reset();
        ekit.say('we sent a link to ' + next + '. click it to finish the change. until then, keep signing in with ' + user.email + '.', true);
      } catch (err) {
        ekit.busy(false);
        ekit.say(friendly(err));
      }
    });
  }

  // deleting the account: ask again who they are, then ask our server to remove everything
  const zone = $('#delete-zone');
  const dform = $('#delete-form');
  const dkit = formKit(dform);
  if (!passwordUser) dform.querySelector('.field').hidden = true;
  $('[data-delete-start]').addEventListener('click', function () {
    zone.hidden = false;
    (passwordUser ? dform.password : dform.querySelector('button[type="submit"]')).focus();
  });
  $('[data-delete-cancel]').addEventListener('click', function () { zone.hidden = true; dkit.say(''); });
  dform.addEventListener('submit', async function (e) {
    e.preventDefault();
    dkit.say('');
    dkit.busy(true);
    try {
      if (passwordUser) await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, dform.password.value));
      else await reauthenticateWithPopup(user, new GoogleAuthProvider());
      await user.getIdToken(true);
      await api(user, 'DELETE', '/api/account');
      await signOut(auth).catch(function () {});
      setHint(null);
      paintHeader(null);
      view.hidden = true;
      $('[data-details-intro]').hidden = true;
      notice.textContent = 'your account and everything in it are gone. thank you for being here.';
      notice.hidden = false;
    } catch (err) {
      dkit.busy(false);
      dkit.say(err && err.code ? friendly(err) : 'we could not delete your account just now. try again, or write to us at ' + CONTACT_EMAIL + '.');
    }
  });
}

function dateText(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).toLowerCase();
}
function moneyText(m) {
  if (!m) return '';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: m.currency }).format(m.cents / 100); }
  catch (e) { return '$' + (m.cents / 100).toFixed(2); }
}
const STATUS_TEXT = { paid: 'paid. we are getting it ready.', complete: 'complete.', canceled: 'canceled.' };

async function ordersPage() {
  const user = await signedIn();
  if (!user) return;
  const list = $('#orders-list');
  const notice = $('#account-notice');
  let orders;
  try {
    orders = (await api(user, 'GET', '/api/account/orders')).orders;
  } catch (e) {
    notice.textContent = 'we could not load your orders just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
    notice.hidden = false;
    return;
  }
  if (!orders.length) {
    notice.textContent = 'no orders yet. when you check out while signed in, your orders will show up here.';
    notice.hidden = false;
    return;
  }
  orders.forEach(function (o) {
    const card = document.createElement('article');
    card.className = 'card clean order';
    const head = document.createElement('div');
    head.className = 'order-head';
    const when = document.createElement('h2');
    when.className = 'order-date';
    when.textContent = dateText(o.date);
    const num = document.createElement('span');
    num.className = 'caption';
    num.textContent = 'order ' + o.number.toLowerCase();
    head.append(when, num);
    const items = document.createElement('ul');
    items.className = 'order-items';
    o.items.forEach(function (it) {
      const li = document.createElement('li');
      li.textContent = it.qty + ' × ' + it.name;
      items.appendChild(li);
    });
    const foot = document.createElement('div');
    foot.className = 'order-foot';
    const st = document.createElement('span');
    st.className = 'body-sm muted';
    st.textContent = STATUS_TEXT[o.status] || '';
    const total = document.createElement('span');
    total.className = 'body-sm';
    total.textContent = moneyText(o.total);
    foot.append(st, total);
    card.append(head, items, foot);
    list.appendChild(card);
  });
  list.hidden = false;
}

const page = document.body.getAttribute('data-account-page');
if (page === 'sign-in') signInPage();
else if (page === 'create') createPage();
else if (page === 'reset') resetPage();
else if (page === 'home') accountPage();
else if (page === 'details') detailsPage();
else if (page === 'orders') ordersPage();
else if (page === 'register') registerPage();
else if (page === 'collection') collectionPage();
