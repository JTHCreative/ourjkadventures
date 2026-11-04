# Email setup (owner steps): "email me when it's here"

The website sends email through **Resend** (resend.com). Think of Resend as the website's post office:
Cloudflare Email Routing only *receives* mail for support@ and forwards it to Gmail, so anything the site
*sends* goes out through Resend. The free plan covers 3,000 emails a month, at most 100 a day. The site
counts its own emails and stops at 100 a day by itself.

Until step 6 is done, the line under a tapped "i'm interested!" just says "thank you!", with no email box.

## A. Make the account and add the domain (about 15 minutes)
1. Go to resend.com and sign up with ourjkadventures@gmail.com. Choose the **Free** plan.
2. In Resend, open **Domains** > **Add domain**. Type `ourjkadventures.com`. If it asks for a region,
   pick the one nearest you (for example North Virginia, `us-east-1`).
3. Resend shows a few DNS records (the domain's address book entries). If it offers **Sign in to Cloudflare** /
   **Auto configure**, use it and approve. Otherwise add each record by hand in Cloudflare:
   Cloudflare > `ourjkadventures.com` > **DNS** > **Records** > **Add record**, copying the type, name and
   value exactly. Set **Proxy status** to **DNS only** (grey cloud) for each one.
   - These records live on `send.ourjkadventures.com` and `resend._domainkey.ourjkadventures.com`. They do **not**
     replace the existing records for support@ forwarding (Email Routing). If anything asks you to change or
     delete an existing **MX** record on `ourjkadventures.com` itself, stop and ask first.
4. Back in Resend, press **Verify DNS records**. It can take a few minutes, sometimes an hour. Wait until the
   domain says **Verified**.

## B. Give the website its key
5. In Resend, open **API Keys** > **Create API key**. Name it `ourjkadventures website`, permission
   **Sending access**, domain `ourjkadventures.com`. Copy the key (it starts with `re_`). You only see it once.
   Treat it like a house key: never email it, commit it or paste it into a chat.
6. Cloudflare > **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**:
   type **Secret**, name `RESEND_API_KEY`, value the key. Save, then press **Deploy**.
   - Optional: `EMAIL_FROM` (Text) if you want emails from another address, e.g.
     `j+k adventures <hello@ourjkadventures.com>`. The default is `j+k adventures <support@ourjkadventures.com>`.
     Replies always go to support@.
   - Optional: `EMAIL_DAILY_LIMIT` (Text) if you move to a paid Resend plan. Default `100`.

## C. Check it works
7. Open `/admin`. The **email when it's here** card should say "today: 0 of 100 emails sent." instead of
   "email isn't set up yet".
8. Pick a pin that is switched off (not available), open it in the shop and tap **i'm interested!**. Under the
   button it says "thank you! be notified when it's available:". Enter your own email and press **notify me**. You should get "is this you? the ... pin." within a minute. Check spam too.
   If it landed in spam, mark it "not spam".
9. Click the link in it and press **yes, email me**. On `/admin` the card should show "1 person waiting."
10. To try the "it's here" email: switch that pin on, make sure the shop is open, and press
    **send "it's here" to 1**. You should get "the ... pin is here." Then switch the pin back off if it
    isn't really here yet.
11. In that email, try the stop link at the bottom: it should say "done." Tell Claude Code if your mail app
    also showed its own **unsubscribe** button at the top of the email (it should, from the email's
    unsubscribe headers).

## Day to day
- When a pin arrives: on `/admin`, switch it on, open the shop if it's closed, then in **email when it's here**
  press **send**. You'll be asked to confirm first. Everyone confirmed gets one email and comes off the list.
- More than 100 waiting: the first press sends what today allows. Press send again the next day for the rest.
  The day's count starts again at midnight UTC (4 or 5 pm in California).
- People who never clicked their confirm link are never emailed. They show as "not confirmed yet".
- Someone asks to be taken off: their stop link does it. Or ask Claude Code to remove the address.

## If something goes wrong
- `/admin` still says "email isn't set up yet": the secret's name must be exactly `RESEND_API_KEY`, and you
  need to press **Deploy** after adding it.
- "that didn't send" on `/admin`: open Resend > **Logs** to see why. Often the domain isn't verified yet.
- Emails land in spam: wait a day after verifying (new domains start out cautious), and make sure the three
  Resend records show as verified.
