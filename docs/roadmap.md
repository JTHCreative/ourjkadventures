# Roadmap

Work top to bottom. Each phase ships on its own. Tick boxes as you go and add notes for anything discovered.

## Phase 0. Repo and automatic deploys
- [x] Repo on GitHub with this folder as the root
- [x] Deployed as a Cloudflare Worker with static assets (`wrangler.jsonc`), built from `main` on every push. (Planned as Pages; the Worker is what's live.)
- [ ] Square sandbox values set in Cloudflare; a test order goes through end to end
- [ ] Custom domain attached; old Wix site cancelled only after the new one is verified

**Done when:** a push to `main` updates the live site, and a sandbox order shows up in Square.

## Phase 1. Port to Astro (no visible changes)
- [ ] Astro project at the repo root, static output to `dist/`
- [ ] One `Layout.astro` for head, header, nav, footer; one page file per current page, same URLs (`/shop.html` etc. still work, or redirects via `_redirects`)
- [ ] Move `styles.css` in as global styles; keep the tokens exactly
- [ ] Bag, pup board and 3D viewer as islands. Start by moving the existing vanilla JS over; convert to React only where it simplifies (likely the bag and the account page later)
- [ ] Move `_worker.js` logic to `functions/api/checkout.ts`; delete `_worker.js`
- [ ] Cloudflare build settings: build `npm run build`, output `dist`
- [ ] Update CLAUDE.md "Running and checking"

**Done when:** a side-by-side check of every page at 1200px and 360px shows no differences, checkout still works in sandbox, and `site/` is removed.

## Phase 2. Square catalog, stock and webhook ("level 3")
- [x] ~~Script `scripts/sync-square-catalog.ts`~~ Replaced (2026-10-31): the owner adds items in Square and links each website product and size to one on `/admin` (see decisions)
- [x] `/api/catalog`: price and stock from Square (catalog + inventory counts), cached a minute. The site reads this; `products.json` keeps only what the site shows and the sizes
- [x] Checkout line items use `catalog_object_id` (the variation ID) so Square tracks stock, and checkout checks the shelf fresh
- [x] Standard / large size choice on each pin, shown when both are linked
- [ ] Booth and web share stock because both sell the same Square items. Owner: turn on stock tracking in Square and link items on `/admin` (`setup/square.md`)
- [ ] Owner: Square access token with `ITEMS_READ` and `INVENTORY_READ` in Cloudflare (`setup/square.md`, step A)
- [ ] `/api/square-webhook`: verifies `x-square-hmacsha256-signature` (HMAC-SHA256 of notification URL + raw body with the signature key), handles `order.updated` / `payment.updated`, idempotent on event ID. In this phase it only logs; phase 4 uses it for charges
- [x] Sold-out pins show "sold out" automatically; in-stock ones show "N in stock."
- [x] Owner steps in `setup/square.md`

**Done when:** selling a pin on the Square Reader lowers the count the website shows, and a sold-out item can't be checked out.

## Phase 3. Accounts
Built on the current static site, before the Astro port (see decisions, 2026-10-26).
- [x] Firebase project with Email/Password and Google providers (owner, `setup/firebase.md`)
- [x] Pages: `sign-in.html`, `create-account.html`, `reset-password.html`, `account.html` (signed-in home). Flat files like the rest of the site
- [x] Header shows "sign in" or the person's first name (from a small `jka_user` hint so other pages don't load Firebase)
- [x] Server verifies Firebase ID tokens (RS256, `aud`, `iss`, keys from Google's JWKS, cached). `server/firebase.js`
- [x] Server writes to Firestore through the REST API using the service account (OAuth JWT bearer). The browser never reads Firestore; it gets its own details from `/api/account`
- [x] Firestore security rules in the repo (`firestore.rules`): deny all browser access. Owner publishes them
- [x] Verify-email message sent on sign-up; account page shows whether it's confirmed. (Phase 4 must refuse charges until it is.)
- [x] Account deletion (deletes Auth user and Firestore data, needs a sign-in from the last 5 minutes) and a privacy page (`privacy.html`, owner to review)
- [x] Checkout passes the signed-in uid to Square (order `metadata.uid`) and pre-fills email. Untested against Square while the shop is closed
- [x] Owner set up Firebase and Cloudflare; live click-through passed (2026-10-26)
- [x] Account page: check mark next to a confirmed email; links to "your orders" and "your details"
- [x] `account-details.html`: first and last name, optional phone, change email (link to the new address), delete account
- [x] `orders.html`: paid orders placed while signed in, read from Square (see architecture)
- [ ] Owner: lowercase email templates in Firebase (Claude Code can draft)

Tests: `node --test tests/*.test.mjs` (ticket checks and `/api/account` with Google faked). The pages were
also driven end to end in a browser against the real Firebase library with Google's services faked.

**Done when:** someone can create an account with email or Google, sign out and back in, see their account page, and delete it.

## Phase 4. The Collector's Path
Spec: `collectors-path-spec.md`. Business rules: `pricing-and-loyalty.md`.
- [ ] Every charge comes from claiming a code (see spec). Codes and serials generated in batches by a script, with a printable QR sticker sheet (QR → `/p/<serial>`) and matching hidden code cards
- [ ] `/p/<serial>` page: shows that pin to anyone who scans the sticker
- [ ] 3 and 6 rewards on the first lap only; free pin at 10 every lap
- [ ] Skip auto-claim on orders from the Square "wholesale" customer group; flag accounts redeeming more than 20 codes a day
- [ ] `/admin/pack` packing tool: scan serials for paid web orders from signed-in buyers, claims their codes automatically
- [ ] Account page shows charges and what's unlocked at 3, 6, 10
- [ ] Free pin at 10 can only be added to a bag that already has a paid item; redeeming resets to 0
- [ ] "redeem code" on `/account` for everyone else (signed-out web buyers, Etsy, retail), rate-limited
- [ ] Booth mode in the packing tool: scan serial, enter buyer email, claim if it matches a verified account
- [ ] Early access (3 charges) gate for new drops

**Done when:** every rule in the spec has a test, and a full path from 0 to 10 and redemption works in sandbox.

## Phase 5. Polish
- [x] Contact email wrapping fix at narrow widths (breaks after the @)
- [x] Bay Area board shown on a living room wall on `pin-boards.html` (wiggles like the pups), with its own zoomable page `bay-area-pin-board.html` (2026-10-31)
- [ ] Real product photos for the Bay Area board
- [x] Reel door ("out and about."): a ring of reels you drag, tap or step through (`assets/reel-door.js`, spec `reel-door-spec.md`). Built with 8 placeholder reels (2026-11-01)
- [x] Owner changes (2026-11-01): moved to the About page; reels sized so the front one and both neighbours always fit whole; tapping the front reel opens it full screen with a close button at the top; no arrows on phones (upright or sideways)
- [x] Reel door: real reels from our Instagram (spec, Path A). `/api/reels` (30 minute saved copy in Workers KV, last copy kept if Instagram is down), "connect instagram" on `/admin`, weekly key renewal (cron, mondays). 1 reel sits alone; 2 reels each show twice (2026-11-01)
- [ ] Owner: Meta app, `REEL_STORE` KV namespace and the two secrets (`setup/instagram.md`, steps 1 to 3), then send the KV ID so it goes in `wrangler.jsonc`, then **connect instagram** on `/admin`. Until then the About page shows the stand-in reels
- [ ] Chinese Zodiac and Hometown Series pages when those pins exist
- [ ] Remaining 3D models as they arrive (`/add-3d-model`)
- [x] Home page restructured: full-width video reel with the headline on top, then a two-column story section
- [x] Owner: send the reel video (MP4, ideally under 10 MB, no sound needed) and a still frame for the poster. Hero loop v4 is live, with tall phone copies
- [x] Floating shop + bag pill once the header scrolls away
- [x] Pup pin reviews: 1 to 5 stars and a note from signed-in accounts, approved by the owner first, "kind words." on the home page (`setup/reviews.md`)
- [x] Owner's page `/admin` (2026-10-31): shop open switch (Firestore `settings/shop`), Square links, review approval. Owner is a confirmed email in `ADMIN_EMAILS`, not a custom claim (see decisions)
- [ ] Owner: add `ADMIN_EMAILS` in Cloudflare and publish the updated `firestore.rules` (`setup/firebase.md`, steps 14 to 17)
- [ ] Owner: approve the first reviews on `/admin`
