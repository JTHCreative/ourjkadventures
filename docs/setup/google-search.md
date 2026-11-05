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
6. In the left menu open **Sitemaps**. Type `sitemap.xml` and click **Submit**. Status should read
   **Success** within a day or so, with about 10 pages discovered.
7. Optional check: open **URL inspection**, paste `https://ourjkadventures.com/pup-club`, then
   **Test live URL**. It should say the page can be indexed.

Pages showing up in results usually takes a few days to a few weeks. Under **Pages** you will see some
listed as "excluded by noindex" (account, sign-in, thank-you and so on). That is on purpose.

## When you add a page
Add it to `site/sitemap.xml` (the test `tests/sitemap.test.mjs` fails until you do). Nothing needs
resubmitting: Google rereads the sitemap by itself.
