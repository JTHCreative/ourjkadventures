// j+k adventures: the account emails, in the same letterhead as every other email from the shop.
//   POST /api/account/email/verify   (signed in)          "confirm your email", to the account's own address
//   POST /api/account/email/change   (signed in, recent)  { newEmail }  "confirm your new email", to the new address
//   POST /api/account/email/reset    (signed out)         { email }     "choose a new password"
//
// Firebase makes the link (it's still Firebase that checks it when it's pressed), but hands it back to us instead of
// sending its own plain email, and we send it through Resend like the order emails (server/firebase.js accountLink).
// Like the bank printing your new card but letting the shop put it in a nice envelope.
//
// If Resend isn't set up, or this answers 503, the browser falls back to Firebase sending its own email
// (site/assets/account.js), so nobody is ever stuck without a link. Firebase also still sends one email itself:
// "your email was changed" to the old address once a change goes through. Its wording is set in the Firebase
// console (docs/setup/firebase.md, "account emails").
//
// Limits, so this can't be used to fill someone's inbox: at most PER_ADDRESS of each kind a day to one address,
// and at most RESETS_PER_CONNECTION reset requests a day from one connection. Both counted scrambled, like the
// votes: Firestore account_mail_days/{hash} { count, day }.
// A reset answers the same whether or not there's an account for that email, so nobody can check who has one.

import { configured, userFromRequest, firestoreGet, firestoreCommit, accountLink } from './firebase.js';
import { emailConfigured, emailsLeftToday, sendBatch, escapeHtml as e } from './email.js';
import { emailPage, para, TEXT_SIGNOFF } from './email-look.js';
import { cleanEmail } from './notify.js';
import { scramble } from './interest.js';
import { fromOurSite } from './same-site.js';

export const PER_ADDRESS = 3;
export const RESETS_PER_CONNECTION = 10;
const RECENT_SIGN_IN = 5 * 60; // seconds

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

const FOOTER = "you're getting this because of an account at ourjkadventures.com. questions? just reply to this email.";

/* ---------- the three emails ---------- */
function accountEmail({ origin, subject, hi, lead, button, after }) {
  const text = subject + '\n\n' + hi + '\n\n' + lead + '\n\n' + button.label + ': ' + button.href + '\n\n' + after + '\n\n' + TEXT_SIGNOFF + '\n\n' + FOOTER;
  const html = emailPage({
    origin, title: subject + '.', preheader: lead,
    body: [para(e(hi)), para(e(lead))],
    button,
    small: e(after),
    footer: e(FOOTER)
  });
  return { subject, text, html };
}
function hiTo(name) { return name ? 'hi ' + name + ',' : 'hi there,'; }

export function verifyEmail(link, name, origin) {
  return accountEmail({
    origin, subject: 'confirm your email', hi: hiTo(name),
    lead: 'thanks for making an account with us! press the button to confirm this is your email, so we know it\'s really you.',
    button: { href: link, label: 'confirm my email' },
    after: "didn't make an account at ourjkadventures.com? you can ignore this email."
  });
}
export function resetEmail(link, origin) {
  return accountEmail({
    origin, subject: 'choose a new password', hi: 'hi there,',
    lead: 'someone (we hope it was you) asked to reset the password for your j+k adventures account. press the button to choose a new one.',
    button: { href: link, label: 'choose a new password' },
    after: "the link works for an hour. didn't ask? you can ignore this email, and your password stays the same."
  });
}
export function changeEmail(link, name, origin) {
  return accountEmail({
    origin, subject: 'confirm your new email', hi: hiTo(name),
    lead: 'you asked to change the email on your j+k adventures account to this one. press the button to finish the change. until then, keep signing in with your old email.',
    button: { href: link, label: 'confirm my new email' },
    after: "didn't ask? you can ignore this email, and nothing changes."
  });
}

/* ---------- limits ---------- */
async function underLimit(env, key, max, fetchFn) {
  const day = new Date().toISOString().slice(0, 10);
  const path = 'account_mail_days/' + (await scramble(env, 'account-mail|' + day + '|' + key));
  const had = await firestoreGet(env, path, fetchFn);
  if (had && had.count >= max) return false;
  await firestoreCommit(env, [{ add: path, field: 'count', data: { day } }], fetchFn);
  return true;
}

