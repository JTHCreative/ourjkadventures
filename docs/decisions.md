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

## 2026-10-26 The shop stays closed until the owner opens it (replaced 2026-10-31, see below)
`products.json` has a `shop_open` master switch, set to `false`. While it is false every button reads
"coming soon" and is disabled, the bag shows a calm note instead of "check out", and `/api/checkout`
refuses every order (403), even if someone crafts the request by hand. Anything other than
`"shop_open": true` counts as closed, so a missing or mistyped switch fails safe. Every item is also
marked `sold_out: true` as a second lock. The owner flips the switch when Square stock is ready.

## 2026-10-29 Reviews: accounts only, approved first, never filtered by stars
Owner's choices: reviews come from signed-in accounts with a confirmed email (not only verified
buyers, since the shop isn't open yet and booth buyers have no online order), every review waits for
the owner's approval, and the home page features approved 4 and 5 star reviews that have words.
Approval screens for spam, rudeness and private details, never for low ratings: the FTC's consumer
review rule treats suppressing honest negative reviews as deceptive, so every approved rating counts
toward a pin's average and shows on its panel. Approval happens in the Firebase console for now
(no admin page yet). The worker caches approved reviews for 10 minutes because each Firestore query
is billed per document read. Same pattern as accounts: the browser never touches Firestore.

## 2026-10-26 Accounts: the browser never touches Firestore
The browser loads only Firebase's sign-in library (pinned, from Google's own CDN at gstatic.com). It
never reads Firestore. It sends its sign-in ticket to our server at `/api/account`, which checks the
ticket and returns that person's own details. So `firestore.rules` can block every browser outright.
This narrows the earlier spec, which let a signed-in browser read its own `users/{uid}` document.
Why: a smaller page (no Firestore library), one door to lock instead of two, and the rules can't be
gotten subtly wrong. The server checks tickets and talks to Firestore with built-in crypto only, no
npm libraries. Its code lives in `server/` (bundled into the worker by wrangler, never published).
Deleting an account needs a sign-in from the last 5 minutes. Built on the current static site,
before the Astro port, so accounts arrive sooner. Google Analytics from the Firebase snippet was
left out: no tracking without a decision and a cookie notice.

## 2026-10-26 Order history from notes, not a webhook
Square doesn't know which website account placed an order. At checkout, the worker writes a small note
(`users/{uid}/orders/{orderId}`) for signed-in buyers, and the orders page asks Square for those orders,
showing only paid ones whose `metadata.uid` matches. Considered: a Square webhook that records paid
orders (phase 2 plans one). The note approach needs no Square setup and shows Square's current status
each time. Trade-off: orders placed signed out or at the booth don't appear. When the phase 2 webhook
lands it can fill gaps if needed.

## 2026-10-26 Account details
First and last name and phone live in Firestore only; phone is optional and only for reaching someone
about an order. Email lives in Firebase Authentication. Changing it sends a link to the new address and
switches only when that is clicked, so a typo can't lock anyone out; the old address gets Firebase's
"your email was changed" notice. Google sign-ins don't get an email change, since Google owns that email.

## 2026-10-31 An owner's page at /admin, behind the same sign-in as customers
Owner asked to run the shop without editing files. `/admin` uses the existing Firebase sign-in (the
owner's account is a normal account), and the server decides who the owner is: a confirmed email listed
in the `ADMIN_EMAILS` Cloudflare variable. We didn't use a Firebase custom claim (phase 4's planned
`admin` claim) because setting one needs a script and a console trip, and a Cloudflare variable is one
field the owner can change. We didn't give /admin its own separate sign-in either, since the owner asked
for one account. The page only displays; every action goes through `/api/admin`, which re-checks the
ticket and the list on each request, so finding the URL gets nobody anywhere. It isn't in any menu: the
owner's account page shows a "shop settings" card when `/api/account` says `admin: true`. Firebase stays
on the account pages only, as before. Review approval moved from the Firebase console to this page,
still for spam, rudeness and private details, never for low ratings. A hidden review's writer is told
it wasn't posted rather than left "waiting" forever.

