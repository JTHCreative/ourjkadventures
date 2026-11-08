# Google Search: tell Google about the site

The site has a map of its public pages at `https://ourjkadventures.com/sitemap.xml`, and `robots.txt`
points to it. Google would find it on its own eventually; these steps make it happen sooner and show you
how the site is doing in search. Think of the sitemap as the store directory by the mall entrance:
Search Console is how you hand Google a copy.

1. Go to <https://search.google.com/search-console> and sign in with the Google account you want to own it.
2. Click **Add property** and choose **Domain**. Type `ourjkadventures.com` (no `https://`, no `www`).
3. Google shows a **TXT record** (a line starting `google-site-verification=`). Copy it.
4. In the Cloudflare dashboard, open the `ourjkadventures.com` zone, then **DNS**, then **Records**, then
   **Add record**. Type `TXT`, name `@`, content: paste the line. Save.
5. Back in Search Console, click **Verify**. If it says not yet, wait ten minutes and try again.
6. In the left menu open **Sitemaps**. Type the full address, `https://ourjkadventures.com/sitemap.xml`, and
   click **Submit**. (A Domain property needs the whole address with `https://`; if the box already shows
   `https://ourjkadventures.com/` in front, just `sitemap.xml` is enough.) Status should read
   **Success** within a day or so, with about 26 pages discovered (ten pages plus one per pup).
7. Optional check: open **URL inspection**, paste `https://ourjkadventures.com/pup-club`, then
   **Test live URL**. It should say the page can be indexed.

Pages showing up in results usually takes a few days to a few weeks. Under **Pages** you will see some
listed as "excluded by noindex" (account, sign-in, thank-you and so on). That is on purpose.

## Pup pages: check the price card
Each pup club pin has its own page, like `https://ourjkadventures.com/pup-club/corgi`. Hidden in it is a
small card for Google with the pin's name, picture, price and whether it's in stock, like the label on a jar
at a market stall. The website writes the price from Square each time, so it's always the real one.
It only says the pin is for sale while the shop is open and the pin is switched on and linked on `/admin`.

1. Make sure the shop is open on `/admin` and a pup, say the aussie, is linked and switched on.
2. Go to <https://search.google.com/test/rich-results>.
3. Paste `https://ourjkadventures.com/pup-club/aussie` and click **Test URL**.
4. It should find **Product snippets** (and maybe **Merchant listings**) with the aussie's price, and
   **Breadcrumbs** (home › shop › pup club › aussie). Warnings about `shippingDetails` or
   `hasMerchantReturnPolicy` are fine for now: they are nice-to-haves. Red **errors** are not: send a screenshot.
5. Try a pup that isn't linked, or close the shop and test again. If the pup has approved reviews, the card is
   still found, with its stars but no price. If it has no reviews yet, only **Breadcrumbs** is found and no
   product card at all. Both are on purpose: Google won't accept a product card with no price, reviews or stars,
   so we leave it out rather than send a half-empty one.

## Shared links: check the preview
When someone sends a link to the site in Messages, Instagram or Facebook, the app shows a picture and a title
with it, like the cover of a book. Each page names its own (a pup page shows that pup).

1. Go to <https://www.opengraph.xyz> and paste `https://ourjkadventures.com/pup-club/corgi`.
2. The previews should show the corgi pin, "corgi dog enamel pin. j+k adventures" and its description.
3. Try `https://ourjkadventures.com/` too: the bay area board with four pups beside it.

Apps remember a preview for a while, so after a change a link you already shared may show the old one.

Prices in search results can take a few weeks to show, and Google decides when to show them.

## When you add a page
Add it to `site/sitemap.xml` (the test `tests/sitemap.test.mjs` fails until you do). Nothing needs
resubmitting: Google rereads the sitemap by itself.

## When a pin is renamed
The old page address forwards to the new one for good (a "301"), which tells Google to move its listing over, so
nothing needs doing. To speed it up, open **URL inspection** in Search Console, paste the new address (for the
doodle, `https://ourjkadventures.com/pup-club/doodle`) and press **request indexing**.

## If a page says "soft 404" or "not available to Google"
In URL Inspection, click **Test live URL**, then **View tested page**, **More info**, **Page resources**. If it
lists something "blocked by robots.txt", Google couldn't load part of the page. `site/robots.txt` decides what
Google may read; the public lists the pages draw from (`/api/catalog`, `/api/reviews`, `/api/reels`) are allowed
on purpose. After a fix goes live, test again and click **Request indexing**.
