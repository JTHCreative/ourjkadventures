# Search: what's prepared and waiting (items 7 to 9)

Follow-ups from the search work on 2026-11-05. Each one is ready to finish once the owner decides.

## 7. The two "coming soon" pages

`hometown-series.html` and `chinese-zodiac.html` are one sentence each. Google gives very short pages little
weight, a bit like a shop window with just a "coming soon" sign: people walk past it. Two ways to go:

- **A. Add a short paragraph to each (recommended).** Drafts are below, in our voice. They don't promise a date,
  a number of pins or particular towns, so they stay true until the sets arrive. Edit freely.
- **B. Hide them from Google until the pins exist.** Add `noindex` and take them out of the sitemap. Then they
  can't show up in search at all, which also means nobody finds them early.

### Draft: hometown series

Warm and proud, like telling your best friend about where you're from (owner's direction, 2026-11-05).

> pins for the places that made you. the town you grew up in, the place you call home now, the spot where you
> fell in love, the little corner of the world where your story got written. you know the one!
>
> we're so proud of where we come from, and we bet you are too. so we're making pins for those places, a little
> piece of home to wear on your jacket or hang on your board, so it's always close by.
>
> this set is not in the shop yet. tap "i'm interested!" and we'll know which towns to make first.

### Draft: chinese zodiac

> the zodiac, one pin at a time. find the year you were born, or your mom's, or the whole family's, and keep
> them together on a board.
>
> this set is not in the shop yet. tap "i'm interested!" and we'll let you know when it's here.

The "i'm interested!" lines only fit once those pins are in `products.json` with their switch off on `/admin`.
Until then, the last line can just say "this set is not in the shop yet."

**Questions for the owner:**
1. A or B?
2. Hometown: which towns are first (the earlier feedback mentioned Burlingame)? Naming real towns is what
   people search for ("burlingame enamel pin"), so a list of the first few helps a lot.
3. Zodiac: all twelve animals at once, or a few at a time?
4. Any words you'd change in the drafts?

## 8. A friendly "page not found" page

Drafted: `site/404.html` ("this page wandered off.", with buttons to the shop, the pup club and the pin
boards, and our email). It says `noindex`, so it never shows in search, and it's checked at 360px wide.

Right now a wrong address shows Cloudflare's plain "not found" text, because Cloudflare doesn't know to use
our page yet. Turning it on is one line in `wrangler.jsonc`, under `"assets"`:

```
"not_found_handling": "404-page"
```

Cloudflare then shows `404.html` for any address we don't have, still with the proper "not found" code for
search engines. This changes the hosting setup, so it waits for the owner's OK. Once it's on, check that
`https://ourjkadventures.com/no-such-page` shows the new page and that `/pup-club/not-a-dog` does too.

## 9. Keeping the sitemap's dates honest

Done as a tool: `scripts/sitemap-dates.py` sets each page's "last changed" date from git (a pup page counts
changes to `pup-club.html` and `products.json`).

```
python3 scripts/sitemap-dates.py --check   # says which dates are out of date
python3 scripts/sitemap-dates.py           # fixes them
```

Run it after committing a change to a page, then commit `site/sitemap.xml`. It isn't part of the tests:
the cloud checkouts only keep recent history, so dates read there can be wrong.

**Question for the owner:** is running it by hand enough, or should a GitHub Action (a small robot that runs
on every merge to `main`) do it automatically? The Action is free on GitHub, but it means a bot commits to `main`.