## 2026-10-31 The shop's open sign moves from products.json to Firestore
Replaces the 2026-10-26 `shop_open` switch in `products.json`. Now `settings/shop { open }` in Firestore,
flipped on `/admin`, read only by the server with the service account. Fails safe the same way: no
document, anything but `true`, or Firestore unreachable means closed. Cached a minute per worker copy
(retry after 10 seconds when a read fails), so a change reaches every visitor within about a minute
without a Firestore read per page view. While closed, every product reads "coming soon" (the owner said
"sold out"; the existing "coming soon" wording was kept because it is calmer and was the earlier choice)
and no stock counts show.

## 2026-10-31 Square is the shelf: prices and stock from Square, linked on /admin
Owner's choice: once the shop is open, the site tracks Square's stock, shows "sold out" at 0 and the count
otherwise. Prices come from Square too, so `price_cents` and `sold_out` left `products.json`; it now says
only what the site shows and which sizes a product can come in. Square only had four items (standard and
large aussie and pomeranian), named in Square's own style, so instead of matching by SKU or name (the
earlier plan was SKU = slug and a sync script) the owner picks the Square item for each website product
and size from a dropdown on `/admin`. Links are stored per Square environment (`settings/square_sandbox`,
`settings/square_production`), so practice links never touch the real shop. One Square item can back
only one website key, or its stock would be shown twice.

Sizes: the owner chose one card per dog with a standard / large choice, not separate large products, so
the pup board stays one dog per spot. A size shows only when it is linked. Names and descriptions: the
owner chose to keep the site's own lowercase wording and take only price and stock from Square, because
Square's text is title case with a sales tone. Square's names still appear on Square's payment page.

The stock count is shown as a plain fact, "48 in stock.", the same words at any number, never "only 3
left" (brand voice: no urgency). Checkout now sends `catalog_object_id` instead of a typed name and price,
which is what makes Square lower the count on a web sale (before this, web sales never touched Square
stock), and it checks the shelf fresh rather than trusting the one-minute catalog. Square's "sold out"
tick wins over any count. Tax still comes from `TAX_PERCENT`, not Square's per-item tax, to avoid
charging it twice. If Square can't be reached, everything shows as sold out.

## 2026-10-31 Large pins only for the aussie and the pomeranian
Owner: only the aussie and pomeranian come in a large size, a limited edition. Every other pup is standard
only, so `products.json` lists `["standard", "large"]` for those two and `["standard"]` for the rest, and
`/admin` no longer offers large rows nobody will fill. The site doesn't call the large pins "limited" to
customers: that reads as urgency, which the brand voice avoids. On `/admin`, the product groups fold open
and shut, each heading showing how many of its products are linked.

## 2026-11 The reel door is plain JavaScript, stacked by z-index
The spec says to use whatever the site already uses, and the site is plain HTML/JS with no build step,
so the reel door is one file (`assets/reel-door.js`) that any page can switch on with
`<div data-reel-door>`. Its motion runs off one number (the ring angle) in plain variables and writes
each reel's position straight to its style, so nothing is rebuilt per frame. Reels are layered by
z-index (closest to the front on top), not real 3D depth, because two cards in shared 3D space slice
through each other as they pass. When the Astro port happens, this file can be an island as-is.
Instagram's own embed was kept only as a fallback: it can't be styled, and its iframe swallows drags.

## 2026-11 Reel door on the About page, full screen in the page, not the browser's
The owner moved the reel door from the home page to the About page and asked for smaller reels, full
screen on tap, and no arrows on phones. Full screen is a cover over the page (a modal `<dialog>`, with a
close button at the top and Escape to close), not the browser's own fullscreen mode, because iPhones don't
allow that for anything but a bare video, and the cover keeps our caption and buttons. The spec's minimum
reel width (160px) gave way to "front reel and both neighbours always fit": reels are now 120 to 200px wide.

## 2026-11 Instagram reels: key in Workers KV, sign-in finished on /admin
The Instagram key lives in Workers KV, not a Cloudflare secret, because the worker has to replace it every
week and a worker can't change its own secrets. KV is free at this size (see `setup/instagram.md`). The
sign-in comes back to `/api/admin/instagram/callback`, which can't carry the owner's ticket (it's a plain
redirect from Instagram), so it does nothing but forward the one-time code to `/admin`. The signed-in owner's
page then sends it to `/api/admin/instagram/finish`, which checks the ticket and `ADMIN_EMAILS` like every
other owner request, plus a one-time "state" tied to the owner who pressed connect. The KV binding stays a
comment in `wrangler.jsonc` until the owner creates the namespace, because a made-up ID breaks deploys.
With only two reels the ring shows each twice: a two-reel ring puts one directly behind the other and the
turn swings them off the screen. One reel shows on its own with no controls.

