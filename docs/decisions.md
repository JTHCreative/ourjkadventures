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

## 2026-10-26 The shop stays closed until the owner opens it
`products.json` has a `shop_open` master switch, set to `false`. While it is false every button reads
"coming soon" and is disabled, the bag shows a calm note instead of "check out", and `/api/checkout`
refuses every order (403), even if someone crafts the request by hand. Anything other than
`"shop_open": true` counts as closed, so a missing or mistyped switch fails safe. Every item is also
marked `sold_out: true` as a second lock. The owner flips the switch when Square stock is ready.

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
