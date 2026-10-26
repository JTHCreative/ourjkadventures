# Cloudflare setup (owner steps)

## Connect the repo (once)
1. Cloudflare dashboard > **Workers & Pages** > **Create** > **Pages** > **Connect to Git**.
2. Pick the GitHub repo. Allow Cloudflare's GitHub app access to just this repo.
3. Build settings, for now:
   - Framework preset: **None**
   - Build command: *(leave empty)*
   - Build output directory: **site**
   After the Astro port this becomes `npm run build` and `dist`.
4. Save and deploy. You get a free `<project>.pages.dev` address.

If you already made a drag-and-drop project, make a new one. An upload-only project can't be switched to Git.

## Variables and secrets
Project > **Settings** > **Variables and secrets**. Add each to **Production** (and **Preview** if you want test deploys to work):
- `SQUARE_ACCESS_TOKEN` (type: Secret)
- `SQUARE_LOCATION_ID`
- `SQUARE_ENV` = `sandbox` while testing, `production` when live
- `TAX_PERCENT` (optional, e.g. `9.25`)
- `SUPPORT_EMAIL` (optional)

Changes to variables apply on the next deploy. Push any commit, or use **Retry deployment**.

## Your domain
Project > **Custom domains** > **Set up a custom domain** > type it in. Because the domain is already on
Cloudflare, it adds the DNS records itself. Add both `yourdomain.com` and `www.yourdomain.com`.

## Every update after this
Push to `main` and Cloudflare publishes in about a minute. Pushes to other branches get their own preview address.
