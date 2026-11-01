# Instagram setup for the reel door (owner steps)

The reel door on the About page ("out and about.") shows placeholder reels today. These steps let it
show the real reels from **@ourjkadventures** instead. It's all free: the Meta developer app, Instagram's
API, and the Cloudflare pieces fit in the free plans (see "what it costs" at the end).

**How it works, in one picture:** the website gets a valet key to the Instagram account. The key can
only *read* posts, never post, change or see messages. The key lives in a drawer at Cloudflare (Workers
KV) that only the website can open. Every 30 minutes at most, the website uses the key to fetch the
latest reels, keeps a copy in the drawer, and shows that copy to visitors. Once a week it swaps the key
for a fresh one, so it never runs out (keys last about 60 days).

**Never** put the Instagram password, the app secret or the key in the repo, an email or a chat.

Steps 1 to 3 can be done now. Step 4 waits until Claude Code has built the new code and it's deployed.

## 1. Create the Meta app (about 15 minutes)
Meta changes its labels now and then, so the names below may be slightly different.

1. Go to **developers.facebook.com** and sign in with the Facebook account that manages the business.
   If asked, register as a developer (free).
2. **My Apps** > **Create app**.
3. Name it `j+k adventures website` and use `support@ourjkadventures.com` as the contact email.
4. For the use case, pick the one about **Instagram** (for example "Manage messaging and content on
   Instagram"). If asked for an app type, pick **Business**.
5. Open the app. In the menu, go to **Instagram** > **API setup with Instagram login**
   (also called "Business login for Instagram").
6. Write down the **Instagram app ID** and the **Instagram app secret** shown there (press **Show** for
   the secret). Note: these are the *Instagram* ones on that page, not the "App ID" at the top of the
   dashboard. You'll paste them into Cloudflare in step 3.
7. In **Set up Instagram business login** > **Business login settings**, add this under
   **OAuth redirect URIs** and save:
   `https://ourjkadventures.com/api/admin/instagram/callback`
8. Make sure the permission **instagram_business_basic** is listed (it usually is by default). Don't add
   any others: the website only needs to read.

## 2. Let the app see your account
While the app is in development mode, only accounts with a role on it can sign in. That's all we need:
it only ever reads our own account.

1. In the app: **App roles** > **Roles** > **Add people** > **Instagram tester**, and enter
   `ourjkadventures`.
2. On Instagram (app or website, signed in as @ourjkadventures): **Settings** > **Website permissions**
   (or **Apps and websites**) > **Tester invites**, and **Accept**.

The app does **not** need to go through Meta's app review or be switched to live for this.

## 3. Cloudflare: the drawer and the two secrets
1. Cloudflare dashboard > **Storage & databases** > **Workers KV** (or **Workers & Pages** > **KV**) >
   **Create**. Name it `REEL_STORE`.
2. Copy its **ID** (a long string of letters and numbers) and send it to Claude Code. The ID isn't
   secret; it goes in `wrangler.jsonc` so the website can open the drawer.
3. **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**, both as
   type **Secret**:
   - `INSTAGRAM_APP_ID`: the Instagram app ID from step 1.6
   - `INSTAGRAM_APP_SECRET`: the Instagram app secret from step 1.6
4. Press **Deploy**.

## 4. Connect Instagram (once the new code is live)
1. Sign in on the website with your owner email and open `https://ourjkadventures.com/admin`.
2. In the **instagram** box, press **connect instagram**.
3. Instagram asks you to sign in as **@ourjkadventures** and allow the app to read your profile and
   posts. Allow it.
4. You land back on `/admin`, which should say the account is connected and when the key next renews.
5. Open the About page. The placeholders should be replaced by your recent reels. If you just posted
   one, it can take up to 30 minutes to show.

## When something looks wrong
- **The About page still shows the placeholders:** the switch to real reels hasn't shipped yet, or
  step 4 wasn't finished. Check `/admin` says "connected".
- **The "out and about." section has disappeared:** the website couldn't get any reels (Instagram was
  unreachable and there was no saved copy yet). Check `/admin`; pressing **connect instagram** again
  is always safe.
- **A reel shows a still picture instead of playing:** Instagram leaves the video file out for reels
  with licensed music. Tapping it still leads to the reel on Instagram. Original audio avoids this.
- **You changed the Instagram password, or removed the app** in Instagram's settings: the key stops
  working. Do step 4 again.
- **Someone else should take over:** add them as an Instagram tester (step 2) and add their email to
  `ADMIN_EMAILS` (see `firebase.md`).

## What it costs
Nothing on top of what you pay now. Checked against Cloudflare's pricing pages (November 2026):

| Piece | Free allowance | What the reel door uses |
|---|---|---|
| KV reads | 100,000 a day | about one per About page visit |
| KV writes | 1,000 a day | about 50 a day, plus one a week for the key |
| KV storage | 1 GB | a few kilobytes |
| Scheduled jobs (cron triggers) | 5 per account | 1 (weekly key renewal) |
| Worker requests | 100,000 a day, shared with the shop | one per About page visit |

The Meta developer app and the Instagram API are free. On the free plan, going over a daily limit
makes that kind of action fail until midnight UTC; it never charges you.
