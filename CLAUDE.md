# CLAUDE.md

Guidance for Claude Code working in this repo. Read this first, then the doc that matches the task.

## What this is
The website and shop for **j+k adventures**, a small enamel pin business (Pup Club dog pins, upcoming
Hometown Series and Chinese Zodiac, and display boards such as the Bay Area pin board). Sold online
and at craft fairs. One owner, not a full-time developer. Explain choices in plain language, and use
an everyday analogy when a concept is technical.

## Where things are
| Path | What it is |
|---|---|
| `site/` | The live static site. Plain HTML, CSS and JS, no build step. A Cloudflare Worker with static assets serves this folder (`wrangler.jsonc`), deployed from `main` |
| `site/assets/app.js` | Bag (its "check out" opens `/checkout`), pup board (switching pups: the open pup's heading, cards and photos fade out together while the page glides back up to the "pup club" line, only ever up, or to the card's top on a phone, then the next pup fades in; closing fades too; `leavePup`, `PUP_LEAVE_MS`; instant under reduced motion), size choice and stock line, speech bubbles, 3D viewer, checkout call |
| `site/pin-request.html`, `server/pin-requests.js` | The pin request page, `/pin-request`: "don't see your pup in the pack?" under the pup club board (only while no pup is open; `?set=pup-club` picks the set) leads here. A pin set from a drop-down (pup club, hometown series, chinese zodiac), what they'd like to see, and an optional name and email. `POST /api/pin-request`: kept in Firestore `pin_requests_<mode>/*`, at most 5 a day per connection (scrambled), a hidden box catches robots, nothing is sent to the person. The owner gets "a pin request" (at most 10 a day) and sees them in "pin requests" on `/admin` (`/api/admin/pin-requests`, with remove) |
| `site/checkout.html`, `site/assets/checkout.js`, `server/checkout.js` | The checkout page, `/checkout` (noindex): your email, where it goes (and the gift note), shipping, payment, an optional tip, with the order summary beside it (folded up on top on a phone). Payment is Square's own card form inside the page (Web Payments SDK, loaded from Square only here; Apple Pay, its domain file answered by `server/apple-pay.js`, and Google Pay, which only fill the payment in: the pay button charges it, and a change to the order after the tap asks for the wallet again), configured by `card` in `/api/catalog` (`SQUARE_APPLICATION_ID`). `POST /api/checkout/quote` is the summary (Square's `orders/calculate`, tax included), `POST /api/checkout/pay` makes the order and charges the one-time token (idempotent per "pay" press). Tip: "no tip" to start, 5/10/15% of the items worked out on the server, or their own amount up to $100, as Square's `tip_money`. Without `SQUARE_APPLICATION_ID` the page goes to Square's hosted page (`POST /api/checkout`, payment link) instead, without the tip. `checkout.js` uses the bag and catalog from `app.js` (`window.JKA`) |
| `site/assets/featured.js` | The featured carousel at the top of `shop.html`: up to eight in-stock picks turning on a ring, each with a floor shadow; drag or flick to spin faster, pause button, still under reduced motion. `app.js` mounts it from `/api/catalog`'s `featured` list |
| `site/assets/reel-door.js` | The reel door on the About page: a ring of reels, each on a backing card like our pin cards (hang slot, video window, printed handle and caption, warm shadow), to drag, tap or step through; tapping the front reel opens it full screen, with the caption window and the like, comment and share counts (only the public ones; shares need `instagram_manage_insights`) to the right of the card, which stays centred, and play and sound to its left (reels with licensed music, which Meta sends without a video file, ask "watch on instagram?" and open there in a new tab). Reels come from `/api/reels`; stand-ins until Instagram is connected. Spec: `docs/reel-door-spec.md` |
| `server/media.js` | The photos section under the pup board (`pup-club.html`, full width below the board and side cards, only while a pup is open, that pup's photos; fades and rises in step with the scroll, part way faded while in the bottom 12% of the window (`FADE_BAND` in `app.js`), the card by its top edge and each photo by its own, still under reduced motion): the owner's own photos per product (uploaded on `/admin`, R2 bucket `REVIEW_PHOTOS` under `media/`, listed in Firestore `media/*`, up to 50 each) then every photo on an approved review. `/api/media?slug=` for one pup, `/api/media` for the whole pack, `/api/media/photo?id=` for an owner photo |
| `site/assets/styles.css` | All styles. Design tokens are the CSS variables on `:root` |
| `site/products.json` | What the site shows: slug, name, kind, `series` for pins (`pup-club`, `hometown`, `zodiac`), which sizes a product comes in, the shipping choices (`shipping`: id, name, cents, days). **No product prices**: those come from Square |
| `site/_worker.js` | Server side (the Worker). `/api/catalog` (products with Square price and stock, whether each is available, its interest tally, and the in-stock featured picks), `/api/checkout`, `/api/checkout/quote`, `/api/checkout/pay` (all in `server/checkout.js`), `/api/account`, `/api/reviews`, `/api/interest` ("i'm interested" votes), `/api/notify` ("email me when it's here"), `/api/admin` (including `/api/admin/orders`, orders to ship, and `/api/admin/gifts`, the gift cards still to write), `/api/reels` (the About page's Instagram reels); everything else falls through to static files |
| `server/pup-pages.js` | Each pup club pin's own page, `/pup-club/<slug>`: the board (`pup-club.html`) with that pup's title, description, canonical, heading and words (`breed`, `about`, `summary` in `products.json`) filled in, its link preview (og: tags, picture in `site/assets/img/share/`), a breadcrumb trail, and a schema.org Product card with the Square price and stock, only while the pin can be bought, plus approved reviews and stars (no card when there's neither). Opening a pup on the board moves the address to its page; old `pup-club.html#<slug>` links still open it |
| `server/` | Server code the worker imports: Firebase tickets and Firestore (`firebase.js`), accounts, reviews and their photos (`reviews.js`, `photos.js`: R2 bucket `REVIEW_PHOTOS`), the shop switch (`shop.js`), Square reads (`square.js`), the catalog (`catalog.js`), the owner's API (`admin.js`), the available switches and "i'm interested" votes (`interest.js`), where orders ship and gift notes (`ship-to.js`), orders to ship and the "on its way" and "new pre-order date" emails, which write to Square (`shipped.js`), Square's payment webhook and the "thank you for your order" email (`square-webhook.js`, Cloudflare secret `SQUARE_WEBHOOK_SIGNATURE_KEY`), "email me when it's here" (`notify.js`), the account emails with Firebase's links (`account-emails.js`), the owner's alerts (`owner-alerts.js`), all in one letterhead (`email-look.js`) and sent through Resend (`email.js`, Cloudflare secret `RESEND_API_KEY`), Instagram reels with a system-user key (Cloudflare secret `INSTAGRAM_ACCESS_TOKEN`) through our Facebook Page, saved copy in Workers KV (`instagram.js`). Bundled by wrangler, never published |
| `site/admin.html`, `site/assets/admin.js` | The owner's page at `/admin`: shop open switch, orders to ship (each order folds open to labelled parts: order, what's in it, buyer, ships to with a copy button, gift card, ship it; type the USPS tracking number, "mark shipped" sends the "on its way" email and marks it shipped in Square; a gift order shows its "card to write" with a "card written" button, marking it shipped also counts its card as written, and gift orders already shipped elsewhere with a card not ticked off show under "cards still to write"; "to ship", "cards still to write" and "order history" are folds, open or shut as last left in that browser (`jka_admin_order_groups`); order history is shipped website orders, newest first, 20 at a time with "show older orders", read from Square only when opened, `/api/admin/orders/history`), Square links and an available and a pre-order switch per product, "interest and emails" (one fold per product people asked for, most asked first, with "expand all" / "collapse all" on the right under the emails line: its "i'm interested" tally, whether it's in the shop, and its "email when it's here" list with who's waiting, a remove button per address (with undo until the page is reloaded), a "clear the count" button that sets its "i'm interested" tally back to 0 (`DELETE /api/admin/interest`, not kept as "asked"), a copy button, the email preview and the send button), featured picks, product photos (upload and remove, per product), review approval, Instagram status check. A menu at the top (a button per card, built from their titles) shows one card at a time, like tabs; an arrows icon at its top right turns on rearrange mode (drag the buttons, or arrow keys; order kept in that browser, `jka_admin_menu_order`, with "back to the original order"), the menu and cards in the middle 50% of the page from 1100px wide (720px below that); the open one is kept in the address (`#admin-orders-title`) and in that browser. Each product in "products and square" has a gear for its pre-order settings (a dialog with the pre-order date). Not linked from any nav |
| `site/assets/account.js` | Firebase sign-in in the browser; runs the account pages |
| `firestore.rules` | Firestore rules: no browser access at all, including `settings/*`. The owner publishes them in the Firebase console |
| `site/sitemap.xml`, `site/robots.txt` | The map of public pages (and their pictures) for Google, and the crawler rules that point to it. Add a page to the sitemap when you add one; `tests/sitemap.test.mjs` checks the list, titles, descriptions, canonical links, link previews, breadcrumbs, and that links between pages use plain addresses (`/shop`, not `shop.html`). Link-preview pictures: `python3 scripts/share-pictures.py` after adding a product. Dates: `python3 scripts/sitemap-dates.py` after committing a page change. `site/404.html` is shown for any address we don't have, by the worker (`server/not-found.js`, not Cloudflare's `not_found_handling`, which would break the pup pages) |
| `tests/` | `node --test tests/*.test.mjs` |
| `site/assets/3d/*.glb` | 3D pin models, one per slug, shown with Google model-viewer |
| `docs/architecture.md` | How it works now and the target shape |
| `docs/roadmap.md` | The phases, in order, with "done when" checks. **Work from this.** |
| `docs/decisions.md` | Why things are the way they are. Add an entry when you make a real decision |
| `docs/brand-voice.md` | Copy and design rules. Read before writing any words a customer sees |
| `docs/collectors-path-spec.md` | Technical spec for accounts, charges and registration codes |
| `docs/manifesto.md`, `docs/pricing-and-loyalty.md` | The owner's source documents. Do not edit them |
| `docs/setup/` | Owner-facing setup steps for Square, Firebase, Cloudflare |

## Hard rules
- **Never put secrets in the repo or in browser code.** Square tokens, Firebase service account keys and webhook signature keys live in Cloudflare variables/secrets. Local values go in `.dev.vars` (gitignored). `.dev.vars.example` lists the names.
- **Prices are decided on the server.** The browser sends keys (`aussie`, `aussie:large`) and quantities only. Prices come from Square; checkout sends Square item IDs. Never trust a price, total or charge count that came from the browser.
- **Only the server decides who the owner is.** Every `/api/admin` request checks the Firebase ticket and `ADMIN_EMAILS` (confirmed email only). Never gate owner features in the browser alone.
- **The shop fails closed.** If the open sign (`settings/shop`) or Square can't be read, nothing is for sale.
- **Charges (loyalty) are only ever written by the server.** Firestore rules must block client writes to charges, rewards and codes.
- **No discounts, ever.** No sale prices, promo codes, percent-off or "was $X" UI. Rewards add something, never subtract. See `docs/pricing-and-loyalty.md`. If a request would create a discount, stop and flag it to the owner.
- **Keep it working at every commit.** Small commits, one concern each. Run the checks below before saying something is done.
- **Ask before** adding a paid service, a new third-party dependency with a runtime footprint, or changing the hosting setup.

## Voice and design (short version, full rules in `docs/brand-voice.md`)
- All customer-facing copy is lowercase. No sales or urgency language ("hurry", "deal", "limited time", "obsessed", "cute!!").
- Casual, homey and conversational, like justin and kitty talking to you at a craft fair. Not cold or poetic. The about page is the reference.
- Exclamation marks are fine in friendly text (story paragraphs, notes, thank-yous, small details), never in big headings or page titles, never stacked, never to push a sale.
- Use the tokens in `styles.css` (`--surface`, `--ink`, `--accent`, `--space-*`, `--radius-*`). Do not hardcode new colors.
- Font is EB Garamond. Accessible by default: labels on icon buttons, visible focus, `prefers-reduced-motion` respected, works at 360px wide, links never smaller than 18px, no reading text under 16px.

## Product facts
- Slugs (bag keys add `:large` for the large size): aussie, beagle, cavalier, corgi, dachshund, doodle, french-bulldog, german-shepherd, golden, husky, pit-bull, pomeranian, pug, rottweiler, shiba, yorkie, bay-area-pin-board.
- The golden retriever pin is displayed as **"goldie"**.
- The doodle pin was the poodle until 2026-11-08. Old `/pup-club/poodle` and `pup-club.html#poodle` links move to the doodle (`RENAMED_PUPS` in `_worker.js` and `app.js`), and a poodle in a saved bag becomes a doodle. Owner steps: `docs/setup/square.md`.
- Hover bubble text is `<breed> woof!`. The "i'm interested!" button, its "thank you!" line and the "it's here!" email keep their exclamation marks too.
- Prices live in Square, not the repo. Today standard pins are $12 and the two large pins (aussie, pomeranian) are $15. The Bay Area board is planned at $80 but isn't in Square yet.
- The shop is open or closed by the switch on `/admin` (Firestore `settings/shop`). It started closed.
- Each website product and size is linked to a Square item on `/admin`. Unlinked means sold out.
- Shipping: the customer picks one of three fixed choices in the bag: ground $7 (2 to 5 days), priority $13
  (1 to 3 days), express $36 (1 to 2 days), all USPS, set in `products.json` (`shipping`). The browser sends only
  the choice's id; the server sets the price on Square's shipping line. No choice sent means ground. Not live
  carrier rates (see `docs/decisions.md`). Ground is free when the pins in the order come to $40 or more at
  Square prices (`free_over_cents` on ground; `shippingCharge` in `server/catalog.js`): boards don't count, and an
  order with a board in it pays for ground until the board has its own shipping prices. Free ground sends no
  shipping line, and a `payment_note` ("free ground shipping ...") tells the owner how to send it. A standing
  shipping policy, not a discount (see `docs/decisions.md`); the bag says it once, with no countdown to it.
- We ship to the 50 U.S. states and D.C. only. The checkout page asks where to send it (buyer's email, name,
  street, city, state, zip); the server checks the state is one of ours and the zip belongs to it
  (`server/ship-to.js`) and puts the address on the Square order as a shipment (on the hosted-page fallback, with
  Square's own address form off so it can't be changed there). A "this is a gift" tick adds a note (up to 100 letters, a blank card is fine)
  that we write by hand on a card: it goes on the Square order's shipping note and payment note, and paid gift
  orders show their card to write in "orders to ship" on `/admin`. The note rides on the Square order (metadata
  `gift_note`); Firestore `gifts/<square order id>` keeps only `createdAt` (no name, email, address or note: `/admin`
  reads those from Square each time). See `docs/decisions.md`.
- Stock shows as a plain "N in stock." while the shop is open, never as urgency.
- Order emails: Square sends the receipt when someone pays (branded in Square's settings, `docs/setup/square.md`).
  We send "your order is on its way" from `/admin` ("orders to ship", `server/shipped.js`): the owner types the
  USPS tracking number and presses "mark shipped"; the buyer gets a branded email (logo, pin pictures, a "track
  your package" button, the address) through Resend, then the order is marked shipped in Square. The list is read
  from Square each time. "thank you for your order" goes out when Square's webhook (`/api/square-webhook`, `server/square-webhook.js`)
  says an order is paid, once per order, and "your refund is on its way" (`server/refunds.js`) when the owner refunds a website order
  in Square (refund.created; amount read from Square, once per refund, partial refunds say "of $X"). A paid pre-order whose date moved shows "new date to email" in "orders to ship"; the
  button sends "a new date for your pre-order" and moves the date on the Square order. The owner gets "a review is waiting"
  (at most 10 a day), "a gift card to write" and "a pin request" (at most 10 a day) at `ADMIN_EMAILS`. Account emails (confirm, new password, new email) are ours
  too, with Firebase's link; Firebase sends its own only as a backup. Every email uses `server/email-look.js`, so they all
  look alike: a new email should too. The list of them is in `docs/setup/email.md`.
- Each product has an available switch on `/admin` (`settings/available_<square mode>`; missing means available). Switched off, it's off sale even if linked and in stock, and shows "not in the shop yet." with its count ("1 is interested." / "N are interested.") and an "i'm interested!" button, open or closed. Once tapped, a line under it says "thank you! be notified when it's available:" with an email box. One vote per browser (cookie), at most 10 per pin per day per IP, both stored only scrambled; tapping again takes the vote back (one off the tally). The shop page's "most asked for" card lists the top six. Once "it's here" has gone to everyone waiting, that pin's round ends (`closeRound` in `server/interest.js`): the tally goes to 0, its votes are cleared and its round number goes up, so browsers forget their old tap (`jka_interest` keeps `slug@round`); `/admin` keeps "N people asked for it before it arrived". See `docs/decisions.md`.
- Each product also has a pre-order switch on `/admin` beside available (`settings/preorder_<square mode>`; missing means off), for pins being made. On, it wins over available, and no "i'm interested" button or public count (the server refuses votes). Since 2026-11-09 a pre-order can be bought and paid for now: pre-order can't be switched on without a date: the switch opens a "pre-order settings" dialog for the date it's expected in stock and shipping, and pre-order turns on only once that's saved (the server refuses `preorder: true` without a valid date, today to two years out; Firestore `settings/preorder_dates_<square mode>`). The gear beside the switches changes the date; it can't be emptied. While the shop is open and it's linked to a Square item, a pin on pre-order with its date shows its price, "pre-order. expected in stock and shipping around december 15." and a "pre-order" button. It isn't limited by Square's stock count or its "sold out" tick, only by 20 per order. If its date passes (or it has none), it goes back to "being made now. coming soon." with the email box until the owner sets a new one; `/admin` says so. Buyers only ever see a date. A bag with a pre-order in it ships all together around the last pre-order's date: the bag, the Square line notes, shipping note, payment note, the order's expected ship date and the thank-you page (`?preorder=2026-12-15`) all say so. The words come from `server/preorder-words.js` (and a twin `prettyDate` in `app.js`). Shop closed or not linked: "being made now. coming soon." with the "be notified when it's here:" email box, as before. Turning it off puts the pin back wherever the available switch says. See `docs/decisions.md`.
- The email box under a tapped "i'm interested!" (only once `RESEND_API_KEY` is set; otherwise just "thank you!"): no confirm email. The address is checked on the spot ("did you mean ...@gmail.com?" in the browser, the domain must take mail per DNS on the server) and goes on the list; nothing is sent until the owner presses send on `/admin` once the product is back on and the shop is open. `email.html` is only the stop link's page. One email per person per product, then off the list. The site stops at 100 emails a day (Resend's free plan). The "it's here!" email has the logo, the product's picture and a "go see the <name>" button; mail apps need PNGs, kept in `site/assets/img/email/` (`python3 scripts/email-pictures.py` after adding a product). Setup: `docs/setup/email.md`.
- 3D models exist for 12 pups. Still missing: cavalier, dachshund, french-bulldog, yorkie (their "See in 3D" button stays faded).
- The shop page has a featured carousel on top (picked on `/admin`, saved in `settings/featured_<square mode>`; only in-stock products, at most eight; hidden when none), then a "pins" card with a button per set and a "pin boards" card. A featured pup links to its own page, `/pup-club/<slug>`, and so does each pup on the board (a real link, so search engines can follow it; a tap opens it in place).
- The Bay Area board hangs top left on a six-spot gallery wall in a living room photo on `pin-boards.html` (five spots empty for future boards); tapping it opens `bay-area-pin-board.html` (zoomable full-size image, price and add to bag).
- Reviews: signed-in accounts (confirmed email) or guests. Guests give a name and email (never shown; shown as "first l." like accounts), one review per email per pin, at most 5 a day per connection, same typo hint and DNS check as the email list. Up to 4 photos per review, accounts and guests: shrunk to a 1600px JPEG in the browser (drops camera location data), checked and cleaned again on the server, stored in R2 (`review-photos`), private until the review is approved. Every review waits for approval on `/admin`, photos and all. A "create an account with us too" tick box sends them to `create-account.html` with name and email filled in (sessionStorage, never the address bar); guest reviews join an account once it signs in with that email confirmed (`claimGuestReviews` in `server/reviews.js`).
- Pin requests: under the pup club board, while no pup is open, "don't see your pup in the pack?" and a "request a breed" button lead to `/pin-request`. People pick a pin set and tell us what they'd like to see; name and email are optional (the email gets the same typo hint and DNS check as the email list). It's a suggestion jar, not a promise: nothing is sent to them, and the owner reads and removes them on `/admin`. See `docs/decisions.md`.
- Contact: support@ourjkadventures.com. Instagram: @ourjkadventures.

## Running and checking
Today (plain static site):
```
npx wrangler dev                     # serves site/ and runs the worker locally on :8787
node --test tests/*.test.mjs         # server tests (tickets, /api/account, /api/reviews), Google faked
```
Put Square sandbox values (with `SQUARE_APPLICATION_ID` for the checkout page's card form), `FIREBASE_SERVICE_ACCOUNT` and `ADMIN_EMAILS` in `.dev.vars` to test locally. Without Square,
`/api/checkout` returns 503 and every product shows sold out. Without Firebase, the shop counts as closed. The tests fake both
Google and Square (`tests/helpers.mjs`: `fakeGoogle`, `fakeSquare`, `fakeWorld`).

Before calling any change done:
1. Load every page and the bag; no console errors, no 404s.
2. Pup board: open a pin, "See in 3D" loads for a pup with a model and is disabled for one without.
3. On `/admin` (sandbox): link a sandbox item, open the shop. Then add to bag, pick a size, change quantity, check out on `/checkout` against the Square **sandbox** (test card 4111 1111 1111 1111). Close the shop again. Non-owners on `/admin` see only "this page is for the shop owner." 
4. Check a 360px-wide viewport.
5. `grep -ri "wixstatic\|wixapis" site/` returns nothing.
6. `node --test tests/*.test.mjs` passes. For account changes, also create, sign out, sign in, and delete an account.

Update this section when the toolchain changes (for example after the Astro port).

## Working style
- Plan first for anything bigger than a small fix: say what you will change and why, then do it.
- When the owner needs to do something outside the code (Square dashboard, Firebase console, Cloudflare settings), write it as numbered steps and add it to the right file in `docs/setup/`.
- Keep `docs/roadmap.md` current: tick off what's done and note anything discovered.