## 2026-11 Instagram: Unified Login, not Instagram Login (supersedes the weekly renewal above)
When the owner created the Meta app, the dashboard only offered "API setup with Unified login" (and the
Facebook-login setup, which needs a Facebook Page). Meta's docs call Unified Login the recommended setup and
the only one getting new features. It signs in through Facebook Login for Business with a configuration
(`INSTAGRAM_CONFIG_ID`), exchanges the code at `graph.facebook.com` with the *Meta* app ID and secret, and
gives a key that belongs to the business portfolio and, by default, doesn't expire. So the weekly renewal
job and its cron trigger were removed. The website finds the Instagram account through
`/me/assigned_instagram_accounts` and reads `/{instagram id}/media`. If Meta stops accepting the key (error
190), it is marked once and not retried, the last saved reels keep showing, and `/admin` asks to connect
again. Meta requires `instagram_manage_messages` in every Unified Login configuration; the website never
uses it, and the key never leaves the worker.

## 2026-11 Instagram account ID kept in wrangler.jsonc
With Unified Login, Meta's key for our app covered `instagram_basic` for "all" accounts, so neither
`/me/assigned_instagram_accounts` (empty) nor `debug_token` (no target IDs) named @ourjkadventures, and the
business portfolio's account lists need `business_management`. Rather than ask for that much broader
permission, the account's ID (shown on Meta's sign-in screen, not secret) is a plain variable,
`INSTAGRAM_ACCOUNT_ID`, in `wrangler.jsonc`. Connecting checks the key can read that account and stores the ID
Meta returns. The other lookups stay as fallbacks.

## 2026-11 Instagram: a system-user key from our own business settings
The Unified Login sign-in connected on Meta's side, but its key could not open @ourjkadventures: the
assigned-accounts list was empty, `debug_token` showed `instagram_basic` for "all" with no account IDs, the
portfolio's account lists needed `business_management`, and reading the account by ID gave "(#10)
Application does not have permission for this action". Meta's Facebook Login for Business docs explain why:
business integration system user keys are for Tech Providers, and the app's business portfolio must be
"separate from the business portfolio owned by your business client". Ours are the same portfolio.
So the website now uses a system user key made in our own Business settings (Employee role, only the
Instagram account and the app assigned, only `instagram_basic`, never expires), kept as the Cloudflare
secret `INSTAGRAM_ACCESS_TOKEN`. When that secret is set, `/admin` shows a live check instead of the connect
button. The sign-in code stays for now but isn't needed. A failed fetch is re-tried after 30 minutes, not
on every visit, and `/admin` shows Meta's reason.

## 2026-11 Instagram through the Facebook Page, asked for by ID
A system user key reaches an Instagram account through its linked Facebook Page, so the owner created the
J+K Adventures Page and linked @ourjkadventures to it. Even with the `website` system user assigned (Content
on the Instagram account) and a key holding `instagram_basic`, `pages_show_list` and `pages_read_engagement`,
Meta left the Page out of `/me/accounts`. So the Page's ID (not secret) is `INSTAGRAM_PAGE_ID` in
`wrangler.jsonc`, and the website asks `/{page id}?fields=instagram_business_account` directly.
`INSTAGRAM_ACCOUNT_ID` was removed: `1323062497557751` turned out to be the portfolio's label for the account
(no `media` field), not the Instagram account.

## 2026-11 Instagram clean-up: one way in
With the system-user key working through the Facebook Page, the Unified Login sign-in (`/admin` connect
button, start/finish/disconnect routes, `/api/admin/instagram/callback`, the key swap and the key in KV) and
the lookups that never found our account (assigned accounts, `debug_token` targets, the portfolio's account
lists, `INSTAGRAM_ACCOUNT_ID`) were removed. The website finds @ourjkadventures by asking for
`INSTAGRAM_PAGE_ID`, with the key's own Page list as a fallback. KV now holds only the saved reels. Earlier
entries describe the attempts that led here.

