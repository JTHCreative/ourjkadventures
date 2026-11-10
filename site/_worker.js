// j+k adventures: serves the static site, each pup club pin's own page, the catalog (Square prices and stock), Square checkout links,
// accounts, reviews, "i'm interested" votes for products not in the shop yet, pin requests, and the owner's /admin.
// Secrets live in Cloudflare (Settings > Variables and secrets), never in the page:
//   SQUARE_ACCESS_TOKEN  (secret)  your Square access token
//   SQUARE_LOCATION_ID             the Square location that takes the sale
//   SQUARE_ENV                     "sandbox" while testing, "production" when live
//   SQUARE_APPLICATION_ID          the checkout page's embedded card form (Square's Web Payments SDK), see server/checkout.js
//   SUPPORT_EMAIL (optional)       shown to buyers on Square's hosted checkout page (the fallback)
//   FIREBASE_PROJECT_ID, FIREBASE_SERVICE_ACCOUNT  accounts, see server/firebase.js
//   ADMIN_EMAILS                   who may use /admin, see server/admin.js
//   INSTAGRAM_ACCESS_TOKEN, META_APP_SECRET, REEL_STORE  the About page's reels, see server/instagram.js
//   RESEND_API_KEY, EMAIL_FROM, EMAIL_DAILY_LIMIT  every email the site sends, see server/email.js
//   SQUARE_WEBHOOK_SIGNATURE_KEY, SQUARE_WEBHOOK_URL  Square's "it's paid" doorbell, see server/square-webhook.js
//   REVIEW_PHOTOS                  the R2 bucket for review photos and the owner's product photos, see server/photos.js and server/media.js
//
// The account code lives in ../server so it is bundled into this worker but never published as a file.

import { account } from '../server/account.js';
import { reviews } from '../server/reviews.js';
import { admin } from '../server/admin.js';
import { catalogRoute, noteInterest } from '../server/catalog.js';
import { checkoutRoute } from '../server/checkout.js';
import { APPLE_PAY_PATH, applePayFile } from '../server/apple-pay.js';
import { interestRoute } from '../server/interest.js';
import { notifyRoute } from '../server/notify.js';
import { pinRequestRoute } from '../server/pin-requests.js';
import { squareWebhook } from '../server/square-webhook.js';
import { accountEmailRoute } from '../server/account-emails.js';
import { reelsRoute } from '../server/instagram.js';
import { mediaRoute } from '../server/media.js';
import { pupPageRoute } from '../server/pup-pages.js';
import { staticOrNotFound } from '../server/not-found.js';

// old pup club addresses that now live under a new name
const RENAMED_PUPS = { poodle: 'doodle' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // one real address: a page asked for at www.ourjkadventures.com moves to ourjkadventures.com, so sign-ins, saved
    // bags and the "i'm interested" ticket all live in one place. only page visits (GET/HEAD): a POST is let through.
    // never /api/: Cloudflare hands out plain pages (admin.html, about.html) without asking this worker, so a page can
    // still be open at www, and a browser won't follow its own data request to the other address (CORS). redirecting
    // /api/ there left /admin saying "we could not reach the server" and hid the about page's reels
    if (url.hostname.startsWith('www.') && (request.method === 'GET' || request.method === 'HEAD') && !url.pathname.startsWith('/api/')) {
      return Response.redirect(url.protocol + '//' + url.hostname.slice(4) + url.pathname + url.search, 301);
    }
    // Apple Pay's domain check (server/apple-pay.js)
    if (url.pathname === APPLE_PAY_PATH) return applePayFile();
    if (url.pathname === '/api/checkout' || url.pathname === '/api/checkout/quote' || url.pathname === '/api/checkout/pay') return checkoutRoute(request, env, url);
    if (url.pathname === '/api/catalog') return catalogRoute(request, env);
    if (url.pathname === '/api/account' || url.pathname === '/api/account/orders') return account(request, env);
    if (url.pathname.startsWith('/api/account/email/')) return accountEmailRoute(request, env);
    if (url.pathname === '/api/square-webhook') return squareWebhook(request, env);
    if (url.pathname === '/api/reviews' || url.pathname === '/api/reviews/photo') return reviews(request, env);
    if (url.pathname === '/api/reels') return reelsRoute(request, env);
    if (url.pathname === '/api/media' || url.pathname === '/api/media/photo') return mediaRoute(request, env);
    if (url.pathname === '/api/interest') return interestRoute(request, env, fetch, noteInterest);
    if (url.pathname === '/api/notify' || url.pathname.startsWith('/api/notify/')) return notifyRoute(request, env);
    if (url.pathname === '/api/pin-request') return pinRequestRoute(request, env);
    if (url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/')) return admin(request, env);
    // a pup club pin's own page, e.g. /pup-club/corgi (server/pup-pages.js)
    const pup = /^\/pup-club\/([a-z0-9-]+)(\/?)$/.exec(url.pathname);
    if (pup && (request.method === 'GET' || request.method === 'HEAD')) {
      // a trailing slash, or a pup whose name changed (the poodle became the doodle), moves to the right address
      const slug = RENAMED_PUPS[pup[1]] || pup[1];
      if (pup[2] || slug !== pup[1]) return Response.redirect(url.origin + '/pup-club/' + slug + url.search, 301);
      return pupPageRoute(request, env, pup[1]);
    }
    return staticOrNotFound(request, env);
  }
};
