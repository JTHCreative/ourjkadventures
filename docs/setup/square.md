# Square setup (owner steps)

## Phase 0: checkout
1. Create a Square account at squareup.com. Finish business details and add the bank account for payouts.
2. Go to **developer.squareup.com** > **Apps** > **+** and create an app, e.g. "jk adventures site".
3. Open the app > **Credentials**. Toggle **Sandbox**. Copy:
   - Sandbox **Access token** → Cloudflare `SQUARE_ACCESS_TOKEN`
   - **Locations** (left menu) > sandbox location ID → `SQUARE_LOCATION_ID`
   - Set `SQUARE_ENV` = `sandbox`
4. Test: add a pin, check out, pay with card `4111 1111 1111 1111`, any future date, any CVV and zip.
   The order appears in the sandbox **Seller Dashboard** (launch it from the developer console).
5. Going live: toggle **Production**, copy the production token and your real location ID into Cloudflare,
   set `SQUARE_ENV` = `production`, redeploy. Then make one real $12 purchase and refund it.

## Before launch, decide
- **Shipping**: the site sends a flat fee from `products.json` (`shipping_cents`). It's set to $5 as a placeholder.
- **Sales tax**: `TAX_PERCENT` in Cloudflare. Check your rate with the CDTFA or an accountant. Not tax advice.

## Phase 2: catalog, stock, webhook (do when Claude Code reaches phase 2)
1. Claude Code will give you a script that adds every pin to your Square item library. Run it once against sandbox, then production.
2. In Square Dashboard > Items, turn on **stock tracking** for the pins and enter counts.
3. Use the same items on the Square Reader at the booth. Booth and web then share stock.
4. Developer console > your app > **Webhooks** > **Add subscription**:
   - URL: `https://yourdomain.com/api/square-webhook`
   - Events: `order.updated`, `payment.updated`
   - Copy the **Signature key** → Cloudflare secret `SQUARE_WEBHOOK_SIGNATURE_KEY`
   - Put the exact URL in Cloudflare `SQUARE_WEBHOOK_URL`
