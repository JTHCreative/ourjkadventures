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
- **Sales tax**: since 2026-11-09, the same tax the booth uses, set on each item in Square (today "Millbrae Sales
  Tax", 9.375%). Check the rate with the CDTFA or an accountant. Not tax advice.

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
- Tax: the checkout uses the tax set on each item in Square, the same one the booth charges (today "Millbrae Sales
  Tax", 9.375%), so web and booth sales show under one tax in Square's reports. Shipping isn't taxed.
  1. To change the rate, change it once in Square (**Settings** > **Account & Settings** > **Taxes**). The website
     follows straight away.
  2. A new pin needs the tax ticked on its item in Square, just as for the booth. Without it, it's sold untaxed
     online and at the booth alike.
  3. `TAX_PERCENT` in Cloudflare isn't used any more. You can delete it (**Workers & Pages** > **ourjkadventures**
     > **Settings** > **Variables and Secrets**); leaving it does nothing.
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
3. On `/admin`, open **orders to ship**. A paid gift order shows a **card to write** box with the note, alongside
   the address it goes to, the buyer's email and what's in it. Write the card, tuck it in, and press
   **card written**. Marking the order shipped also counts its card as written. If a gift order was marked shipped
   some other way (in Square's dashboard, say) before its card was ticked off, it's listed at the bottom under
   **cards still to write**. Gift orders that were never paid drop off by themselves after two days.

Good to know:
- A gift often ships straight to the person getting it, so the address may not be the buyer's. The email is
  always the buyer's (it's where Square sends the receipt).
- Square's packing slip and receipt show prices. For a gift, leave the receipt out of the box.

### Pre-orders (built 2026-11-09, dates added the same day)
A pin with **pre-order** switched on (on `/admin`, beside available) can be bought now with a **pre-order** button,
and ships around its pre-order date.

1. On `/admin`, open **products and square**. Link the pin to its Square item as usual (its price comes from Square).
   Without a link it shows "being made now. coming soon." with the email box, and can't be bought.
2. Switch **pre-order** on. A window asks for the date the pin is expected in stock and ready to ship. Pick it and
   press **save and turn on pre-order**. Pre-order only turns on once a date is saved; **cancel** leaves it off.
   Buyers see "pre-order. expected in stock and shipping around december 15."
3. To change the date later, press the **gear** beside the switches (**pre-order settings**) and **save date**.
   If the date passes before the pins arrive, the pin goes back to "being made now. coming soon." (no buying) until
   you set a new date with the gear. `/admin` says so under the pin.
4. Square's **"sold out" tick doesn't matter** for a pre-order: the pin is being made, so Square rightly calls it sold
   out. Nothing to change in Square.
5. Each pre-order order is marked in the Square dashboard: "pre-order. expected to ship around december 15" on the
   pin's line, "the whole order ships together around ..." on the shipping note and the payment note, and that date as
   the shipment's expected ship date. If the bag also had in-stock pins, or other pre-orders, the whole order waits
   for the last one and ships together.
6. Square counts the item below zero as pre-orders sell (for example -12 means 12 pre-ordered). When the pins
   arrive, pack the pre-orders first, then set the count in Square to what's left on the shelf, and switch
   **pre-order off** on `/admin` (and available on). Until the count is fixed, a negative count reads as sold out.
7. If a run is late, move the date with the gear. Orders already paid keep the date they were given; let those
   buyers know by email.

### Branded receipts and the "on its way" email (built 2026-11-09)
Square emails a receipt when someone pays; the website emails "your order is on its way" when you ship.

**A. Brand Square's receipt (about 5 minutes, no code)**
1. Square Dashboard > **Settings** > **Account & Settings** > **My business** > **About** (on some accounts it's
   **Business information** > **Receipts**).
2. Under **Branding**, press **+ Create new**. Upload the full logo (at least 1280 × 648 px) and the small logo
   (400 × 400 px), PNG or JPG. `site/assets/img/email/logo.png` is a start; a bigger copy of the logo looks sharper.
3. Pick the brand colour: `#bf5249` (the site's red).
4. Turn on **Show location**, and add support@ourjkadventures.com and @ourjkadventures under **Contact**.
5. Optional, under **Additional text**: a short line in our voice, for example "thank you for supporting our little
   shop! questions? write to support@ourjkadventures.com."
6. Apply the brand to your location and save. The layout and wording of the receipt stay Square's.

**B. Ship an order from `/admin`**
1. Open **orders to ship** on `/admin`. It lists paid website orders that haven't gone out, oldest first, with
   what's in each, the address to copy onto the label, the buyer's email, and any gift or pre-order note.
2. Buy the label (USPS), pack it, then type the tracking number into the box and press **mark shipped**.
3. The buyer gets the "on its way" email (logo, a picture of each pin, a **track your package** button, the
   address), and the order is marked shipped in Square with the tracking number on it. It leaves the list.
4. **See the email** under each order shows exactly what will go out (with a stand-in tracking number).
5. If it says "that didn't go through", press it again. The email won't go out twice.

Good to know:
- The website needs to change orders in Square for this (`ORDERS_WRITE`). A personal access token has it.
- Test once in the sandbox: a test order, then mark it shipped with any tracking number, e.g. `9400100000000000000000`.
  Check the order shows as shipped in Square and the email arrives. Square may also send its own shipped email
  when an order is marked shipped; if buyers get two, tell Claude.
- Without Resend set up (`docs/setup/email.md`), **mark shipped** only marks it in Square.
- These emails count toward the site's 100 a day, shared with the "it's here" emails.

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

### The payment webhook and "thank you for your order" (built 2026-11-09)
A webhook is a doorbell: when someone pays, Square rings the website to say "order 123 is paid". That's how the
website knows to send its own "thank you for your order" email (Square's receipt still goes out too, with the
prices), and to email you "a gift card to write" for a gift order. Until these steps are done, nothing rings and
neither email goes out. Everything else keeps working.

1. Go to developer.squareup.com and sign in. Open **Apps** > your app (the one whose access token the website uses).
2. At the top, switch to **Production** (do the same steps again under **Sandbox** later if you want to test there).
3. Left menu > **Webhooks** > **Subscriptions** > **Add subscription**:
   - **Name**: `website payments`
   - **Notification URL**: `https://ourjkadventures.com/api/square-webhook` (exactly this, with `https://` and no
     slash at the end)
   - **API version**: leave the newest one it offers
   - **Events**: tick `payment.created`, `payment.updated`, `refund.created` and `refund.updated`. Nothing else is needed.
   - Press **Save**.
4. Open the new subscription and find **Signature key**. Press **Show** and copy it. Treat it like a house key.
5. Cloudflare > **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**:
   - type **Secret**, name `SQUARE_WEBHOOK_SIGNATURE_KEY`, value the signature key.
   - type **Text**, name `SQUARE_WEBHOOK_URL`, value `https://ourjkadventures.com/api/square-webhook` (the same
     address you typed in step 3, letter for letter: the seal check uses it).
   - Press **Deploy**.
6. Back on the subscription in Square, press **Send test event** and pick `payment.updated`. It should show a
   **200** response. (The test names a made-up order, so no email goes out.) A **403** means the signature key or
   the URL in Cloudflare doesn't match Square's exactly. A **503** means a setting is missing or Deploy wasn't pressed.
7. The real test: buy something small yourself (the sandbox is fine if you added a sandbox subscription and are
   testing with `SQUARE_ENV` set to `sandbox`). Within a minute you should get "thank you for your order" from
   support@, as well as Square's receipt. A gift order also sends you "a gift card to write".

Good to know:
- Each order gets one thank-you, however many times Square rings (it often rings twice per payment).
- If the email can't go out just then, the website answers "try again" and Square rings again later, for up to three
  days. If the day's 100 emails are already used up, that order's thank-you is skipped rather than sent late.
- Booth sales (Square Reader) have no shipment on them, so they never get our thank-you. Square's receipt is enough.
- Later, the collector's path (charges) will listen on this same doorbell.

### Refund emails (built 2026-11-09)
When you refund a website order in Square (the dashboard or the app, all or part of it), the buyer gets "your refund
is on its way" from us, with the amount and "within 5 to 10 business days, depending on your bank". Square still sends
its own refund receipt too. It needs the refund events on the webhook:

1. developer.squareup.com > **Apps** > your app > **Production** > **Webhooks** > **Subscriptions**, and open
   `website payments`.
2. Press **Edit**, tick `refund.created` and `refund.updated` as well (keep the two payment ones), and **Save**. The
   signature key stays the same, so nothing changes in Cloudflare.
3. To test: refund a small order of your own in the Square dashboard (Transactions > the payment > **Issue refund**).
   The email should arrive within a minute.

Good to know: one email per refund, even though Square rings twice (when the refund starts and when the bank
finishes). A refund Square turns down sends nothing. Booth sales (no shipment on them) never get this email.

### Pre-order dates that move (built 2026-11-09)
If you change a pin's pre-order date (the gear on `/admin`) after people have already paid for it, those orders now
say the wrong date. **Orders to ship** flags each one with "new date to email". Open it, look at the email under
"see the email", and press **email the new date**. The buyer gets "a new date for your pre-order", and the new date
goes onto the Square order (its expected ship date and shipping note), so the flag goes away. If a pin's date moves
sooner, the email says that's good news. When the pin arrives and you switch pre-order off, nothing is flagged any more.

### Apple Pay at checkout (built 2026-11-09)
The website now asks Square to show the Apple Pay button on its checkout page. On an iPhone, iPad or Mac (Safari) with
a card in Apple Wallet, buyers see "Pay with Apple Pay" above the card form; everyone else sees the card form as before.
The money, the order, the receipt and the "orders to ship" list are all the same as a card payment.

You do **not** need the CSR (certificate signing request) file from Square's Apple Pay page. That file is for iPhone
apps built with Square's In-App Payments SDK. Leave it unused; don't upload it to Apple. No file needs adding to the
website either, because the checkout page is on Square's own web address, which Square has already registered with Apple.

1. In the Square Dashboard, open **Settings > Payments** (or **Online checkout > Settings**, depending on your
   dashboard) and make sure **Apple Pay** is turned on for online payments. If there's no switch, it's on by default.
2. Deploy `main` (Cloudflare picks it up on its own).
3. Check it on sandbox first if you like: with `SQUARE_ENV=sandbox`, add a pin to the bag on an iPhone and press
   check out. Square's sandbox page shows the Apple Pay button but won't charge a real card.
4. On the live site, open the bag on an iPhone with a card in Wallet, press check out, and look for the Apple Pay
   button on Square's page. You can close the page without paying.
5. If the button doesn't show: make sure Apple Pay is on in Square (step 1), that you're in Safari (or Chrome on
   iOS 16+), and that Wallet has a card. A Square account that can't take Apple Pay just shows the card form, and the
   order still works.

### The checkout page, with Square's card form inside it (built 2026-11-09)
"check out" in the bag now opens our own page, `/checkout`: your email, where it goes, shipping, payment, an optional
tip, and the order summary beside it. The card box on that page belongs to Square (its "Web Payments SDK"): the card
number goes straight to Square and never touches our site. Until step 2 is done, the page still collects the address
and then sends people to Square's hosted payment page exactly as before (no tip on that route).

1. Open the **Square Developer Console** (developer.squareup.com), pick the same app your access token comes from,
   and open **Credentials**. Copy the **Application ID**. Sandbox and production have different ones: the sandbox one
   starts with `sandbox-sq0idb-`. It isn't secret (every shop using Square's card form shows it in the page).
2. In Cloudflare (Workers > ourjkadventures > Settings > Variables and secrets), add `SQUARE_APPLICATION_ID` with
   the ID that matches `SQUARE_ENV` (sandbox ID while `SQUARE_ENV=sandbox`). Deploy, or wait for the next deploy.
3. Make sure the access token can create orders and take payments (`ORDERS_WRITE` and `PAYMENTS_WRITE`). A personal
   access token from the Developer Console already can; it's the same token checkout uses today.
4. Try it on sandbox: add a pin, check out, fill in the form, and use Square's sandbox test card `4111 1111 1111 1111`,
   any future expiry date, CVV `111`, zip `94103`. You should land on the thank-you page, and the order should show in
   "orders to ship" on `/admin` and in the sandbox Square Dashboard, with the tip on the payment if you picked one.
5. On the live site, once `SQUARE_ENV=production` and the production Application ID are set, place one small real
   order with your own card, then refund it in Square. Check that the receipt and our "thank you for your order"
   email both arrive.
6. **Apple Pay on our own page** needs our web address proven to Apple, because the payment now happens on
   ourjkadventures.com instead of Square's page. In the Developer Console, open the app's **Apple Pay** page, add
   `ourjkadventures.com`, and download the **domain verification file** Square gives you. Send it to us to put on
   the site (it has to live at `/.well-known/apple-developer-merchantid-domain-association`), then press **Verify** in
   the console. Until then the Apple Pay button simply doesn't show; cards and Google Pay still work.
   *Done 2026-11-10:* the file is on the site (`server/apple-pay.js`). Check that
   `https://ourjkadventures.com/.well-known/apple-developer-merchantid-domain-association` shows a long line of
   letters and numbers, then press **Verify**. Add `ourjkadventures.com` only, not www (www moves to the plain address).
   Sandbox has its own Apple Pay page: the same file works there, verify it there too if you test in sandbox.
7. **Google Pay** needs nothing from you: the button shows in Chrome and on Android for people with a card saved.
8. **Tips** show on each payment in the Square Dashboard and in **Reports > Sales summary** under tips. They're the
   buyer's own choice, "no tip" is picked to start with, and they're never taken off anything.