## 2026-11 Reels with licensed music open in Instagram's own player
Meta leaves `media_url` (the video file) out for any reel with licensed or library music, so there's nothing for
us to mute or play. The owner chose: those reels show their cover with a play mark in the ring, and full screen
loads Instagram's embed (`https://www.instagram.com/reel/<code>/embed/`, built only from a real instagram.com
reel or post link) in an iframe. It loads only when opened, and is removed on close, so the ring stays draggable
and Instagram's content (and cookies) stay off the page until asked for. No embed script, just the iframe. The
privacy page says so. Reels with original sound keep playing in our own player. Going forward, original sound
is the way to have a reel play in the site's own design.

## 2026-11 Licensed-music reels: ask, then open on Instagram (replaces the embedded player)
Instagram's embedded player showed only "Watch on Instagram" for reels with licensed music: it won't play them on
other sites either. So the iframe was removed. Those reels keep their cover and play mark in the ring; a tap on the
front one (never a swipe) asks "watch on instagram?" with "watch on instagram" (opens the reel in a new tab) and
"stay here" (focused, so a stray Enter stays). The link is only ever built from a real instagram.com reel or post
link. Nothing loads from Instagram on our pages, so the privacy page's sentence about Instagram's player was taken
out again.


## 2026-11 3D pin models are slimmed before they go on the site
The models are plain shapes (no pictures wrapped on them), and each was 2.7 to 5.4 MB, sent to the browser at
full size. Each one now goes through two steps with gltf-transform (a free command-line tool, used only on our
side, nothing new loads in the browser):

```
npx @gltf-transform/cli@4.1.1 quantize --pattern "NORMAL" in.glb tmp.glb
npx @gltf-transform/cli@4.1.1 weld tmp.glb out.glb
```

`quantize --pattern "NORMAL"` stores the lighting directions with less precision; `weld` merges duplicate points.
Together they took the ten models from 38.9 MB to 17.1 MB, and side-by-side renders differ in under 1% of pixels.
Rounding the positions too (plain `quantize`) was tried and rejected: the enamel layers sit so close together
that the pins came out shifted or scrambled. Stronger compression (meshopt or Draco) was skipped because the
browser would need a decoder from Google's servers. When models are redone, bump `?v=` in `MODEL_3D` in
`app.js`, since `/assets/3d/` is cached as never changing.


## 2026-11 The shop's featured carousel: the owner picks, the server checks stock
The shop page opens with a carousel of up to eight products the owner picks on `/admin`. The picks live in
Firestore at `settings/featured_production` (or `settings/featured_sandbox` while testing, so practising never
changes the real shop), stored as one line, `"corgi,aussie"`, because our Firestore helper has no lists and
slugs never hold commas. Rules:

- **Only in stock.** `/api/admin/featured` refuses a new pick unless Square shows stock right now. A pick that
  sells out later may stay picked: `/api/catalog` leaves it out of the carousel until it is restocked, so the
  owner doesn't have to come back and re-pick it. If Square can't be read, nothing is saved.
- **Shown while the shop is closed too.** It is a window display: only slugs go to the browser, never stock
  numbers, and each product's own page still says "coming soon".
- **Motion.** It turns slowly (one turn in 40 s), rests while a mouse is over it or a pin has keyboard focus,
  and has a pause button (moving content needs one). A drag or flick spins it faster and it drifts back to
  cruise. Under `prefers-reduced-motion` it starts paused and only moves when dragged or stepped, with no
  coasting. One or two picks are repeated round the ring (six spots) so it still turns; the repeats are
  skipped by the keyboard and screen readers. (First version stood one or two picks still, side by side,
  which read as a banner rather than a carousel.)
- Its own file, `assets/featured.js`, like the reel door, rather than growing `app.js`.


## 2026-11 "i'm interested": one vote each, without asking people to sign in
Products the owner switches to not available on `/admin` show an "i'm interested" button, and the counts are
public. The owner asked whether votes could be held to one per person by IP address. An IP address alone
doesn't work well: a household, an office, or a craft fair's wifi all share one, so "one vote per IP" would
let only one person at a booth vote. And a phone moving between wifi and mobile data gets a new one. So two
checks together:

- **A ticket per browser.** The first tap sets `jka_voter`, a random id in an HttpOnly cookie that's only sent
  to `/api/interest`. One vote per pin per ticket, enforced by a vote record the server creates with a
  "must not exist yet" condition, in the same Firestore commit as the tally. Clearing cookies or a private
  window gets a new ticket, which is where the second check comes in.
