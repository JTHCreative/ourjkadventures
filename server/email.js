// j+k adventures: sending email, through Resend (resend.com). The website's post office: Cloudflare Email Routing
// only receives mail for support@, so anything the site sends goes out through here.
//
// Cloudflare settings (Settings > Variables and secrets), see docs/setup/email.md:
//   RESEND_API_KEY     secret, the key from Resend > API Keys ("sending access" is enough)
//   EMAIL_FROM         optional, who the email is from. default: j+k adventures <support@ourjkadventures.com>
//   EMAIL_DAILY_LIMIT  optional, the most the site sends in a day. default 100, Resend's free plan
//
// We keep our own count of what went out each day (Firestore email_days/{YYYY-MM-DD}), like a tally on the post
// office wall, so the site stops at the limit itself instead of finding out from an error halfway through.

import { firestoreGet, firestoreCommit } from './firebase.js';

const API = 'https://api.resend.com';
const DEFAULT_FROM = 'j+k adventures <support@ourjkadventures.com>';
export const REPLY_TO = 'support@ourjkadventures.com';

export function emailConfigured(env) { return !!env.RESEND_API_KEY; }
export function dailyLimit(env) {
  const n = Math.floor(Number(env.EMAIL_DAILY_LIMIT));
  return n > 0 ? n : 100;
}
function today() { return new Date().toISOString().slice(0, 10); }
function dayDoc() { return 'email_days/' + today(); }

export async function sentToday(env, fetchFn = fetch) {
  const d = await firestoreGet(env, dayDoc(), fetchFn);
  return (d && d.count) || 0;
}
export async function emailsLeftToday(env, fetchFn = fetch) {
  return Math.max(0, dailyLimit(env) - (await sentToday(env, fetchFn)));
}
async function noteSent(env, n, fetchFn) {
  if (n > 0) await firestoreCommit(env, [{ add: dayDoc(), field: 'count', by: n, data: { day: today() } }], fetchFn);
}

// (colors are --cobalt-700 and --ink-900 from styles.css: email apps can't read css variables)
// a few short paragraphs of plain text become a matching, very plain html version, with the links made clickable
function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function toHtml(text) {
  const paras = text.split(/\n\n+/).map((p) => escapeHtml(p).replace(/\n/g, '<br>')
    .replace(/https?:\/\/[^\s<]+/g, (u) => '<a href="' + u + '" style="color:#10407b">' + u + '</a>'));
  return '<div style="font-family:Georgia,\'EB Garamond\',serif;font-size:17px;line-height:1.5;color:#3a3532;max-width:520px">' +
    paras.map((p) => '<p style="margin:0 0 16px">' + p + '</p>').join('') + '</div>';
}

// one message: { to, subject, text, unsubscribe? }. unsubscribe is a link that stops these emails in one click
function payload(env, m) {
  const out = { from: env.EMAIL_FROM || DEFAULT_FROM, to: [m.to], reply_to: REPLY_TO, subject: m.subject, text: m.text, html: toHtml(m.text) };
  if (m.unsubscribe) {
    // mail apps show their own "unsubscribe" button from these two lines
    out.headers = { 'List-Unsubscribe': '<' + m.unsubscribe + '>, <mailto:' + REPLY_TO + '?subject=unsubscribe>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
  }
  return out;
}

async function post(env, path, body, idempotencyKey, fetchFn) {
  const headers = { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetchFn(API + path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (res.ok) return res.json().catch(() => ({}));
  const text = await res.text().catch(() => '');
  const e = new Error('resend ' + res.status + ' ' + text.slice(0, 200));
  e.status = res.status;
  throw e;
}

// Sends one email if today's count allows. Returns false (and sends nothing) when the day is full.
export async function sendOne(env, message, fetchFn = fetch) {
  if ((await emailsLeftToday(env, fetchFn)) < 1) return false;
  await post(env, '/emails', payload(env, message), null, fetchFn);
  await noteSent(env, 1, fetchFn);
  return true;
}

// Sends up to 100 emails in one go, all or none. The idempotency key means that if the same batch is sent twice
// within a day (a retry after a hiccup), Resend sends it only once. Callers keep to emailsLeftToday themselves.
export async function sendBatch(env, messages, idempotencyKey, fetchFn = fetch) {
  if (!messages.length) return 0;
  if (messages.length > 100) throw new Error('batch too big');
  await post(env, '/emails/batch', messages.map((m) => payload(env, m)), idempotencyKey, fetchFn);
  await noteSent(env, messages.length, fetchFn);
  return messages.length;
}
