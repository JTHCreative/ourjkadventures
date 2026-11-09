# Square setup (owner steps)

## Phase 0: checkout
1. Create a Square account at squareup.com. Finish business details and add the bank account for payouts.
2. Go to **developer.squareup.com** > **Apps** > **+** and create an app, e.g. "jk adventures site".
3. Open the app > **Credentials**. Toggle **Sandbox**. Copy:
   - Sandbox **Access token** → Cloudflare `SQUARE_ACCESS_TOKEN`
   - **Locations** (left menu) > sandbox location ID → `SQUARE_LOCATION_ID`
   - Set `SQUARE_ENV` = `sandbox`
4. Test: link a sandbox item on `/admin` (phase 2 below), open the shop there, add that pin, check out, pay with card `4111 1111 1111 1111`, any future date, any CVV and zip.
   The order appears in the sandbox **Seller Dashboard** (launch it from the developer console).
5. Going live: toggle **Production**, copy the production token and your real location ID into Cloudflare,
   set `SQUARE_ENV` = `production`, redeploy. Link products on `/admin` (phase 2, step C below), open the
   shop, then make one real purchase and refund it.

## Before launch, decide
- **Shipping**: the site sends a flat fee from `products.json` (`shipping_cents`). It's set to $5 as a placeholder.
- **Sales tax**: `TAX_PERCENT` in Cloudflare. Check your rate with the CDTFA or an accountant. Not tax advice.

## Phase 2: prices and stock come from Square (built 2026-10-31)
The website now reads each product's price and stock count from your Square item library, and every
web sale lowers the same count your booth uses. Think of Square as the stockroom ledger: the website
just reads it, and the register writes to it.

### A. Give the website permission to read your items and stock
The website needs a Square access token that can read items (`ITEMS_READ`) and inventory
(`INVENTORY_READ`). The **personal access token** on your app's Credentials page has full access to
your own Square account, so it covers both. If you followed the phase 0 steps, you already have one.
1. Go to **developer.squareup.com** and sign in with your Square account.
2. Open **Apps**, then your app (for example "jk adventures site"). If there is none, press **+** and create one.
3. At the top of the page, switch between **Sandbox** (practice) and **Production** (real money). Do the
   steps below for whichever one Cloudflare should use.
4. Open **Credentials**. Copy the **Access token**. (On Production you may need to press **Show**.)
   Treat it like a house key: never paste it into a chat, an email or a file in the repo.
5. Open **Locations** in the left menu and copy the **Location ID** of the shop location your items live at.
6. In **Cloudflare > Workers & Pages > ourjkadventures > Settings > Variables and Secrets**:
   - `SQUARE_ACCESS_TOKEN`, type **Secret**: the access token.
   - `SQUARE_LOCATION_ID`, type **Text**: the location ID.
   - `SQUARE_ENV`, type **Text**: `production`, or `sandbox` while practicing.
   - Press **Deploy** so the worker picks them up.

If the admin page later says "square said no", the token can't read items or inventory. That happens
with a token made through OAuth (a "connect your Square" flow) rather than the Credentials page.
Replace it with the personal access token from step 4.

### B. Set up stock in Square
1. In the **Square Dashboard > Items & services > Item library**, open each pin.
2. Turn on **Track stock** and enter how many you have at your location.
3. The "sold out" tick in Square always wins: a ticked item shows "sold out" on the website even if it
   has a count. Untick it when new stock arrives.
4. Sandbox has its own, empty item library. To practice, open the sandbox Seller Dashboard (developer
   console > **Sandbox test accounts** > **Open in Square Dashboard**), add an item or two, and give them stock.

### C. Link each website product to its Square item
1. Sign in on the website with ourjkadventures@gmail.com, open **your account**, then **shop settings**
   (or go straight to `/admin`).
2. Under **products and square**, products are grouped: **pins** (split into pup club, hometown series and
   chinese zodiac) and **pin boards**. Click a heading to open or close it; each heading shows how many of
   its products are linked. Each pin has a standard row, and the aussie and pomeranian also have a large
   (limited edition) row. Each board is listed once. Pick the matching Square item from each dropdown. The dropdown shows Square's name,
   price and stock, for example "Large Aussie Pin (Exclusive) · $15.00 · 48 in stock".
3. Leave a size "not linked" if you don't make it. A pin with only a standard size simply shows no size choice.
4. Press **save links**. The shop shows the change within a minute.

Anything not linked shows as sold out. Sandbox and production keep separate links, so practice links
never leak into the real shop.

