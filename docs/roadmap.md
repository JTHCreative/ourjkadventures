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
- [x] `/api/square-webhook` (2026-11-09): verifies `x-square-hmacsha256-signature` (HMAC-SHA256 of notification URL + raw body with the signature key), handles `payment.created` / `payment.updated` once completed, once per order. Sends the thank-you and the gift-card alert; phase 4 adds charges here
- [ ] Owner: add the webhook subscription in Square and the two Cloudflare settings (`setup/square.md`, "the payment webhook")
- [x] Sold-out pins show "sold out" automatically; in-stock ones show "N in stock."
- [x] Shipping choice in the bag (2026-11-08): ground $7, priority $13, express $36, priced on the server from `products.json`, sent to Square as the shipping line. Fixed prices, not live carrier rates (see decisions)
- [x] Free ground shipping when the pins come to $40 or more (2026-11-08); boards don't count (see decisions)
- [x] U.S. states and D.C. only (2026-11-09): the bag asks for the address, the server checks the state and that the zip belongs to it, and the order carries it to Square with Square's own address form off (see decisions)
- [x] Gift option (2026-11-09): a tick and a note of up to 100 letters (200 at first), written by hand on a card. On the Square order and payment, and listed on `/admin` once paid
- [ ] Owner: one sandbox checkout with an address and a gift note, to confirm Square takes the address on the order (`setup/square.md`)
- [x] Pre-orders can be bought (2026-11-09): no stock check, 20 per order, the whole order together (see decisions)
- [ ] Maybe: a cap on how many of a pin can be pre-ordered in total (the size of the production run)
- [x] A pre-order date per product (2026-11-09): set from the gear on `/admin`; buyers see "expected in stock and shipping around <date>", and the order ships with the last pre-order. Pre-orders now sell even with Square's "sold out" tick on (the live pre-order pins all had it, so they only showed the email box)
- [x] Pre-order needs a date (2026-11-09): switching it on asks for one; buyers only ever see "around <date>", never "about 4 weeks". No date, or a passed one: not for sale until a new date is set
- [x] `/admin` as sections (2026-11-09): the menu shows one full-width card at a time instead of two columns
- [x] "On its way" email (2026-11-09): "orders to ship" on `/admin`, type the USPS tracking number, the buyer gets a branded email and the order is marked shipped in Square (see decisions)
- [ ] Owner: brand Square's receipt (logo, colour, contact) and test "mark shipped" once in the sandbox (`setup/square.md`)
- [x] "Thank you for your order" email after payment (2026-11-09), from the webhook. Gift orders also email the owner "a gift card to write"
- [x] "A new date for your pre-order" (2026-11-09): orders to ship flags paid orders whose pre-order date moved; one button emails the buyer and moves the date on the Square order
- [x] Owner alerts (2026-11-09): "a review is waiting" (at most 10 a day) to `ADMIN_EMAILS`
- [x] One letterhead for every email (`server/email-look.js`, 2026-11-09)
- [ ] Maybe: "it's been delivered" and a "how are your pins?" note a week later. Needs USPS tracking (a free USPS API account) or a paid tracking service: owner to decide
- [ ] Board shipping prices of its own before the Bay Area board goes on sale: today it would pay pin prices ($7 ground). Owner: weigh and measure one packed board, look up USPS and UPS rates
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
- [x] Account emails in the shop's letterhead (2026-11-09): confirm email, new password and new email are sent by our server with Firebase's link; Firebase sends its own only as a backup
- [ ] Owner: Firebase templates for the backup and "your email was changed" (drafted in `setup/firebase.md`, "account emails")

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
- [x] Reel door: real reels from our Instagram (spec, Path A). `/api/reels` (30 minute saved copy in Workers KV, last copy kept if Instagram is down), "connect instagram" on `/admin`. 1 reel sits alone; 2 reels each show twice (2026-11-01)
- [x] Full-screen reels: caption window and real like/comment/share counts left of the card, reel numbers removed, saved copy refreshed every 10 minutes (2026-11-04)
- [x] Switched to Meta's "Instagram API with Unified Login" (the only Instagram setup Meta offered the new app): Facebook Login for Business with a configuration, a business-owned key that doesn't expire, so no weekly renewal job (2026-11-02)
- [x] Owner: the configuration, Instagram tester invite, `REEL_STORE` KV namespace and the three settings (`setup/instagram.md`, steps 1 to 3). KV namespace bound in `wrangler.jsonc` (2026-11-02)
- [x] Reel door merged and live (#20 to #23)
- [x] Instagram connected (2026-11-02): system user key in Business settings (`INSTAGRAM_ACCESS_TOKEN`), reaching @ourjkadventures through the J+K Adventures Facebook Page (`INSTAGRAM_PAGE_ID`). Real reels show on the About page
- [x] Tidied up (2026-11-02): the Unified Login sign-in code and its tests removed; `/admin` shows a status check. Owner: optional Cloudflare and Meta app clean-up in `setup/instagram.md`
- [ ] Chinese Zodiac and Hometown Series pages when those pins exist
- [ ] Remaining 3D models as they arrive (`/add-3d-model`). Slim each one first (two gltf-transform steps, see `docs/decisions.md`, "3D pin models are slimmed"). A pin's SVG can be turned into a model with `scripts/svg-to-pin.py` (red = gold); the german shepherd was remade this way.
- [x] Home page restructured: full-width video reel with the headline on top, then a two-column story section
- [x] Owner: send the reel video (MP4, ideally under 10 MB, no sound needed) and a still frame for the poster. Hero loop v4 is live, with tall phone copies
- [x] Floating shop + bag pill once the header scrolls away
- [x] Pup pin reviews: 1 to 5 stars and a note from signed-in accounts, approved by the owner first, "kind words." on the home page (`setup/reviews.md`)
- [x] Owner's page `/admin` (2026-10-31): shop open switch (Firestore `settings/shop`), Square links, review approval. Owner is a confirmed email in `ADMIN_EMAILS`, not a custom claim (see decisions)
- [x] Shop page (2026-11-03): featured carousel on top (owner picks up to eight in-stock products on `/admin`), then pins (a button per set) and pin boards
- [ ] Owner: on `/admin`, pick the first featured products once the shop's items are linked and in stock
- [x] "i'm interested" (2026-11-04): an available switch per product on `/admin`. Switched off, it's off sale and shows an "i'm interested" button, open or closed; one vote per browser, at most 10 per pin per day from one connection. Public counts on each product and a "most asked for" card on the shop page; every tally on `/admin`
- [x] Pre-order (2026-11-08): a pre-order switch per product on `/admin`, beside available. On, the pin is off sale, takes no votes, and shows "being made now. coming soon." with the "email me when it's here" box
- [x] "i'm interested" is an on/off toggle (2026-11-04): tapping again takes the vote back, one off the tally
- [ ] Owner: switch off on `/admin` any product that isn't made yet, so it collects interest instead of reading "coming soon" or "sold out"
- [x] The bay area pin board uses the same "i'm interested" and "email me when it's here" as the pins (2026-11-04): its switch is under "pin boards" on `/admin`, and its page shows the button when it's off. Tests cover the whole loop for the board. Owner: switch it off on `/admin` while it isn't in Square yet
- [x] `/admin` shows who's waiting for each "it's here" email (2026-11-04): each address and the day they signed up, folded away under "see who's waiting", with a button to copy them all. Only ever sent to the owner
- [x] Remove an address from a waiting list on `/admin` (2026-11-09), with undo that keeps its sign-up day (old test addresses, or someone who writes in)
- [x] Rearrange the `/admin` menu (2026-11-09): the arrows icon at its top right, then drag (mouse or finger) or arrow keys. Kept per browser
- [x] "email me when it's here" (2026-11-04): sign up under "i'm interested", checked on the spot (typo hints, DNS: no confirm email, owner's call), owner presses send on `/admin` once the product is back. Through Resend's free plan (owner chose it over Cloudflare Email Sending)
- [x] Guest reviews (2026-11-04): name and email instead of an account, owner approves as always, a tick box to make an account that then takes the guest reviews in
- [x] Review photos (2026-11-05): up to 4 per review, accounts and guests, kept in Cloudflare R2, shrunk and stripped of camera notes in the browser and checked again on the server, private until the owner approves the review
- [x] Owner: create the `review-photos` R2 bucket before the photo change is merged (done 2026-11-05: Standard, automatic location)
- [ ] Owner: after merging, leave a review with a photo from your own account, approve it on `/admin`, and check it shows on the pin
- [x] Photos under the pup board (2026-11-08): a full-width card below the board and its side cards with the owner's own photos (uploaded per product on `/admin`, up to 50 each since 2026-11-09) and every photo from approved reviews. Only while a pup is open, and only that pup's (hidden on the bare board). Same R2 bucket, under `media/` (`server/media.js`)
- [x] `/admin` cards fold up (2026-11-09): tap a card's title to hide or show the rest of it. Which are folded is remembered in that browser only
- [ ] Owner: after merging, upload a photo for one pup under **product photos** on `/admin` and check it shows under the board (`setup/reviews.md`)
- [ ] Later, if the photos section gets heavy: small thumbnails for the grid (today it loads the 1600px photos, lazily)
- [ ] Owner: Resend account, domain records and `RESEND_API_KEY` in Cloudflare (`setup/email.md`), then try steps 7 to 11
- [ ] Check after the first real "it's here" send: Resend accepted the per-email `List-Unsubscribe` headers in a batch (couldn't confirm from the docs), and Gmail shows its unsubscribe button
- [ ] Owner: add `ADMIN_EMAILS` in Cloudflare and publish the updated `firestore.rules` (`setup/firebase.md`, steps 14 to 17)
- [ ] Owner: approve the first reviews on `/admin`
- [x] Search basics (2026-11-05): `sitemap.xml` (pages and pictures), `robots.txt`, a descriptive title, description and canonical address on each public page, Organization details on the home page. `tests/sitemap.test.mjs` keeps them in step
- [ ] Owner: add the site to Google Search Console and submit the sitemap (`setup/google-search.md`)
- [x] One page per pup (2026-11-05): `/pup-club/<slug>` is the board with that pup open and its own title, description, canonical address, heading and words, plus Product structured data written by the Worker (`server/pup-pages.js`) from the same Square price and stock as `/api/catalog`. No offer while the shop is closed, the pin is switched off or unlinked, or Square or Firestore can't be read. In the sitemap with pictures; the board, featured carousel and "it's here!" email use the new addresses
- [x] Pin requests (2026-11-09): "don't see your pup in the pack?" under the pup club board (only while no pup is open) leads to `/pin-request`: a pin set drop-down, what they'd like to see, optional name and email. Kept in Firestore, an alert to the owner, listed with a remove button under "pin requests" on `/admin`
- [ ] Owner: after merging, send one test request from `/pin-request` and check it lands under "pin requests" on `/admin` (and the alert email, once Resend is set up), then remove it
- [ ] Owner: read the 16 pup search descriptions (`summary` in `products.json`) and change any you'd say differently
- [ ] Owner: after deploy, check a pup page in Google's Rich Results Test (`setup/google-search.md`, "pup pages")
- [x] Search, part two (2026-11-05): the board's pups are real links, review stars on the product card (and no card when there's nothing to say), plain addresses in links, breadcrumb trails, link previews with pictures (`scripts/share-pictures.py`)
- [ ] Owner: after deploy, check a shared-link preview (`setup/google-search.md`, "shared links")
- [x] Coming-soon pages (2026-11-05): hometown series and chinese zodiac each have a short, warm paragraph in place of one line (owner's words, see `seo-next.md`). Still to ask: the first hometown towns, and whether the zodiac comes out all at once
- [x] "Page not found" page (2026-11-05): `site/404.html` for any address we don't have, shown by the worker (`server/not-found.js`). Cloudflare's own `not_found_handling` setting was tried and dropped: it answered a browser's visit to `/pup-club/corgi` with "not found" before the worker could build the page
- [x] Sitemap dates from git: `python3 scripts/sitemap-dates.py` (`--check` to only look). Owner: by hand, or a GitHub Action?
- [ ] Shipping and returns in the product data (`shippingDetails`, `hasMerchantReturnPolicy`), once the owner says where we ship and what the return policy is. Google lists them as recommended, not required
- [ ] The pup club intro says "pins from $12", a price typed into the page. Prices should come from Square only: reword it or fill it from the catalog
