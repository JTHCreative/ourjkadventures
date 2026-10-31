/* j+k adventures: accounts. Firebase Authentication holds passwords and hands out sign-in tickets (ID tokens).
   This file runs the sign-in, create, reset, account, details and orders pages, and lends a ticket to checkout (see app.js).
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
      await sendEmailVerification(cred.user, { url: location.origin + '/account.html' })
        .catch(function () { return sendEmailVerification(cred.user); })
        .catch(function () {});
      await hello(cred.user, name).catch(function () {});
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
      await sendPasswordResetEmail(auth, form.email.value.trim());
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
function sendVerify(user) {
  return sendEmailVerification(user, { url: location.origin + '/account.html' }).catch(function () { return sendEmailVerification(user); });
}

async function accountPage() {
  const user = await signedIn();
  if (!user) return;
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
        await verifyBeforeUpdateEmail(user, next, { url: location.origin + '/account.html' })
          .catch(function (err) { if (err && err.code === 'auth/unauthorized-continue-uri') return verifyBeforeUpdateEmail(user, next); throw err; });
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
