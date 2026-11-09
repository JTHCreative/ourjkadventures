// j+k adventures: how every email from the website looks. One letterhead for all of them (the order emails, "it's
// here", the account emails and the owner's alerts), so they read like they came from the same little shop: the
// parchment background, the cream card with the logo on top, the lowercase heading, a red pill button, and a sign-off.
// Like a stationery box: each email writes its own words, but they all use the same paper and envelope.
//
// Colors are the site's tokens written out, because mail apps can't read css variables:
//   --accent #bf5249 (balloon-500), --on-accent #ffffff, --ink #3a3532, --ink-muted #6a645e,
//   --surface #f9f9f7 (cream-50), --surface-paper #efe6dd (parchment), --line #e2d8cd, --cobalt #10407b.
// Font: EB Garamond where the mail app has it, Georgia everywhere else.

import { escapeHtml as e } from './email.js';

export const FONT = "Georgia,'EB Garamond','Times New Roman',serif";
const INK = '#3a3532';
const MUTED = '#6a645e';
const LINE = '#e2d8cd';
const ACCENT = '#bf5249';
const LINK = '#10407b';

// The pictures are PNG copies kept for email in site/assets/img/email/ (logo.png and one per product slug),
// because many mail apps (Gmail among them) don't show the site's SVG logo or WebP pictures. They're linked by
// web address, not attached: lighter, less spam-like, and Resend doesn't allow attachments in a batch send.
export function emailImages(origin) {
  return { logo: origin + '/assets/img/email/logo.png', product: (slug) => origin + '/assets/img/email/' + slug + '.png' };
}

export function para(html, style) { return '<p style="margin:0;' + (style || '') + '">' + html + '</p>'; }
export function link(href, label) { return '<a href="' + e(href) + '" style="color:' + LINK + '">' + e(label) + '</a>'; }

// a block with a small grey label on a dashed line: "what's inside", "going to", "the note"
export function section(label, inner) {
  return '<tr><td style="padding:20px 24px 0;font-family:' + FONT + ';font-size:17px;line-height:25px;color:' + INK + '">' +
    '<div style="border-top:1.5px solid ' + LINE + ';padding-top:16px;font-size:16px;color:' + MUTED + '">' + e(label) + '</div>' +
    '<div style="margin-top:6px">' + inner + '</div></td></tr>';
}

// the order's things, each with its picture and a link to its page. items: [{ name, qty, slug, path }]
export function itemTable(items, origin) {
  const pictures = emailImages(origin);
  const rows = items.map((it) => {
    const pic = it.slug
      ? '<img src="' + e(pictures.product(it.slug)) + '" width="64" height="64" alt="" style="display:block;border:0;width:64px;height:64px;object-fit:contain">'
      : '';
    return '<tr>' +
      '<td width="76" style="padding:8px 12px 8px 0;vertical-align:middle">' + pic + '</td>' +
      '<td style="padding:8px 0;vertical-align:middle;font-family:' + FONT + ';font-size:18px;line-height:24px;color:' + INK + '">' +
        '<a href="' + e(origin + it.path) + '" style="color:' + INK + ';text-decoration:none">' + e(it.name) + '</a></td>' +
      '<td align="right" style="padding:8px 0;vertical-align:middle;font-family:' + FONT + ';font-size:17px;color:' + MUTED + '">' + (it.qty > 1 ? '× ' + it.qty : '') + '</td>' +
    '</tr>';
  }).join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>';
}

// the whole email. Everything passed in as html is already escaped by the caller; plain strings are escaped here.
//   origin     the site's address, for the logo and its link
//   title      the big heading (plain text). usually the subject, without "!" unless it's good news
//   preheader  the hidden line mail apps show next to the subject in the inbox (plain text)
//   picture    optional { src, alt, href } shown big under the heading (the "it's here" pin)
//   body       paragraphs as html, from para()
//   button     optional { href, label }
//   small      optional html under the button, small and grey (a tracking number, "the link works for an hour")
//   sections   optional html rows from section() and friends
//   signoff    html of the closing lines. default: "justin and kitty / j+k adventures"
//   footer     html under the card, small and grey: why they got it, the order number, a stop link
export function emailPage({ origin, title, preheader, picture, body = [], button, small, sections = [], signoff, footer }) {
  const logo = '<a href="' + e(origin) + '/" style="text-decoration:none"><img src="' + e(emailImages(origin).logo) +
    '" width="180" height="99" alt="j+k adventures" style="display:block;margin:0 auto;border:0;width:180px;height:auto"></a>';
  const pic = picture
    ? '<tr><td align="center" style="padding:16px 24px 0"><a href="' + e(picture.href) + '"><img src="' + e(picture.src) +
      '" width="240" alt="' + e(picture.alt || '') + '" style="display:block;margin:0 auto;border:0;width:240px;max-width:100%;height:auto"></a></td></tr>'
    : '';
  const btn = button
    ? '<tr><td align="center" style="padding:24px 24px 4px">' +
        '<a href="' + e(button.href) + '" style="display:inline-block;padding:14px 28px;background:' + ACCENT + ';color:#ffffff;font-family:' + FONT +
        ';font-size:18px;line-height:22px;text-decoration:none;border-radius:999px">' + e(button.label) + '</a></td></tr>'
    : '';
  const smallRow = small
    ? '<tr><td align="center" style="padding:6px 24px 0;font-family:' + FONT + ';font-size:15px;line-height:22px;color:' + MUTED + '">' + small + '</td></tr>'
    : '';
  const close = signoff === undefined ? para('justin and kitty<br>j+k adventures') : signoff;
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><title>' + e(title) + '</title></head>' +
    '<body style="margin:0;padding:0;background:#efe6dd">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0">' + e(preheader || '') + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#efe6dd"><tr><td align="center" style="padding:24px 12px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#f9f9f7;border-radius:16px">' +
    '<tr><td style="padding:28px 24px 8px">' + logo + '</td></tr>' +
    '<tr><td style="padding:16px 24px 0;font-family:' + FONT + ';color:' + INK + ';text-align:center">' +
      para(e(title), 'font-size:32px;line-height:38px') + '</td></tr>' +
    pic +
    (body.length
      ? '<tr><td style="padding:16px 24px 0;font-family:' + FONT + ';font-size:18px;line-height:27px;color:' + INK + '">' +
        body.map((b, i) => (i ? b.replace(/^<p style="margin:0;/, '<p style="margin:12px 0 0;') : b)).join('') + '</td></tr>'
      : '') +
    btn + smallRow +
    sections.join('') +
    '<tr><td style="padding:24px 24px 28px;font-family:' + FONT + ';font-size:17px;line-height:26px;color:' + INK + ';text-align:center">' + close + '</td></tr>' +
    '</table>' +
    (footer
      ? '<p style="max-width:520px;margin:16px auto 0;font-family:' + FONT + ';font-size:13px;line-height:19px;color:' + MUTED + ';text-align:center">' + footer + '</p>'
      : '') +
    '</td></tr></table></body></html>';
}

// the plain-text twin's sign-off, so every email ends the same way
export const TEXT_SIGNOFF = 'justin and kitty\nj+k adventures\nourjkadventures.com';
