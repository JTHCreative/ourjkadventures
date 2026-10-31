# CLAUDE.md

Guidance for Claude Code working in this repo. Read this first, then the doc that matches the task.

## What this is
The website and shop for **j+k adventures**, a small enamel pin business (Pup Club dog pins, upcoming
Hometown Series and Chinese Zodiac, and display boards such as the Bay Area pin board). Sold online
and at craft fairs. One owner, not a full-time developer. Explain choices in plain language, and use
an everyday analogy when a concept is technical.

## Where things are
| Path | What it is |
|---|---|
| `site/` | The live static site. Plain HTML, CSS and JS, no build step. A Cloudflare Worker with static assets serves this folder (`wrangler.jsonc`), deployed from `main` |
| `site/assets/app.js` | Bag, pup board, size choice and stock line, speech bubbles, 3D viewer, checkout call |
| `site/assets/styles.css` | All styles. Design tokens are the CSS variables on `:root` |
| `site/products.json` | What the site shows: slug, name, kind, `series` for pins (`pup-club`, `hometown`, `zodiac`), which sizes a product comes in, shipping. **No prices**: those come from Square |
| `site/_worker.js` | Server side (the Worker). `/api/catalog` (products with Square price and stock), `/api/checkout` (Square payment link), `/api/account`, `/api/reviews`, `/api/admin`; everything else falls through to static files |
| `server/` | Server code the worker imports: Firebase tickets and Firestore (`firebase.js`), accounts, reviews, the shop switch (`shop.js`), Square reads (`square.js`), the catalog (`catalog.js`), the owner's API (`admin.js`). Bundled by wrangler, never published |
| `site/admin.html`, `site/assets/admin.js` | The owner's page at `/admin`: shop open switch, Square links, review approval. Not linked from any nav |
| `site/assets/account.js` | Firebase sign-in in the browser; runs the account pages |
| `firestore.rules` | Firestore rules: no browser access at all, including `settings/*`. The owner publishes them in the Firebase console |
| `tests/` | `node --test tests/*.test.mjs` |
| `site/assets/3d/*.glb` | 3D pin models, one per slug, shown with Google model-viewer |
| `docs/architecture.md` | How it works now and the target shape |
| `docs/roadmap.md` | The phases, in order, with "done when" checks. **Work from this.** |
| `docs/decisions.md` | Why things are the way they are. Add an entry when you make a real decision |
| `docs/brand-voice.md` | Copy and design rules. Read before writing any words a customer sees |
| `docs/collectors-path-spec.md` | Technical spec for accounts, charges and registration codes |
| `docs/manifesto.md`, `docs/pricing-and-loyalty.md` | The owner's source documents. Do not edit them |
| `docs/setup/` | Owner-facing setup steps for Square, Firebase, Cloudflare |

## Hard rules
- **Never put secrets in the repo or in browser code.** Square tokens, Firebase service account keys and webhook signature keys live in Cloudflare variables/secrets. Local values go in `.dev.vars` (gitignored). `.dev.vars.example` lists the names.
- **Prices are decided on the server.** The browser sends keys (`aussie`, `aussie:large`) and quantities only. Prices come from Square; checkout sends Square item IDs. Never trust a price, total or charge count that came from the browser.
- **Only the server decides who the owner is.** Every `/api/admin` request checks the Firebase ticket and `ADMIN_EMAILS` (confirmed email only). Never gate owner features in the browser alone.
- **The shop fails closed.** If the open sign (`settings/shop`) or Square can't be read, nothing is for sale.
- **Charges (loyalty) are only ever written by the server.** Firestore rules must block client writes to charges, rewards and codes.
- **No discounts, ever.** No sale prices, promo codes, percent-off or "was $X" UI. Rewards add something, never subtract. See `docs/pricing-and-loyalty.md`. If a request would create a discount, stop and flag it to the owner.
- **Keep it working at every commit.** Small commits, one concern each. Run the checks below before saying something is done.
- **Ask before** adding a paid service, a new third-party dependency with a runtime footprint, or changing the hosting setup.

## Voice and design (short version, full rules in `docs/brand-voice.md`)
- All customer-facing copy is lowercase. No exclamation marks. No sales or urgency language ("hurry", "deal", "limited time", "obsessed", "cute!!").
- Warm and sincere, like a friend who loves the thing. Short sentences that end in a period.
- Use the tokens in `styles.css` (`--surface`, `--ink`, `--accent`, `--space-*`, `--radius-*`). Do not hardcode new colors.
- Font is EB Garamond. Accessible by default: labels on icon buttons, visible focus, `prefers-reduced-motion` respected, works at 360px wide.

## Product facts
- Slugs (bag keys add `:large` for the large size): aussie, beagle, cavalier, corgi, dachshund, french-bulldog, german-shepherd, golden, husky, pit-bull, pomeranian, poodle, pug, rottweiler, shiba, yorkie, bay-area-pin-board.
- The golden retriever pin is displayed as **"goldie"**.
- Hover bubble text is `<breed> woof!` (the one place an exclamation mark is allowed, it's the dog talking).
- Prices live in Square, not the repo. Today standard pins are $12 and the two large pins (aussie, pomeranian) are $15. The Bay Area board is planned at $80 but isn't in Square yet.
- The shop is open or closed by the switch on `/admin` (Firestore `settings/shop`). It started closed.
- Each website product and size is linked to a Square item on `/admin`. Unlinked means sold out.
- Stock shows as a plain "N in stock." while the shop is open, never as urgency.
- 3D models exist for 10 pups. Still missing: cavalier, dachshund, french-bulldog, poodle, rottweiler, yorkie (their "See in 3D" button stays faded).
- The Bay Area board hangs in a living room photo on `pin-boards.html`; tapping it opens `bay-area-pin-board.html` (zoomable full-size image, price and add to bag).
- Contact: support@ourjkadventures.com. Instagram: @ourjkadventures.

## Running and checking
Today (plain static site):
```
npx wrangler dev                     # serves site/ and runs the worker locally on :8787
node --test tests/*.test.mjs         # server tests (tickets, /api/account, /api/reviews), Google faked
```
Put Square sandbox values, `FIREBASE_SERVICE_ACCOUNT` and `ADMIN_EMAILS` in `.dev.vars` to test locally. Without Square,
`/api/checkout` returns 503 and every product shows sold out. Without Firebase, the shop counts as closed. The tests fake both
Google and Square (`tests/helpers.mjs`: `fakeGoogle`, `fakeSquare`, `fakeWorld`).

Before calling any change done:
1. Load every page and the bag; no console errors, no 404s.
2. Pup board: open a pin, "See in 3D" loads for a pup with a model and is disabled for one without.
3. On `/admin` (sandbox): link a sandbox item, open the shop. Then add to bag, pick a size, change quantity, check out against the Square **sandbox**. Close the shop again. Non-owners on `/admin` see only "this page is for the shop owner." 
4. Check a 360px-wide viewport.
5. `grep -ri "wixstatic\|wixapis" site/` returns nothing.
6. `node --test tests/*.test.mjs` passes. For account changes, also create, sign out, sign in, and delete an account.

Update this section when the toolchain changes (for example after the Astro port).

## Working style
- Plan first for anything bigger than a small fix: say what you will change and why, then do it.
- When the owner needs to do something outside the code (Square dashboard, Firebase console, Cloudflare settings), write it as numbered steps and add it to the right file in `docs/setup/`.
- Keep `docs/roadmap.md` current: tick off what's done and note anything discovered.
