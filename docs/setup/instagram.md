# Instagram setup for the reel door (owner steps)

The reel door on the About page ("out and about.") shows stand-in reels until the website can read
**@ourjkadventures**. It's all free: the Meta app, the Instagram API and the Cloudflare pieces fit in the
free plans (see "what it costs" at the end).

**How it works, in one picture:** the website gets its own staff key to the Instagram account, cut at the
front desk of our business portfolio (J+K Adventures): a **system user** is a staff member that's a
program, not a person. Its key can only read our posts, never expires, and is kept as a Cloudflare secret
that only the website can use. Every 30 minutes at most, the website fetches the latest reels, keeps a
copy in Cloudflare (Workers KV), and shows that copy to visitors.

**Never** put the key or the app secret in the repo, an email or a chat.

Already done: the Meta app (`j+k adventures website`) owned by the J+K Adventures business portfolio,
@ourjkadventures in that portfolio, the `REEL_STORE` KV namespace, and `META_APP_ID`, `META_APP_SECRET`
and `INSTAGRAM_CONFIG_ID` in Cloudflare. The J+K Adventures Facebook Page's ID (`INSTAGRAM_PAGE_ID`, `1209633565574678`) is in
`wrangler.jsonc`: the website finds @ourjkadventures through it.

## Why not the "connect instagram" sign-in
We tried it first. Meta's sign-in ("Unified login", built on Facebook Login for Business) is meant for
apps that connect to *other* businesses' accounts: Meta's docs say the app's business portfolio must be
"separate from the business portfolio owned by your business client". Ours are the same portfolio, so the
key it gave could not open our own account ("Application does not have permission for this action").
A system user key from our own business settings is Meta's way for a business to read its own account.

## 1. Make the website's key (about 10 minutes)
Meta changes its labels now and then, so the names below may be slightly different.

1. Go to **business.facebook.com/settings** (Business settings) and make sure **J+K Adventures** is the
   portfolio shown at the top.
2. **Users** > **System users** > **Add**. Name it `website`, role **Employee** (not Admin: it only needs
   to read). Press **Create system user**.
3. With `website` selected, press **Assign assets** (or **Add assets**):
   - **Instagram accounts** > **ourjkadventures**: give it the smallest access that lets it see content
     (for example "View content" or "Partial access"). Save.
   - **Apps** > **j+k adventures website**: give it access (for example "Develop app"). Save.
4. Still on `website`, press **Generate new token** (or **Generate token**):
   - App: **j+k adventures website**
   - Token expiration: **Never**
   - Permissions: tick only **instagram_basic**. If it isn't in the list, send Claude Code a screenshot of
     the list instead of guessing.
   - Press **Generate token**, then copy the key. It's shown only once.

## 1b. Link the Instagram account to a Facebook Page (needed)
This kind of key reaches an Instagram account through a linked Facebook Page. Without one, `/admin`'s test
answers show "facebook pages: none", and reading the account fails with "(#10) Application does not have
permission". (`1323062497557751`, the ID on Meta's screens, is the portfolio's label for the account, not
the Instagram account itself: Meta says it has no posts.) A Page is free and doesn't need any posts.

1. Business settings > **Accounts** > **Pages** > **Add** > **Create a new Page**, named "j+k adventures"
   (or use an existing Page, as long as it's listed under J+K Adventures).
2. **Accounts** > **Instagram accounts** > **ourjkadventures** > **Connect assets** > pick the Page.
3. **Users** > **System users** > **website** > **Assign assets** > **Pages** > the Page, with the smallest
   access that lets it see content.
4. The Page's ID (Business settings > **Accounts** > **Pages**, or the Page's **About** > **Page
   transparency**) goes in `wrangler.jsonc` as `INSTAGRAM_PAGE_ID`. Meta leaves the Page out of the key's
   own list of Pages, so the website asks for it by ID.
5. Make a new key for `website` (step 1.4) with three permissions: **instagram_basic**,
   **pages_show_list** and **pages_read_engagement**. Put it in Cloudflare in place of the old one (step 2).

## 2. Put the key in Cloudflare
1. **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets** > **Add**:
   `INSTAGRAM_ACCESS_TOKEN`, type **Secret**, and paste the key.
2. Press **Deploy**.

## 3. Check it
1. Sign in on the website with your owner email and open `https://ourjkadventures.com/admin`.
2. The **instagram** box should say "connected as @ourjkadventures, with the key in cloudflare." (There's
   no connect button any more while the key is there.)
3. Open the About page. Your recent reels should replace the stand-ins. A brand new reel can take up to
   30 minutes to show.

## When something looks wrong
- **The box says "the key in cloudflare does not open @ourjkadventures yet" with Meta's words:** send that
  sentence to Claude Code. The most likely fixes: the system user wasn't given the Instagram account
  (step 1.3), the key was made without `instagram_basic` (step 1.4), or the account ID in `wrangler.jsonc`
  isn't the one Meta's data system uses.
- **The box says "the last fetch did not work":** Meta was unreachable or refused for a while. The About
  page keeps the last reels it saved and tries again within 30 minutes.
- **The "out and about." section has disappeared:** the website couldn't get any reels yet, or the account
  has no video posts. Check `/admin`.
- **A reel shows a still picture instead of playing:** Meta leaves the video file out for reels with
  licensed music. Tapping it still leads to the reel on Instagram. Original audio avoids this.
- **Only one or two reels show:** expected while there are only one or two video posts. One reel sits on
  its own; two each appear twice so the ring still turns. Photos and carousels never show.
- **To stop showing reels from Instagram:** delete `INSTAGRAM_ACCESS_TOKEN` in Cloudflare and press
  **Deploy**. To cancel the key itself, remove the `website` system user in Business settings.
- **Someone else should take over:** add their email to `ADMIN_EMAILS` (see `firebase.md`). The key belongs
  to the business portfolio, so it keeps working when people come and go.

## What it costs
Nothing on top of what you pay now. Checked against Cloudflare's pricing pages (November 2026):

| Piece | Free allowance | What the reel door uses |
|---|---|---|
| KV reads | 100,000 a day | about one per About page visit |
| KV writes | 1,000 a day | about 50 a day at most |
| KV storage | 1 GB | a few kilobytes |
| Worker requests | 100,000 a day, shared with the shop | one per About page visit |

The Meta app and the Instagram API are free. On the free plan, going over a daily limit makes that kind of
action fail until midnight UTC; it never charges you.
