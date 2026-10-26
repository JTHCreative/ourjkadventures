# Cloudflare setup (owner steps)

The site runs as a **Cloudflare Worker with static assets** named `ourjkadventures`, configured in
`wrangler.jsonc` and built from this repo's `main` branch on every push. (Earlier notes described
Cloudflare Pages; that is not what runs.)

## Variables and secrets
**Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets**. `wrangler.jsonc` has
`"keep_vars": true`, so deploys don't wipe these.
- `SQUARE_ACCESS_TOKEN` (type: Secret)
- `SQUARE_LOCATION_ID`
- `SQUARE_ENV` = `sandbox` while testing, `production` when live (production today)
- `TAX_PERCENT` (optional, e.g. `9.25`)
- `SUPPORT_EMAIL` = `support@ourjkadventures.com` (shown on Square's checkout page)
- `FIREBASE_SERVICE_ACCOUNT` (type: Secret) and `FIREBASE_PROJECT_ID`, see `firebase.md`

After adding or changing one, press **Deploy**.

## Your domain
`ourjkadventures.com` and `www.ourjkadventures.com` are on Cloudflare and point at the Worker.

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
