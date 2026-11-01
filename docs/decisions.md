# Decisions

Newest at the bottom. Each entry: what we chose, what we didn't, and why.

## 2026-10 Left Wix
Wix's premium plan cost too much for the shop's size. The site was already custom HTML/JS calling Wix
Stores, so only the shop layer had to change. Images and 3D models were moved into the repo.

## 2026-10 Cloudflare Pages for hosting, not GitHub Pages
Cloudflare Pages is free, the domain is already on Cloudflare, and it runs server code (checkout,
webhooks, accounts). GitHub Pages is static only, and its terms say it isn't for running an
e-commerce site. GitHub still holds the code.

## 2026-10 Square for payments and the booth
One system for the website and the craft-fair card reader, so stock and sales live in one place.
Checkout uses Square's hosted payment page, so card details never touch our code. Considered: Stripe
(simpler online, but separate from the booth), Square Online's own site builder (would have lost
the custom design and 3D viewer).

## 2026-10 Prices checked on the server
The browser only sends slugs and quantities. The server looks up prices. Prevents edited prices.

## 2026-10 Astro planned over a plain React app
Most of the site is content that should load fast and be readable by search engines. Astro outputs
static pages with shared layouts and allows small interactive islands (React where useful). A
React-only single-page app would be slower to first paint and weaker for SEO.

## 2026-10 Firebase for accounts (planned)
Firebase Authentication handles email/password and Google sign-in, password storage and reset
emails. Firestore stores accounts and the Collector's Path. Free Spark plan, no card needed. Our
server verifies Firebase tokens and is the only writer of loyalty data.

## 2026-10-25 One code, one charge
Every Collector's Path charge comes from claiming a pin's registration code, and a code can be claimed
once. Signed-in web buyers get their code claimed automatically when the order is packed (the owner
scans a serial on the outside of the package, which the server maps to the hidden code). Everyone else
redeems the code themselves. This closes the double-counting gap without special cases per channel.

## 2026-10-25 Rewards, wholesale, stickers
The 3 and 6 rewards happen only on someone's first lap; the free pin at 10 repeats. Wholesale buyers
never claim codes because they resell; the end customer redeems. Wholesale is marked with a Square
customer group. The outside sticker is a QR code that links to the pin's page and carries the serial
for the packing tool.

## 2026-10-26 The shop stays closed until the owner opens it (replaced 2026-10-31, see below)
`products.json` has a `shop_open` master switch, set to `false`. While it is false every button reads
"coming soon" and is disabled, the bag shows a calm note instead of "check out", and `/api/checkout`
refuses every order (403), even if someone crafts the request by hand. Anything other than
`"shop_open": true` counts as closed, so a missing or mistyped switch fails safe. Every item is also
marked `sold_out: true` as a second lock. The owner flips the switch when Square stock is ready.

## 2026-10-29 Reviews: accounts only, approved first, never filtered by stars
Owner's choices: reviews come from signed-in accounts with a confirmed email (not only verified
buyers, since the shop isn't open yet and booth buyers have no online order), every review waits for
the owner's approval, and the home page features approved 4 and 5 star reviews that have words.
Approval screens for spam, rudeness and private details, never for low ratings: the FTC's consumer
review rule treats suppressing honest negative reviews as deceptive, so every approved rating counts
toward a pin's average and shows on its panel. Approval happens in the Firebase console for now
(no admin page yet). The worker caches approved reviews for 10 minutes because each Firestore query
is billed per document read. Same pattern as accounts: the browser never touches Firestore.

## 2026-10-26 Accounts: the browser never touches Firestore
The browser loads only Firebase's sign-in library (pinned, from Google's own CDN at gstatic.com). It
never reads Firestore. It sends its sign-in ticket to our server at `/api/account`, which checks the
ticket and returns that person's own details. So `firestore.rules` can block every browser outright.
This narrows the earlier spec, which let a signed-in browser read its own `users/{uid}` document.
Why: a smaller page (no Firestore library), one door to lock instead of two, and the rules can't be
gotten subtly wrong. The server checks tickets and talks to Firestore with built-in crypto only, no
npm libraries. Its code lives in `server/` (bundled into the worker by wrangler, never published).
Deleting an account needs a sign-in from the last 5 minutes. Built on the current static site,
before the Astro port, so accounts arrive sooner. Google Analytics from the Firebase snippet was
left out: no tracking without a decision and a cookie notice.

## 2026-10-26 Order history from notes, not a webhook
Square doesn't know which website account placed an order. At checkout, the worker writes a small note
(`users/{uid}/orders/{orderId}`) for signed-in buyers, and the orders page asks Square for those orders,
showing only paid ones whose `metadata.uid` matches. Considered: a Square webhook that records paid
orders (phase 2 plans one). The note approach needs no Square setup and shows Square's current status
each time. Trade-off: orders placed signed out or at the booth don't appear. When the phase 2 webhook
lands it can fill gaps if needed.

