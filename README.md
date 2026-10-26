# j+k adventures

Website and shop for j+k adventures: small enamel pins for the things you love.

- **Live site:** Cloudflare Pages, deployed from this repo on every push to `main`
- **Payments:** Square (website checkout and the craft-fair card reader)
- **Coming:** Astro, Square stock sync, accounts and the Collector's Path (see `docs/roadmap.md`)

## Start here
| If you are... | Read |
|---|---|
| Claude Code | `CLAUDE.md` |
| the owner, setting things up | `docs/setup/` (cloudflare, square, firebase) |
| anyone, wondering what's next | `docs/roadmap.md` |
| writing words for the site | `docs/brand-voice.md` and `docs/manifesto.md` |

## Run it locally
```
npx wrangler pages dev site
```
Copy `.dev.vars.example` to `.dev.vars` and fill in Square sandbox values to test checkout.
