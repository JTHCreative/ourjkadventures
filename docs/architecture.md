# Architecture

## In one picture
The site is a shop window. Square is the register. A small Cloudflare program is the clerk who walks
between them and holds the register key, so the window never does. Firebase is the coat check: it
holds customers' passwords and hands out tickets, and the clerk checks tickets before opening a
customer's folder in Firestore (the filing cabinet).

```
browser ──► Cloudflare Worker ──► static files in site/ (HTML, CSS, JS, images, GLBs)
   │           │
   │           ├─► /api/checkout ──► Square Checkout API ──► Square-hosted payment page
   │           │                                                  │
   │           │                    thank-you.html ◄── redirect after paying
   │           └─► /api/account  ──► checks the Firebase ticket ──► Firestore (service account)
   │
   └─► Firebase Authentication (sign in, sign up, reset, verify email) ──► ticket (ID token)
```

## Now
- **Hosting:** a Cloudflare Worker with static assets, free plan, configured in `wrangler.jsonc` and
  built from `main` on every push. `site/_worker.js` is the worker; `site/.assetsignore` keeps it from
  being published as a file. Code it imports from `server/` is bundled in by wrangler. Runtime settings
  live in the Worker's **Variables and Secrets**; `keep_vars` stops deploys wiping them.
  (The docs used to say Cloudflare Pages and `functions/`; that is not what runs.)
- **Pages:** 14 hand-written HTML files in `site/`. Each repeats the same `<head>`, header, nav and footer. Change one, change all.
- **`site/assets/app.js`** (vanilla JS, one IIFE):
  - loads `products.json`, builds the pup board and the board card
  - the bag lives in `localStorage` (`jka_cart`, `{slug: qty}`), max 20 per line
  - "check out" POSTs `{items:[{slug, qty}]}` to `/api/checkout` and redirects to the returned Square URL
  - `thank-you.html` clears the bag on load
  - "See in 3D" lazy-loads `@google/model-viewer@3.5.0` from jsDelivr on first click
- **`site/_worker.js`** (Pages advanced mode, so `functions/` is ignored while this file exists):
  - looks up prices in `products.json` server-side, rejects unknown slugs, bad quantities, sold-out items
  - creates a Square payment link: `POST /v2/online-checkout/payment-links` with order line items, optional `order.taxes` from `TAX_PERCENT`, a flat `shipping_fee`, `ask_for_shipping_address`, `redirect_url` = `/thank-you.html`
  - uses `connect.squareupsandbox.com` when `SQUARE_ENV=sandbox`
  - Square API version is pinned in `SQUARE_VERSION`
- **Header:** every page uses the same slim header (logo left, links right; stacked and centered on phones). Inner pages use the full-color logo `logo.svg`.
- **Home page:** the same header, made see-through (`.site-header--over`, light logo `logo-white.svg`), sits on top of a full-width video "reel" with the headline on top (`.reel` in `index.html`), then a
  two-column story section, the three sets and the pin board. The video is set with `data-mp4`,
  `data-webm` and `data-poster` on the `<video>`; `initReel()` in `app.js` adds the sources, autoplays
  muted and looped, and shows a pause button. Reduced motion or save-data means no autoplay. Until a
  video is set, or if it fails, pins on felt show instead. Files go in `site/assets/video/`
  (Cloudflare's limit is 25 MiB per file). Today's reel is hero loop v4 (44 seconds, 1080p):
  `reel-v4.webm` (VP9, ~4.7 MB) and `reel-v4.mp4` (H.264, ~5.5 MB), both 1280 wide with no sound,
  plus `reel-v4-poster.jpg` (the first frame). Upright phones (`max-width: 760px` and portrait) get
  `reel-v4-phone.webm` (~2.7 MB) and `reel-v4-phone.mp4` (~3.3 MB) instead, set with
  `data-webm-phone` / `data-mp4-phone`. These are the tall middle strip the phone would show anyway,
  so they are smaller and sharper there. Turning the phone swaps copies at the same moment.
  Made with ffmpeg, `-an` (no sound) on all of them:
  - wide: `-vf scale=1280:-2`; phone: `-vf crop=608:1080,scale=540:960`
  - webm: two-pass `-c:v libvpx-vp9`, `-b:v 850k` wide, `-b:v 500k` phone
  - mp4: two-pass `-c:v libx264 -preset slower -profile:v high -pix_fmt yuv420p -movflags +faststart`,
    `-b:v 1000k -maxrate 2000k -bufsize 2000k` wide, `-b:v 600k -maxrate 1200k -bufsize 1200k` phone
  `_headers` lets browsers keep `/assets/video/*` for a week, so a new video needs new file names
  (for example `reel-v5.*`) or returning visitors may see the old one for up to a week. Keep
  full-size originals out of the repo (they stay in Drive or git history).
- **Shop switch:** `shop_open` in `products.json`. Anything but `true` means every button reads
  "coming soon" and `/api/checkout` refuses all orders.
- **Inventory:** not tracked. `sold_out` in `products.json` is set by hand.
- **Accounts** (phase 3):
  - `site/assets/account.js` (ES module) loads Firebase Auth 12.19.0 from gstatic.com and runs
    `sign-in.html`, `create-account.html`, `reset-password.html`, `account.html`, `account-details.html`
    and `orders.html` (picked by `<body data-account-page>`). Email/password and Google (popup).
    Email changes use Firebase's `verifyBeforeUpdateEmail`: the switch happens only when the link sent
    to the new address is clicked. Google sign-ins can't change email here.
  - Other pages don't load Firebase. The header reads a `jka_user` hint in localStorage (first name,
    or absent when signed out). At checkout, `app.js` imports `account.js` only if that hint exists,
    and sends the ticket as `Authorization: Bearer`.
  - `server/firebase.js` checks tickets against Google's published keys and calls Firestore and the
    Auth admin API with the service account. Built-in crypto only, no npm libraries.
  - `server/account.js`: `POST /api/account` creates `users/{uid}` on first visit and returns the
    person's own details (and copies a changed email in); `PATCH` changes `firstName`, `lastName`,
    `phone` only; `DELETE` removes the order notes, the document and the login (needs a sign-in in the
    last 5 minutes). `GET /api/account/orders` lists order history.
  - Order history (`server/orders.js`): when a signed-in buyer starts checkout, the worker writes a
    note `users/{uid}/orders/{squareOrderId}`. The orders page asks Square for those orders
    (`BatchRetrieveOrders`) and shows only ones with this uid in `metadata` and a payment (tenders).
    Orders placed signed out, at the booth, or before accounts existed don't appear.
  - `firestore.rules` blocks all browser access.
