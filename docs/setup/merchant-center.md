# Google Merchant Center setup (owner steps)

Merchant Center is how products show up on Google Shopping, the Shopping tab and Google Images. Showing there
for free ("free listings") costs nothing. We are **not** turning on ads.

**How it works, in one picture:** Merchant Center is a shop window Google keeps on its own street. Every 10
minutes the website walks our own shelf list (the same one the shop page uses: names and words from
`products.json`, prices and stock from Square) and tells Google only what changed. Nothing is typed twice, and
prices only ever come from Square. The website talks to Google with the same server key Firebase already uses,
kept as a Cloudflare secret.

What Google is told, per product and size: the name, the description, a link to its own page (`/pup-club/corgi`),
a picture on white (`site/assets/img/merchant/`), the Square price, in stock or out of stock (never the count),
the brand, "new", and $5 shipping in the US. The aussie and pomeranian sizes are grouped as one product with a
size choice.

The same rules as the shop:
- **Shop closed, or none on the shelf:** "out of stock" on Google.
- **Switched off on `/admin`, or not linked to Square:** taken off Google.
- **Square or Firestore can't be read:** everything on Google goes "out of stock" until they answer.
- **Sandbox:** nothing is sent while Square is in sandbox mode, so test prices never reach Google.
- **No discounts:** no sale price is ever sent. Leave Google's "automated discounts" off (step 4).

Google's labels move around now and then, so the names below may be slightly different.

## 1. Merchant Center account
1. Go to [merchants.google.com](https://merchants.google.com) and sign in as **ourjkadventures@gmail.com**.
2. Fill in the business details: the name **j+k adventures**, the country **United States**, and the website
   **https://ourjkadventures.com**.
3. **Verify and claim the website.** If the site is already in Google Search Console under the same Google
   account (`setup/google-search.md`), pick that. If it asks to add an HTML tag to the home page instead, send the
   tag to Claude to add, then press verify once it's deployed. Step 7 needs this: Google won't link the website's
   key until the site is verified.
4. Note the **account number** at the top right (a long number). That's `MERCHANT_ACCOUNT_ID`.

## 2. Shipping, returns and tax in Merchant Center
Google wants these before it shows products.
1. **Shipping:** add a shipping service for the United States, $5 flat, matching the shop. (The website also sends
   $5 with each product, so the two agree.)
2. **Returns:** add your return policy. Whatever you decide here, tell Claude too, so the pup pages can say the
   same (`roadmap.md`, "shipping and returns in the product data").
3. **Sales tax**, if it asks: set it the same way as `TAX_PERCENT` in Cloudflare (the Square checkout).

## 3. Turn these off (or leave them off)
1. **Automated feeds** (Google building products by itself by reading the website): **off**. The website sends
   the products itself, and with both on, each pin would show twice. In Merchant Center: Products, then Data
   sources (or Settings, then Data sources), then automated feeds.
2. **Automated discounts:** **off**. It lets Google lower our prices by itself, and we never discount.
3. **Ads / Performance Max:** not needed. Free listings are enough.

## 4. Turn on the Merchant API in Google Cloud
The website's key lives in the Firebase project, so the API is switched on there.
1. Go to [console.cloud.google.com](https://console.cloud.google.com) and pick the project **jk-adventures-website**
   (top left).
2. APIs and services, then Library. Search for **Merchant API** and press **Enable**.

## 5. Add the website's key as a user in Merchant Center
1. Find the key's email address: [Firebase console](https://console.firebase.google.com), the
   **jk-adventures-website** project, the gear, then Project settings, then Service accounts. It looks like
   `firebase-adminsdk-xxxxx@jk-adventures-website.iam.gserviceaccount.com`. (It's the same key that's in the
   `FIREBASE_SERVICE_ACCOUNT` secret. You only need the email, never the key itself.)
2. In Merchant Center: the gear (settings), then **People and access**, then **Add person**.
3. Paste that email and give it **Admin** access. Google won't send it emails, since it's a program, not a person.

## 6. Tell the website the account number
1. Cloudflare: Workers and Pages, then **ourjkadventures**, then Settings, then Variables and secrets.
2. Add **`MERCHANT_ACCOUNT_ID`** as plain text (not a secret: it isn't one), with the account number from step 1.4.
3. Save and deploy. The 10-minute timer is already in `wrangler.jsonc`, so nothing else changes there.

## 7. Link the website's Google Cloud project (once)
Google asks each program that uses the Merchant API to introduce itself once.
1. Open **/admin** and scroll to **google shopping**. It should say nothing has been sent yet.
2. Press **link google cloud**. It should say "linked." If it says "google said: ...", the usual reasons are that
   the website isn't verified yet (step 1.3), the Merchant API isn't on (step 4), or the key isn't a user yet
   (step 5). Fix that and press it again.
3. Your email gets Google's notes about the API (changes, problems) from then on.

## 8. First send
1. On **/admin**, press **send to google now**. The card lists each product sent, its price, and whether it's in
   stock.
2. Google takes a few days to look at new products. Each line then says "showing on google", "google is looking"
   or "google said no", with what to fix underneath ("to fix: ...").
3. After that you don't need to do anything: every 10 minutes the website sends what changed, and once a week it
   sends everything again so Google never forgets a product.

## Optional: your own product list
The website makes its own product list in Merchant Center, called **website (ourjkadventures.com)**. If you'd
rather make one by hand (Products, then Data sources, then add a product source, "API"), put its number in
Cloudflare as **`MERCHANT_DATA_SOURCE`** and the website uses that instead.

## Adding a product later
After adding a product to `products.json`, make its Google picture too: `python3 scripts/merchant-pictures.py`
(a test checks every product has one). A product only goes to Google if it has its own page: every pup club pin
does, the Bay Area board does (`/bay-area-pin-board`), and a new kind of product needs a line in `PAGES` in
`server/merchant.js`.
