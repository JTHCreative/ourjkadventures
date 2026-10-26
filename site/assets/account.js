/* j+k adventures: accounts. Firebase Authentication holds passwords and hands out sign-in tickets (ID tokens).
   This file runs the sign-in, create, reset and account pages, and lends a ticket to checkout (see app.js).
   Customer details come from our own server at /api/account, never straight from Firestore. */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendEmailVerification,
  sendPasswordResetEmail, signInWithPopup, GoogleAuthProvider, signOut, updateProfile, EmailAuthProvider,
  reauthenticateWithCredential, reauthenticateWithPopup
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
const CONTACT_EMAIL = 'jkadventures25@gmail.com';
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

// say hello to our server: it creates the customer's folder the first time and returns it
async function hello(user, name) {
  const token = await user.getIdToken();
  const res = await fetch('/api/account', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(name ? { name: name } : {})
  });
  if (!res.ok) throw new Error('account ' + res.status);
  const me = await res.json();
  setHint(me.name || '');
  paintHeader(me.name || '');
  return me;
}

async function googleSignIn(kit) {
  kit.say('');
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    await hello(cred.user).catch(function () {});
    location.href = 'account.html';
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
      location.href = 'account.html';
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
    const name = form.name.value.trim();
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

async function accountPage() {
  const user = await ready;
  if (!user) { location.replace('sign-in.html'); return; }
  const view = $('#account-view');
  const notice = $('#account-notice');
  const passwordUser = user.providerData.some(function (p) { return p.providerId === 'password'; });

  $('[data-email]').textContent = user.email || '';
  $('[data-sign-out]').addEventListener('click', async function () {
    await signOut(auth);
    setHint(null);
    location.href = 'index.html';
  });

  try {
    const me = await hello(user);
    $('[data-greeting]').textContent = me.name ? 'hello, ' + me.name.toLowerCase() + '.' : 'hello.';
  } catch (e) {
    notice.textContent = 'we could not open your account just now. try again in a moment, or write to us at ' + CONTACT_EMAIL + '.';
    notice.hidden = false;
  }
  view.hidden = false;

  // email check
  const verify = $('[data-verify]');
  if (user.emailVerified) {
    verify.textContent = 'confirmed.';
  } else {
    verify.textContent = 'not confirmed yet. we sent you a link.';
    const again = $('[data-verify-again]');
    again.hidden = false;
    again.addEventListener('click', async function () {
      again.disabled = true;
      try {
        await sendEmailVerification(user, { url: location.origin + '/account.html' }).catch(function () { return sendEmailVerification(user); });
        verify.textContent = 'sent. check your inbox, then come back to this page.';
      } catch (err) {
        verify.textContent = friendly(err) || 'we could not send it just now. try again in a few minutes.';
        again.disabled = false;
      }
    });
  }

  // deleting the account: ask again who they are, then ask our server to remove everything
  const zone = $('#delete-zone');
  const form = $('#delete-form');
  const kit = formKit(form);
  if (!passwordUser) form.querySelector('.field').hidden = true;
  $('[data-delete-start]').addEventListener('click', function () {
    zone.hidden = false;
    (passwordUser ? form.password : form.querySelector('button[type="submit"]')).focus();
  });
  $('[data-delete-cancel]').addEventListener('click', function () { zone.hidden = true; kit.say(''); });
  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    kit.say('');
    kit.busy(true);
    try {
      if (passwordUser) await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, form.password.value));
      else await reauthenticateWithPopup(user, new GoogleAuthProvider());
      const token = await user.getIdToken(true);
      const res = await fetch('/api/account', { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) throw new Error('delete ' + res.status);
      await signOut(auth).catch(function () {});
      setHint(null);
      paintHeader(null);
      view.hidden = true;
      notice.textContent = 'your account and everything in it are gone. thank you for being here.';
      notice.hidden = false;
    } catch (err) {
      kit.busy(false);
      kit.say(err && err.code ? friendly(err) : 'we could not delete your account just now. try again, or write to us at ' + CONTACT_EMAIL + '.');
    }
  });
}

const page = document.body.getAttribute('data-account-page');
if (page === 'sign-in') signInPage();
else if (page === 'create') createPage();
else if (page === 'reset') resetPage();
else if (page === 'home') accountPage();