- **Reviews** (`server/reviews.js`, `/api/reviews`): signed-in people with a confirmed email rate a pin
  1 to 5 stars with an optional note (600 characters). One review per person per pin, stored as
  `reviews/{slug}_{uid}` with `status` `pending`, `approved` or `hidden`. New and edited reviews are
  `pending` until the owner approves them on `admin.html` (`setup/reviews.md`). The public
  reads approved reviews only through the worker, which keeps them in memory for 10 minutes so busy
  pages don't run up Firestore reads; responses also tell browsers they may reuse them for 5 minutes.
  `GET ?slug=` gives one pin's approved reviews and average (all ratings count), plus the reader's own
  review when a ticket is sent. `GET ?featured=1` gives up to 6 approved 4 and 5 star reviews with
  words for the home page's "kind words." section, which stays hidden while there are none. Names
  shown are first name and last initial; the uid never leaves the server. Account deletion removes
  that person's reviews. The sign-in page honors `?next=<page>.html` (own pages only) so "sign in to
  leave a review" returns to the pup club.
- **Admin** (`server/admin.js`): an account is admin when its email is confirmed and is in
  `ADMIN_EMAILS` (plain Cloudflare variable, comma separated; default `ourjkadventures@gmail.com`).
  `/api/account` returns `admin: true` so the account page shows a "reviews" link. `admin.html` (run by
  `account.js`) lists every review via `GET /api/reviews/admin`, waiting first, and changes status with
  `PATCH /api/reviews/admin { id, status }` (`pending`, `approved`, `hidden`). The server checks admin
  on every request; the page hiding the link is only a convenience.
  - Checkout adds `metadata.uid` to the Square order and pre-fills the buyer's email.
- **Fonts:** Google Fonts (EB Garamond).

### Known gaps
- Shipping is a $5 flat placeholder in `products.json`. The owner must confirm.
- No order history, no stock counts.
- Booth sales (Square Reader) and web sales don't share stock.
- The contact email can wrap mid-word at narrow widths.

## Target
- **Astro**, static output, deployed by Cloudflare Pages from GitHub on every push. One shared layout
  for head/header/footer. Small interactive pieces (bag, pup board, account page) as islands. React
  only where it clearly helps.
- **Pages Functions in `functions/`** instead of `_worker.js` once deploys come from Git (Git builds
  compile `functions/`; drag-and-drop uploads don't).
  - `functions/api/checkout.ts`
  - `functions/api/catalog.ts` (phase 2)
  - `functions/api/square-webhook.ts` (phase 2)
  - `functions/api/account/*.ts` (phases 3 and 4)
- **Square as the source of truth for products and stock** (phase 2). Square Catalog items keyed by
  SKU = slug. Site-only content (story text, breed, image, 3D model) stays in the repo, keyed by slug.
  Checkout uses catalog object IDs so a sale lowers stock. A Square webhook tells us when an order is paid.
- **Firebase Authentication** (email/password and Google) plus **Firestore** for accounts and the
  Collector's Path (phases 3 and 4). See `collectors-path-spec.md`.

## Secrets and settings (Cloudflare → Workers & Pages → ourjkadventures → Settings → Variables and Secrets)
| Name | Kind | Phase |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | secret | 0 |
| `SQUARE_LOCATION_ID` | plain | 0 |
| `SQUARE_ENV` | plain, `sandbox` or `production` | 0 |
| `TAX_PERCENT` | plain, optional | 0 |
| `SUPPORT_EMAIL` | plain, optional | 0 |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | secret | 2 |
| `SQUARE_WEBHOOK_URL` | plain, the exact URL registered in Square (used in signature check) | 2 |
| `FIREBASE_PROJECT_ID` | plain, `jk-adventures-website` | 3 |
| `FIREBASE_SERVICE_ACCOUNT` | secret, JSON of the service account key | 3 |
| `ADMIN_EMAILS` | plain, optional. Who may use `admin.html`, comma separated. Default `ourjkadventures@gmail.com` | 3 |

Browser-side Firebase config (apiKey, authDomain, projectId, appId) is **not** secret and can live in code.