### D. Open the shop
On `/admin`, flip **shop open**. Every visitor sees it within a minute. Flip it back to close.

### Good to know
- Prices: change them in Square. The website shows Square's price within a minute, and Square charges that price.
- Names on Square's payment page are Square's item names (for example "Large Aussie Pin (Exclusive)").
  The website itself shows its own lowercase names.
- Tax: the checkout adds sales tax from `TAX_PERCENT` in Cloudflare, not from the tax set on each item in Square, so tax isn't added twice.
- Stock is checked fresh at checkout, so the website won't sell a pin the booth sold a moment ago.

### U.S.-only shipping and gift notes (built 2026-11-09)
The bag now asks where to send the order before it goes to Square, and only takes addresses in the 50 states
and D.C. (no territories, APO/FPO or other countries for now). The website puts that address on the Square order,
and Square's own address form is switched off, so it can't be changed to one abroad on Square's page.

1. Test it once in the **sandbox** before the shop opens: add a pin to the bag, press **check out**, fill in an
   address, tick **this is a gift** and write a note, then pay with Square's test card. If Square's page shows an
   error instead of the payment form, stop and tell Claude (the address step is new, and this is the first time
   Square sees it with a real account).
2. In the Square dashboard, open **Orders**. The order shows the ship-to name, email and address under its shipment.
   A gift also has the note there (as the shipping note), and again on the payment ("gift. write on the card: ...").
3. On `/admin`, the **gift cards to write** card lists every paid gift order: the order number, the note, the
   address it goes to, the buyer's email and what's in it. Write the card, pack it, then press **card written**
   to take it off the list. Gift orders that were never paid drop off by themselves after two days.

Good to know:
- A gift often ships straight to the person getting it, so the address may not be the buyer's. The email is
  always the buyer's (it's where Square sends the receipt).
- Square's packing slip and receipt show prices. For a gift, leave the receipt out of the box.

### Pre-orders (built 2026-11-09)
A pin with **pre-order** switched on (on `/admin`, beside available) can be bought now and ships in about 4 weeks.

1. Link the pin to its Square item on `/admin` as usual, and set its price in Square. Without a link it shows
   "being made now. coming soon." and can't be bought.
2. In Square, make sure the item is **not ticked "sold out"**. Square's payment page may refuse a sold-out item, so the
   website doesn't offer one. A stock count of zero is fine: the website doesn't check stock for pre-orders.
3. Test one in the sandbox: pre-order the pin, pay with the test card, and check that Square's page didn't object.
4. Each pre-order order is marked in the Square dashboard: "pre-order. ships in about 4 weeks" on the pin's line,
   the same on the shipping note and the payment note, and an expected ship date on the shipment. If the bag also
   had in-stock pins, the whole order waits and ships together.
5. Square counts the item below zero as pre-orders sell (for example -12 means 12 pre-ordered). When the pins
   arrive, pack the pre-orders first, then set the count in Square to what's left on the shelf, and switch
   **pre-order off** on `/admin` (and available on). Until the count is fixed, a negative count reads as sold out.
6. To change "about 4 weeks", ask Claude to change `preorder_weeks` in `site/products.json`.

### When a pin is renamed (poodle became doodle, 2026-11)
The website files a pin's settings under its short name, so a renamed pin starts fresh. After the poodle became
the doodle:
1. On `/admin`, under **products and square**, open **pins** > **pup club** and find **doodle**. Pick its Square
   item (the one the poodle used) and press **save links**. Until then the doodle shows as sold out.
2. If you had switched the poodle off ("not in the shop yet"), switch the doodle off too.
3. If the poodle was one of your **featured** picks, pick the doodle there instead.
4. Optional: rename the item in Square too (for example "Doodle Pin"), since Square's payment page shows Square's
   own name.

Anything saved for the poodle stays under the old name and isn't shown: its "i'm interested" count, the
"email me when it's here" list, and any reviews. Old links to `/pup-club/poodle` forward to `/pup-club/doodle`,
and a poodle already in someone's bag turns into a doodle.

### Still to do in phase 2: the webhook (not built yet)
1. Developer console > your app > **Webhooks** > **Add subscription**:
   - URL: `https://yourdomain.com/api/square-webhook`
   - Events: `order.updated`, `payment.updated`
   - Copy the **Signature key** → Cloudflare secret `SQUARE_WEBHOOK_SIGNATURE_KEY`
   - Put the exact URL in Cloudflare `SQUARE_WEBHOOK_URL`