## 2026-10-26 Account details
First and last name and phone live in Firestore only; phone is optional and only for reaching someone
about an order. Email lives in Firebase Authentication. Changing it sends a link to the new address and
switches only when that is clicked, so a typo can't lock anyone out; the old address gets Firebase's
"your email was changed" notice. Google sign-ins don't get an email change, since Google owns that email.

## 2026-10-31 An owner's page at /admin, behind the same sign-in as customers
Owner asked to run the shop without editing files. `/admin` uses the existing Firebase sign-in (the
owner's account is a normal account), and the server decides who the owner is: a confirmed email listed
in the `ADMIN_EMAILS` Cloudflare variable. We didn't use a Firebase custom claim (phase 4's planned
`admin` claim) because setting one needs a script and a console trip, and a Cloudflare variable is one
field the owner can change. We didn't give /admin its own separate sign-in either, since the owner asked
for one account. The page only displays; every action goes through `/api/admin`, which re-checks the
ticket and the list on each request, so finding the URL gets nobody anywhere. It isn't in any menu: the
owner's account page shows a "shop settings" card when `/api/account` says `admin: true`. Firebase stays
on the account pages only, as before. Review approval moved from the Firebase console to this page,
still for spam, rudeness and private details, never for low ratings. A hidden review's writer is told
it wasn't posted rather than left "waiting" forever.

## 2026-10-31 The shop's open sign moves from products.json to Firestore
Replaces the 2026-10-26 `shop_open` switch in `products.json`. Now `settings/shop { open }` in Firestore,
flipped on `/admin`, read only by the server with the service account. Fails safe the same way: no
document, anything but `true`, or Firestore unreachable means closed. Cached a minute per worker copy
(retry after 10 seconds when a read fails), so a change reaches every visitor within about a minute
without a Firestore read per page view. While closed, every product reads "coming soon" (the owner said
"sold out"; the existing "coming soon" wording was kept because it is calmer and was the earlier choice)
and no stock counts show.

## 2026-10-31 Square is the shelf: prices and stock from Square, linked on /admin
Owner's choice: once the shop is open, the site tracks Square's stock, shows "sold out" at 0 and the count
otherwise. Prices come from Square too, so `price_cents` and `sold_out` left `products.json`; it now says
only what the site shows and which sizes a product can come in. Square only had four items (standard and
large aussie and pomeranian), named in Square's own style, so instead of matching by SKU or name (the
earlier plan was SKU = slug and a sync script) the owner picks the Square item for each website product
and size from a dropdown on `/admin`. Links are stored per Square environment (`settings/square_sandbox`,
`settings/square_production`), so practice links never touch the real shop. One Square item can back
only one website key, or its stock would be shown twice.

Sizes: the owner chose one card per dog with a standard / large choice, not separate large products, so
the pup board stays one dog per spot. A size shows only when it is linked. Names and descriptions: the
owner chose to keep the site's own lowercase wording and take only price and stock from Square, because
Square's text is title case with a sales tone. Square's names still appear on Square's payment page.

The stock count is shown as a plain fact, "48 in stock.", the same words at any number, never "only 3
left" (brand voice: no urgency). Checkout now sends `catalog_object_id` instead of a typed name and price,
which is what makes Square lower the count on a web sale (before this, web sales never touched Square
stock), and it checks the shelf fresh rather than trusting the one-minute catalog. Square's "sold out"
tick wins over any count. Tax still comes from `TAX_PERCENT`, not Square's per-item tax, to avoid
charging it twice. If Square can't be reached, everything shows as sold out.

## 2026-10-31 Large pins only for the aussie and the pomeranian
Owner: only the aussie and pomeranian come in a large size, a limited edition. Every other pup is standard
only, so `products.json` lists `["standard", "large"]` for those two and `["standard"]` for the rest, and
`/admin` no longer offers large rows nobody will fill. The site doesn't call the large pins "limited" to
customers: that reads as urgency, which the brand voice avoids. On `/admin`, the product groups fold open
and shut, each heading showing how many of its products are linked.

## 2026-11 The reel door is plain JavaScript, stacked by z-index
The spec says to use whatever the site already uses, and the site is plain HTML/JS with no build step,
so the reel door is one file (`assets/reel-door.js`) that any page can switch on with
`<div data-reel-door>`. Its motion runs off one number (the ring angle) in plain variables and writes
each reel's position straight to its style, so nothing is rebuilt per frame. Reels are layered by
z-index (closest to the front on top), not real 3D depth, because two cards in shared 3D space slice
through each other as they pass. When the Astro port happens, this file can be an island as-is.
Instagram's own embed was kept only as a fallback: it can't be styled, and its iframe swallows drags.

## 2026-11 Reel door on the About page, full screen in the page, not the browser's
The owner moved the reel door from the home page to the About page and asked for smaller reels, full
screen on tap, and no arrows on phones. Full screen is a cover over the page (a modal `<dialog>`, with a
close button at the top and Escape to close), not the browser's own fullscreen mode, because iPhones don't
allow that for anything but a bare video, and the cover keeps our caption and buttons. The spec's minimum
reel width (160px) gave way to "front reel and both neighbours always fit": reels are now 120 to 200px wide.

