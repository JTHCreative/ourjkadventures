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

Steps 1 to 3 can be done now. Step 4 works once the reel door branch is merged to `main` and Claude Code
has added the KV ID from step 3.2 to `wrangler.jsonc`.

## 1. Create the Meta app (about 15 minutes)
Meta changes its labels now and then, so the names below may be slightly different.

1. Go to **developers.facebook.com** and sign in with the Facebook account that manages the business.
   If asked, register as a developer (free).
2. **My Apps** > **Create app**.
3. Name it `j+k adventures website` and use `support@ourjkadventures.com` as the contact email.
4. For the use case, pick the one about **Instagram** (for example "Manage messaging and content on
   Instagram"). If asked for an app type, pick **Business**.
5. Open the app. On the **Dashboard**, click **Customize the Manage messaging & content on Instagram use
   case** (or **Use cases** in the left menu > **Customize** next to it). Inside, choose
   **API setup with Instagram login** (not "with Facebook login"). There's no Instagram item in the left
   menu itself, and the **Facebook Login for Business** item there can be ignored.
6. Write down the **Instagram app ID** and the **Instagram app secret** shown there (press **Show** for
   the secret). Note: these are the *Instagram* ones on that page, not the "App ID" at the top of the
   dashboard. You'll paste them into Cloudflare in step 3.
7. In **Set up Instagram business login** > **Business login settings**, add both of these under
   **OAuth redirect URIs** and save (the second covers opening `/admin` on the www address):
   `https://ourjkadventures.com/api/admin/instagram/callback`
   `https://www.ourjkadventures.com/api/admin/instagram/callback`
8. Under **Permissions and features** in the same use case, make sure **instagram_business_basic** is
   listed. Messaging permissions may be listed too; leave them, the website only ever asks for
   `instagram_business_basic`. You don't need "Become a Tech Provider" or **Publish**.

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
   secret; it goes in `wrangler.jsonc` so the website can open the drawer. (It can't go in before the
   drawer exists: a made-up ID would stop the site from deploying.)
3. **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**, both as
   type **Secret**:
   - `INSTAGRAM_APP_ID`: the Instagram app ID from step 1.6
   - `INSTAGRAM_APP_SECRET`: the Instagram app secret from step 1.6
4. Press **Deploy**.

## 4. Connect Instagram (once the new code is live)
1. Sign in on the website with your owner email and open `https://ourjkadventures.com/admin`.
2. In the **instagram** box, press **connect instagram**. If the box says "still needed in cloudflare"
   and names something, step 3 isn't finished: that's the missing piece.
3. Instagram asks you to sign in as **@ourjkadventures** and allow the app to read your profile and
   posts. Allow it.
4. You land back on `/admin`. The box should say "done. connected as @ourjkadventures.", how many reels
   are on the About page, and how long the key lasts. It renews itself every monday.
5. Open the About page. The placeholders should be replaced by your recent reels. If you just posted
   one, it can take up to 30 minutes to show.

## When something looks wrong
- **The About page still shows the placeholders:** step 4 wasn't finished. Check the box on `/admin`
  says "connected".
- **The "out and about." section has disappeared:** the website couldn't get any reels (Instagram was
  unreachable and there was no saved copy yet). Check `/admin`; pressing **connect instagram** again
  is always safe.
- **A reel shows a still picture instead of playing:** Instagram leaves the video file out for reels
  with licensed music. Tapping it still leads to the reel on Instagram. Original audio avoids this.
- **You changed the Instagram password, or removed the app** in Instagram's settings: the key stops
  working, and `/admin` says "the last renewal did not work". Press **connect again** and sign in.
  Meanwhile the About page keeps showing the last reels it saved.
- **To stop showing reels from Instagram:** press **disconnect** on `/admin`. The About page goes back to
  the stand-in reels.
- **Only one or two reels show:** that's expected while there are only one or two video posts. One reel
  sits on its own; two each appear twice so the ring still turns. Photos and carousels never show.
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
