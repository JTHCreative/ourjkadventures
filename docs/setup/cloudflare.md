# Cloudflare setup (owner steps)

The site runs as a **Cloudflare Worker with static assets** named `ourjkadventures`, configured in
`wrangler.jsonc` and built from this repo's `main` branch on every push. (Earlier notes described
Cloudflare Pages; that is not what runs.)

## If a merge doesn't start a build
Now and then GitHub's "new code is here" message doesn't reach Cloudflare, so a merge to `main` shows no build at all
(it happened with pull request #102 on 2026-11-12). The site stays on the last version until the next build.
1. In the Cloudflare dashboard, open **Workers & Pages** > **ourjkadventures** > **Deployments**.
2. Retry the latest build, or start a new one for the `main` branch, if the page offers it.
3. If there's no such button: check **Settings** > **Build** still shows the repository `JTHCreative/ourjkadventures`
   with builds on for `main`, and on GitHub that the Cloudflare app still has access to the repository.
4. Or simply merge the next change: every push to `main` asks Cloudflare again.

## Variables and secrets
**Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets**. `wrangler.jsonc` has
`"keep_vars": true`, so deploys don't wipe these.
- `SQUARE_ACCESS_TOKEN` (type: Secret)
- `SQUARE_LOCATION_ID`
- `SQUARE_ENV` = `sandbox` while testing, `production` when live (production today)
- `SUPPORT_EMAIL` = `support@ourjkadventures.com` (shown on Square's checkout page)
- `FIREBASE_SERVICE_ACCOUNT` (type: Secret) and `FIREBASE_PROJECT_ID`, see `firebase.md`

After adding or changing one, press **Deploy**.

## Your domain
`ourjkadventures.com` and `www.ourjkadventures.com` are on Cloudflare and point at the Worker.

## www: one address for every page (added 2026-11-09)
Cloudflare hands out plain pages (like `/admin`, `/about`, `/shop`) straight from the files, before our worker runs, so
our own "move www to ourjkadventures.com" rule only catches some pages. Opening `www.ourjkadventures.com/admin` stays
on www. Since 2026-11-09 the site works there too, but a sign-in or a saved bag made on www doesn't carry over to the
plain address (the browser keeps them per address). This rule moves every www visit, like a sign on the side door
pointing to the front:

1. In the Cloudflare dashboard, open **ourjkadventures.com**, then **Rules** (left menu) > **Overview**.
2. Press **Create rule** > **Redirect Rule**, and pick the template **Redirect from WWW to Root** if it's offered.
   Otherwise fill it in yourself:
   - Rule name: `www to ourjkadventures.com`
   - When incoming requests match: **Custom filter expression**, field **Hostname**, operator **equals**,
     value `www.ourjkadventures.com`
   - Then: **Dynamic** redirect, expression `concat("https://ourjkadventures.com", http.request.uri.path)`,
     status code **301**, and tick **Preserve query string**
3. Press **Deploy**.
4. Check it: open `www.ourjkadventures.com/admin` and the address bar should change to `ourjkadventures.com/admin`.
   You'll need to sign in once more there.

## Email: support@ourjkadventures.com (set up 2026-10-26)
Cloudflare **Email Routing** forwards mail for the domain to Gmail. It only receives; it cannot send.
- Domain > **Email** > **Email Routing**: Enabled, DNS records configured.
- **Destination addresses**: `ourjkadventures@gmail.com`, Verified.
- **Routing rules** > Custom addresses: `support@ourjkadventures.com` > Send to an email > `ourjkadventures@gmail.com`, Active.

If mail to support@ bounces with "address not found", check those three in that order. Test from a
different account than the Gmail it forwards to, because Gmail can hide mail you sent to yourself.

### Replying as support@ from Gmail (optional)
Gmail > Settings > **Accounts and Import** > **Send mail as** > Add another email address:
- SMTP server `smtp.gmail.com`, port `587`, TLS, username `ourjkadventures@gmail.com`.
- Password: a Google **app password** (myaccount.google.com/apppasswords, needs 2-Step Verification on).
  Never the Cloudflare server (`route*.mx.cloudflare.net`), which Gmail suggests but only receives mail.
- Then choose **Reply from the same address the message was sent to**.
- To help these replies avoid spam, add `include:_spf.google.com` to the domain's SPF TXT record:
  `v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all`

## Every update after this
Push to `main` and Cloudflare publishes in about a minute.