- **A daily cap per connection.** At most 10 votes per pin per day from one IP address. That's enough for a
  family or a booth crowd, and it stops one person from clearing cookies 200 times. Taps over the cap are
  told calmly that they weren't added.
- **Nothing stored as it is.** Both the ticket and the IP are scrambled with an HMAC keyed from the Firebase
  service account, and the IP is mixed with the day, so records can't be matched across days or turned back
  into an address. Explained on the privacy page.
- **Considered and left out:** requiring sign-in (one vote per account is airtight, but most people won't make
  an account to say "i'd like a corgi pin"), and Cloudflare Turnstile, a bot check (a new third-party script;
  worth adding if the counts ever look gamed). The counts are a guide for what to make next, not money, so
  "good enough to be honest" beats "impossible to cheat".
- **Practice stays separate.** Switches and tallies follow the Square mode, like the featured picks, so taps
  in the sandbox never touch the real counts.
- **Not a reservation.** Nothing is held or charged. It's a show of hands. A product switched off is off sale
  even if it's linked and in stock, so a pin can be stocked in Square before it's announced.
- **Taking it back (added the same day).** The owner asked for a second tap to undo the vote. It removes that
  browser's vote and takes one off the tally and off the day's door count it was added to, all in one step.
  Only the ticket that cast a vote can take it back, so nobody can lower someone else's count.


## 2026-11 "email me when it's here": Resend, confirm first, the owner presses send
The site had no way to send email (Cloudflare Email Routing only receives). The owner chose **Resend's free
plan** (3,000 a month, 100 a day) over Cloudflare Email Sending (beta, and needs the $5/month Workers Paid
plan to email customers). Gmail was ruled out: about 500 a day, hard to reach from a Worker, and bulk mail
from a personal account lands in spam. `server/email.js` is the only file that knows about Resend, so
switching later means changing that one file.

