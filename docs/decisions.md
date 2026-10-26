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
