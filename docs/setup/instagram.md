# Instagram setup for the reel door (owner steps)

The reel door on the About page ("out and about.") shows stand-in reels today. These steps let it show
the real reels from **@ourjkadventures** instead. It's all free: the Meta developer app, the Instagram API
and the Cloudflare pieces fit in the free plans (see "what it costs" at the end).

**How it works, in one picture:** the website gets a staff key to the Instagram account. The key belongs
to the business portfolio (J+K Adventures), not to whoever signed in, and it doesn't expire. It lives in a
drawer at Cloudflare (Workers KV) that only the website can open, and the website only ever uses it to read
our posts. Every 30 minutes at most, the website fetches the latest reels, keeps a copy in the drawer, and
shows that copy to visitors.

This uses what Meta calls **"Instagram API with Unified Login"**, the setup Meta now gives new apps
(checked against Meta's docs, November 2026).

**Never** put the app secret or the key in the repo, an email or a chat.

Already done: the Meta app (`j+k adventures website`) with the **Manage messaging & content on
Instagram** use case, the business portfolio connected to the app, and @ourjkadventures added to the
business portfolio.

## 1. Create the configuration (about 10 minutes)
A configuration is the list of what the website asks for when you sign in.

1. In the app: **Use cases** > **Manage messaging & content on Instagram** > **Customize** >
   **API setup with Unified login**. (This tab only shows once the app belongs to a business portfolio.)
2. Under **1. Configure your app**, press **Create new configuration**.
3. Open the configuration preview and press **Edit permissions**. Keep only what's needed:
   - keep `instagram_basic` (reads the profile and posts: the one the website uses)
   - `instagram_manage_messages` is required by Meta and can't be removed. The website never uses it.
   - remove `instagram_manage_comments`, `instagram_content_publish`, `ads_management` and `ads_read`
4. Check the preview says **Access token: System-user access token (SUAT)** and
   **Expiration: Never**. If it offers an expiration choice, pick **Never**.
5. Press **Use this configuration**.
6. Under **Redirect URL**, add this and press **Save**, then add the second one and **Save** again:
   `https://ourjkadventures.com/api/admin/instagram/callback`
   `https://www.ourjkadventures.com/api/admin/instagram/callback`
7. Under **Login URL**, find the part that reads `config_id=` followed by a long number. Copy just that
   number: it's the **configuration ID**, for step 3. It isn't secret.

## 2. Let the app see your account
While the app is in development mode, only accounts with a role on the app can connect. That's all we
need: it only ever reads our own account.

1. On the same page, open **Generate access tokens** > **Add account**, and invite **@ourjkadventures**
   as an **Instagram Tester**.
2. On Instagram on the web, signed in as @ourjkadventures: **Settings** > **Website permissions** >
   **Apps and websites** > **Tester invites**, and **Accept**.
3. You don't need to press **Generate token**: the website gets its own key in step 4.

Skip **Configure webhooks**, **Complete App Review**, **Publish** and "Become a Tech Provider". None of
them are needed to show our own reels on our own website.

## 3. Cloudflare: the drawer and three settings
1. In the app, **App settings** > **Basic**: copy the **App ID**, and press **Show** next to
   **App secret**. These are the *Meta* app's ID and secret (not the Instagram ones some pages show).
2. Cloudflare dashboard > **Storage & databases** > **Workers KV** (or **Workers & Pages** > **KV**) >
   **Create**. Name it `REEL_STORE`.
3. Copy its **ID** (a long string of letters and numbers) and send it to Claude Code. The ID isn't
   secret; it goes in `wrangler.jsonc` so the website can open the drawer. (It can't go in before the
   drawer exists: a made-up ID would stop the site from deploying.)
4. **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**:
   - `META_APP_ID`: the App ID from step 3.1 (type **Text** is fine)
   - `META_APP_SECRET`: the App secret from step 3.1, type **Secret**
   - `INSTAGRAM_CONFIG_ID`: the configuration ID from step 1.7 (type **Text**)

   If you added `INSTAGRAM_APP_ID` or `INSTAGRAM_APP_SECRET` from an earlier version of these steps,
   delete them: they aren't used.
5. Press **Deploy**.

## 4. Connect Instagram (once the new code is live)
This works once the reel door branch is merged to `main` and Claude Code has added the KV ID.

1. Sign in on the website with your owner email and open `https://ourjkadventures.com/admin`.
2. In the **instagram** box, press **connect instagram**. If the box says "still needed in cloudflare"
   and names something, step 3 isn't finished: that's the missing piece.
3. Meta's sign-in opens. Log in with Facebook or Instagram, whichever you like.
4. Pick the business portfolio **J+K Adventures**, then the Instagram account **@ourjkadventures**.
   If it offers an ad account, skip it. Approve.
5. You land back on `/admin`. The box should say "done. connected as @ourjkadventures.", how many reels
   are on the About page, and "the key does not expire."
6. Open the About page. Your recent reels should replace the stand-ins. If you just posted one, it can
   take up to 30 minutes to show.

## When something looks wrong
- **The About page still shows the stand-ins:** step 4 wasn't finished. Check the box on `/admin` says
  "connected".
- **`/admin` says "no instagram account was shared":** during sign-in, @ourjkadventures wasn't ticked,
  or the website couldn't work out which account was shared. Meta's key covers "all" accounts without
  naming ours, so the website uses `INSTAGRAM_ACCOUNT_ID` in `wrangler.jsonc` (@ourjkadventures' ID,
  shown next to the account on Meta's sign-in screen). If the account ever changes, that ID changes too.
- **`/admin` says "instagram stopped accepting our key":** the app was removed from the business
  portfolio, or @ourjkadventures moved to another portfolio. Press **connect again**. Meanwhile the About
  page keeps showing the last reels it saved.
- **The "out and about." section has disappeared:** the website couldn't get any reels (Meta was
  unreachable and there was no saved copy yet) or the account has no video posts. Check `/admin`.
- **A reel shows a still picture instead of playing:** Meta leaves the video file out for reels with
  licensed music. Tapping it still leads to the reel on Instagram. Original audio avoids this.
- **The box says the key "lasts until" a date:** the configuration was set to expire. Either press
  **connect again** before that date, or make a new configuration with expiration **Never** (step 1),
  put its ID in `INSTAGRAM_CONFIG_ID`, and connect again.
- **To stop showing reels from Instagram:** press **disconnect** on `/admin`. The About page goes back to
  the stand-in reels.
- **Only one or two reels show:** that's expected while there are only one or two video posts. One reel
  sits on its own; two each appear twice so the ring still turns. Photos and carousels never show.
- **Someone else should take over:** add them to `ADMIN_EMAILS` (see `firebase.md`). Because the key
  belongs to the business portfolio, it keeps working when people come and go.

## What it costs
Nothing on top of what you pay now. Checked against Cloudflare's pricing pages (November 2026):

| Piece | Free allowance | What the reel door uses |
|---|---|---|
| KV reads | 100,000 a day | about one per About page visit |
| KV writes | 1,000 a day | about 50 a day at most |
| KV storage | 1 GB | a few kilobytes |
| Worker requests | 100,000 a day, shared with the shop | one per About page visit |

The Meta developer app and the Instagram API are free. On the free plan, going over a daily limit makes
that kind of action fail until midnight UTC; it never charges you.
