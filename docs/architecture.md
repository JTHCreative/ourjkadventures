# Architecture

## In one picture
The site is a shop window. Square is the register. A small Cloudflare program is the clerk who walks
between them and holds the register key, so the window never does. Later, Firebase becomes the coat
check: it holds customers' passwords and hands out tickets, and the clerk checks tickets.

```
browser ──► Cloudflare Pages ──► static files (HTML, CSS, JS, images, GLBs)
               │
               └─► _worker.js  /api/checkout ──► Square Checkout API ──► Square-hosted payment page
                                                                          │
                                       thank-you.html ◄── redirect after paying
```

## Now (phase 0)
- **Hosting:** Cloudflare Pages, free plan. The domain is registered on Cloudflare too.
- **Pages:** 9 hand-written HTML files in `site/`. Each repeats the same `<head>`, header, nav and footer. Change one, change all nine.
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
- **Inventory:** not tracked. `sold_out` in `products.json` is set by hand.
- **Fonts:** Google Fonts (EB Garamond).

### Known gaps
- Shipping is a $5 flat placeholder in `products.json`. The owner must confirm.
- No order history, no accounts, no stock counts.
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

## Secrets and settings (Cloudflare → project → Settings → Variables and secrets)
| Name | Kind | Phase |
|---|---|---|
| `SQUARE_ACCESS_TOKEN` | secret | 0 |
| `SQUARE_LOCATION_ID` | plain | 0 |
| `SQUARE_ENV` | plain, `sandbox` or `production` | 0 |
| `TAX_PERCENT` | plain, optional | 0 |
| `SUPPORT_EMAIL` | plain, optional | 0 |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | secret | 2 |
| `SQUARE_WEBHOOK_URL` | plain, the exact URL registered in Square (used in signature check) | 2 |
| `FIREBASE_PROJECT_ID` | plain | 3 |
| `FIREBASE_SERVICE_ACCOUNT` | secret, JSON of the service account key | 3 |

Browser-side Firebase config (apiKey, authDomain, projectId, appId) is **not** secret and can live in code.