// a link, with the page to come back to after. if Firebase doesn't know our address yet, the link goes without it
async function linkFor(env, body, back, fetchFn) {
  try { return await accountLink(env, { ...body, continueUrl: back }, fetchFn); } catch (err) {
    if (!/CONTINUE_URI|UNAUTHORIZED_DOMAIN|DOMAIN/.test(err.code)) throw err;
    return accountLink(env, body, fetchFn);
  }
}

async function send(env, to, m, key, fetchFn) {
  await sendBatch(env, [{ to, subject: m.subject, text: m.text, html: m.html }], key, fetchFn);
}

// "juniper" from the account folder, or from the google sign-in
async function firstName(env, user, fetchFn) {
  try {
    const doc = await firestoreGet(env, 'users/' + encodeURIComponent(user.sub), fetchFn);
    const n = String((doc && (doc.firstName || doc.displayName)) || user.name || '').trim().split(/\s+/)[0];
    return n.toLowerCase().slice(0, 40);
  } catch (err) { return ''; }
}

/* ---------- the routes ---------- */
export async function accountEmailRoute(request, env, fetchFn = fetch) {
  const url = new URL(request.url);
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  // not set up: the browser sends Firebase's own email instead
  if (!configured(env) || !emailConfigured(env)) return json({ error: 'not set up' }, 503);
  if (!fromOurSite(request)) return json({ error: 'origin' }, 403);
  const kind = url.pathname.replace(/^\/api\/account\/email\//, '');
  let body = {};
  try { body = (await request.json()) || {}; } catch (err) {}
  const origin = url.origin;

  try {
    if ((await emailsLeftToday(env, fetchFn)) < 1) return json({ error: 'not set up' }, 503);

    if (kind === 'reset') {
      const email = cleanEmail(body.email);
      if (!email) return json({ error: 'email' }, 400);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (!(await underLimit(env, 'reset-ip|' + ip, RESETS_PER_CONNECTION, fetchFn))) return json({ error: 'limit' }, 429);
      // past the limit for this address: the same answer as sent, quietly
      if (!(await underLimit(env, 'reset|' + email, PER_ADDRESS, fetchFn))) return json({ sent: true });
      let link;
      try { link = await linkFor(env, { requestType: 'PASSWORD_RESET', email }, origin + '/sign-in.html', fetchFn); } catch (err) {
        if (err.code === 'EMAIL_NOT_FOUND' || err.code === 'USER_DISABLED') return json({ sent: true });
        throw err;
      }
      await send(env, email, resetEmail(link, origin), null, fetchFn);
      return json({ sent: true });
    }

    if (kind !== 'verify' && kind !== 'change') return json({ error: 'not found' }, 404);
    const user = await userFromRequest(request, env, fetchFn);
    if (!user || typeof user.email !== 'string') return json({ error: 'signed out' }, 401);
    const name = await firstName(env, user, fetchFn);

    if (kind === 'verify') {
      if (user.email_verified === true) return json({ status: 'already' });
      if (!(await underLimit(env, 'verify|' + user.sub, PER_ADDRESS, fetchFn))) return json({ error: 'limit' }, 429);
      const link = await linkFor(env, { requestType: 'VERIFY_EMAIL', email: user.email }, origin + '/account.html', fetchFn);
      await send(env, user.email, verifyEmail(link, name, origin), null, fetchFn);
      return json({ sent: true });
    }

    // change: they typed their password a moment ago (the browser asks again first)
    if (!(user.auth_time > Date.now() / 1000 - RECENT_SIGN_IN)) return json({ error: 'sign in again' }, 403);
    const next = cleanEmail(body.newEmail);
    if (!next) return json({ error: 'email' }, 400);
    if (next === user.email.toLowerCase()) return json({ error: 'same' }, 400);
    if (!(await underLimit(env, 'change|' + user.sub, PER_ADDRESS, fetchFn))) return json({ error: 'limit' }, 429);
    let link;
    try { link = await linkFor(env, { requestType: 'VERIFY_AND_CHANGE_EMAIL', email: user.email, newEmail: next }, origin + '/account.html', fetchFn); } catch (err) {
      if (err.code === 'EMAIL_EXISTS') return json({ error: 'taken' }, 409);
      throw err;
    }
    await send(env, next, changeEmail(link, name, origin), null, fetchFn);
    return json({ sent: true });
  } catch (err) {
    console.log('account email error', kind, err.message);
    return json({ error: 'unavailable' }, 503);
  }
}
