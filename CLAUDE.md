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
| `site/assets/app.js` | Bag, pup board, speech bubbles, 3D viewer, checkout call |
| `site/assets/styles.css` | All styles. Design tokens are the CSS variables on `:root` |
| `site/products.json` | Names, prices (cents), sold-out flags. The one source of truth for prices today |
| `site/_worker.js` | Server side (the Worker). `/api/checkout` creates a Square payment link, `/api/account` handles accounts; everything else falls through to static files |
| `server/` | Server code the worker imports (Firebase ticket checks, Firestore, accounts). Bundled by wrangler, never published |
| `site/assets/account.js` | Firebase sign-in in the browser; runs the account pages |
| `firestore.rules` | Firestore rules: no browser access at all. The owner publishes them in the Firebase console |
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
- **Prices are decided on the server.** The browser sends slugs and quantities only. Never trust a price, total or charge count that came from the browser.
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
- Slugs: aussie, beagle, cavalier, corgi, dachshund, french-bulldog, german-shepherd, golden, husky, pit-bull, pomeranian, poodle, pug, rottweiler, shiba, yorkie, bay-area-pin-board.
- The golden retriever pin is displayed as **"goldie"**.
- Hover bubble text is `<breed> woof!` (the one place an exclamation mark is allowed, it's the dog talking).
- Pins are $12. The Bay Area board is $80.
- 3D models exist for 10 pups. Still missing: cavalier, dachshund, french-bulldog, poodle, rottweiler, yorkie (their "See in 3D" button stays faded).
- Contact: jkadventures25@gmail.com. Instagram: @jkadventures25.

## Running and checking
Today (plain static site):
```
npx wrangler dev                     # serves site/ and runs the worker locally on :8787
node --test tests/*.test.mjs         # server tests (tickets, /api/account), Google faked
```
Put Square sandbox values in `.dev.vars` to test checkout locally. Without them `/api/checkout` returns 503 by design.

Before calling any change done:
1. Load every page and the bag; no console errors, no 404s.
2. Pup board: open a pin, "See in 3D" loads for a pup with a model and is disabled for one without.
3. Add to bag, change quantity, check out against the Square **sandbox**.
4. Check a 360px-wide viewport.
5. `grep -ri "wixstatic\|wixapis" site/` returns nothing.
6. `node --test tests/*.test.mjs` passes. For account changes, also create, sign out, sign in, and delete an account.

Update this section when the toolchain changes (for example after the Astro port).

## Working style
- Plan first for anything bigger than a small fix: say what you will change and why, then do it.
- When the owner needs to do something outside the code (Square dashboard, Firebase console, Cloudflare settings), write it as numbered steps and add it to the right file in `docs/setup/`.
- Keep `docs/roadmap.md` current: tick off what's done and note anything discovered.