- **No confirm email (changed the same day).** The first version sent "is this you?" with a link to click
  first. The owner found that one step too many, so an address now goes on the list at once and nothing is
  sent until the pin arrives. A website can't prove an address belongs to the person typing it without sending
  something, so instead it checks what it can on the spot: it looks like an email, the browser offers
  "did you mean ...@gmail.com?" for common slips, and the server asks Cloudflare's public DNS whether the domain
  takes mail (if DNS can't be asked, the sign-up goes through). What's left: someone could put down a friend's
  address. The friend gets one "it's here" email, which says "if you didn't ask for this" beside the stop
  link. Catching typos upfront also keeps the bounce rate low, which keeps the Resend account in good standing.
- **Anyone, not just accounts.** No sign-in needed, since most people won't make an account for this.
- **The owner presses send.** Flipping a product's switch never emails anyone, so testing a switch can't
  reach real people. Send is refused unless the product is available and the shop is open, so "it's in the
  shop now" is true when it lands. Each person gets one email per product, then comes off that list.
- **Our own daily count.** The site counts what it sends and stops at 100 a day, so a long list goes out over
  several days (press send again) instead of failing partway. A batch send carries an idempotency key, so
  pressing twice after a hiccup can't double-send.
- **Keeping it from being misused.** 5 sign-ups a day per connection, sign-ups only for products that aren't
  available, and nothing sent at sign-up, so the form can't be used to send email to anyone.
- **Stopping.** Every "it's here" email has a stop link and `List-Unsubscribe` headers for mail apps' own
  button. The stop link is signed (HMAC), so it needs nothing stored, and it removes the address from every
  list. Addresses are kept only while someone is waiting, and are explained on the privacy page.
- **The email itself (changed the same day).** The owner wanted the logo, the pin's picture, and wording that's
  casual and excited, since it's good news. It's now "it's here!" with the pin's picture and a "go see the
  corgi" button, exclamation marks allowed here (noted in `brand-voice.md`), still lowercase and no urgency.
  Pictures are PNG copies (`site/assets/img/email/`, made by `scripts/email-pictures.py`) because Gmail and
  others don't show SVG or WebP, linked by web address rather than attached: Resend doesn't allow attachments
  in a batch, and attachments make an email heavier and more likely to be filtered.


## 2026-11 Guest reviews
The owner wanted people without an account to leave reviews too. A guest gives a name and an email, and the
review waits for approval on `/admin` like every other, so nothing goes up unread.

- **One per email per pin, no editing.** Without a sign-in there's no way to prove a later edit comes from the
  same person, so a guest review can't be changed or removed from the page. They write to support@, and
  making an account (below) gives them the usual edit and remove.
- **The email is private.** It's kept with the review, never shown, and used only to reach them about it and to
  move it into their account later. Same on-the-spot checks as the "email me" list (typo hint, the domain
  must take mail), at most 5 guest reviews a day from one connection, and no email is sent.
- **"create an account with us too".** Ticking it saves the review, then opens the create-account page with the
  name and email filled in (handed over in sessionStorage, which stays in that tab and out of the address
  bar and history). Firebase sends its usual confirm link.
- **Joining the account only with a confirmed email.** Guest reviews move into an account the first time it
  signs in with that email confirmed. Before confirming, anyone could type someone else's address into the
  create form, so an unconfirmed account takes nothing. If the account already reviewed that pin, the account's
  review stays and the guest copy is dropped.
- **Names as typed.** Guests' names show as first name and last initial, with their capitals as typed, the same
  as account names.


## 2026-11 A homier voice, and exclamation marks in friendly text
The owner rewrote the about page as their own story ("we're justin and kitty, the j and k behind j+k
adventures!") and asked for the whole brand voice to move the same way: casual, homey and conversational,
not cold and poetic. The old voice leaned on short, moody lines ("inside. out.", "a little flag that says,
this one is mine."), which read well but kept people at a distance. The about page now holds only the new
story, and the pull quote is gone.

- **Exclamation marks** are now allowed where a person would use one: story paragraphs, personal notes,
  thank-yous and small details. They stay out of big headings and page titles, are never stacked, and are
  never used for sales pressure. The no-discount and no-urgency rules are unchanged.
- **Existing copy elsewhere** was not rewritten in this change. Pages get the new voice as they are touched.


## 2026-11 Pin models made from the artwork SVG
The owner sent new german shepherd art as a PNG and an SVG, with the gold drawn in red: red fills (the rim, eye rings,
mouth line) and red outlines (around ears, face, mask and nose). `scripts/svg-to-pin.py` turns that SVG into a model
built like the existing ones: gold back plate and plating, one glossy enamel layer per coloured shape in drawing
order, raised gold lines, a taller gold rim, and the post and rubber clutch copied from the corgi model. The pin is
38.33 mm tall like every other one.

- **Red means gold.** It's the owner's convention for marking metal in the artwork, so any SVG drawn the same way
  can become a model without hand work.
- **Small steps between layers.** Each enamel sits 0.008 mm above the one before, so overlapping colours (the nose
  shine on the nose) don't flicker in the viewer. 0.003 mm was tried first and speckled from a distance.
- **The tools (shapely, mapbox-earcut, svgelements) run only on our side**, like gltf-transform. Nothing new loads
  on the site. After the usual two slimming steps the new model is 874 KB, down from 2.2 MB.
- `?v=` in `MODEL_3D` went to 3 so browsers fetch the new file.


## 2026-11 Reels on backing cards
The owner updated the reel door spec (`docs/reel-door-spec.md`): each reel now hangs on a card like the pin
backing cards (parchment, 3px ink border, a hang slot, the video in an inset window, the handle and caption
printed underneath, like/comment/share circles on the video) with a warm shadow that grows as a card lifts or
swaps. The motion, controls and Instagram parts didn't change.

- **Laid out at its printed size, then scaled.** The card is built at the spec's 212 x 436 px, with every
  measurement straight from the spec, and `reel-door.js` scales the whole card to the stage (and up to fill the
  screen in full-screen view). That keeps the card's proportions exact at any width. The cost: on a 360px phone the
  card is about 160px wide, so its printed text is drawn smaller than 14px there, the same as a real card in a photo.
- **Like, comment and share are printed on, not buttons.** We can't like or comment from our site, so they're
  decoration; a tap on them opens the reel like the rest of the picture. Play and sound stay real buttons.
- **The shadow is worked out each frame** (`cardShadow` in `reel-door.js`, tested), from a light up and to the
  left, so it falls slightly right, grows with lift and swap, and fades toward the back.

