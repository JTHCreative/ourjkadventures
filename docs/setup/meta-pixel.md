# Meta Pixel setup (owner steps): ads on Instagram and Facebook

The website can tell Meta which visits and orders came from our ads, so Ads Manager can show what's working and
show our pins again to people who've stopped by. Two parts do the same job:

- **The Meta Pixel** is the browser telling Meta. Think of someone with a clipboard at the booth door.
- **The Conversions API** is our own server telling Meta. Think of the till's record of the day. An ad blocker or
  a closed tab can lose the clipboard's note, never the till's.

Each event carries the same ticket number in both, so Meta counts it once.

Both are on for every visitor unless they turn it off. A small note at the bottom of the page says so on a first
visit, with "okay" and "turn it off". "Turn it off", or a browser's "global privacy control" signal, means nothing
goes to Meta. "cookie choices" in the footer brings the note back. Never on `/admin` or the sign-in and account pages.

| Event | When | Browser | Server |
|---|---|---|---|
| PageView | any public page opens | yes | no |
| ViewContent | a pup's page (or a pup on the board) or the bay area board's page opens | yes | yes |
| AddToCart | "add to bag" | yes | yes |
| InitiateCheckout | `/checkout` opens with something in the bag | yes | yes |
| Purchase | the card is charged (server), then the thank-you page (browser) | yes | yes |

The pixel is "JK Adventures Website Pixel". Its number lives in one file, `site/assets/pixel-id.js` (not a secret).
Product ids are our own keys: `aussie`, `aussie:large`, `bay-area-pin-board`. Purchase's value is what was paid for
the order (items, shipping and tax), without the tip. Orders on Square's hosted page (the fallback while the card
form isn't set up) send no Purchase.

## A. The browser's Pixel
Nothing to do: it works as soon as this is deployed.

## B. The server's key (about 5 minutes)
Until this is done only the browser's Pixel runs, which is fine to start with.

1. Open **Meta Events Manager** > **JK Adventures Website Pixel** > **Settings**.
2. Scroll to **Conversions API** and press **Generate access token**. Copy it. Treat it like a password: never
   paste it into the repo, a chat or an email.
3. Give it to Cloudflare, either way:
   - **Dashboard:** Workers & Pages > **ourjkadventures** > **Settings** > **Variables and secrets** > **Add** >
     type **Secret**, name `META_CAPI_TOKEN`, paste the token, **Deploy**.
   - **Command line**, from this folder (it asks for the token, and nothing is saved to a file):
     ```
     npx wrangler secret put META_CAPI_TOKEN
     ```
4. To practise locally, put `META_CAPI_TOKEN=` in `.dev.vars` (gitignored). Careful: a real token sends real events.

## C. Check it works
**The browser, with Meta's Chrome extension (Meta Ads Data Advisor, once called Meta Pixel Helper):**
1. Open the site in a private window. The cookie note shows, and the Helper already shows the pixel and **PageView**.
2. Press **okay** on the cookie note. It goes away and nothing else changes.
3. Open a pup, e.g. `/pup-club/corgi`: **ViewContent**. Press **add to bag**: **AddToCart**. Open `/checkout`:
   **InitiateCheckout**. Each one lists its Event ID.
4. Press **cookie choices** in the footer, then **turn it off**. The page reloads and the Helper shows no pixel.

**Events Manager > Test events:**
1. On the **Test events** tab, type the site's address under "test browser events" and open it. Do the steps above;
   each event shows up within a few seconds, marked **Browser**.
2. For the server's copies: copy the code on that tab (like `TEST12345`) and add it in Cloudflare as a variable named
   `META_TEST_EVENT_CODE` (type **Text**), then deploy. Do the steps again: each event now shows twice, **Browser**
   and **Server**, and Meta marks one **Deduplicated**.
3. For **Purchase**, place a real small order (or use the sandbox with a test card): the server's Purchase arrives when the card
   is charged, the browser's on the thank-you page.
4. **Delete `META_TEST_EVENT_CODE` when done**, or the server's events keep going to the test tab instead of the
   real count.

## Where to look afterwards
The **meta ads** card on `/admin` has shortcuts to these pages: website activity and test events (Events Manager,
opened on our pixel), audiences and campaigns (Ads Manager), and insights (Business Suite). Meta shows totals and
groups to advertise to, never which people visited.

## If something's off
- No events at all: was the note answered "turn it off" earlier (press **cookie choices**, then **okay**)? Is an ad blocker on? (An ad blocker stops the browser's Pixel only.)
- Browser events but no server ones: the secret's name must be exactly `META_CAPI_TOKEN`. Cloudflare's logs
  (the Worker > Logs) say `meta events error` with Meta's reason.
- Changing the pixel: edit `site/assets/pixel-id.js`, and make a new token for the new pixel.
