# Instagram setup for the reel door (owner steps)

The reel door on the About page ("out and about.") shows the real reels from **@ourjkadventures**. It's
all free: the Meta app, the Instagram API and the Cloudflare pieces fit in the free plans (see "what it
costs" at the end). Connected 2026-11-02.

**How it works, in one picture:** the website has its own staff key to the Instagram account, cut at the
front desk of our business portfolio (J+K Adventures). The key belongs to a **system user** called
`website`: a staff member that's a program, not a person. The key can only read, never expires, and is kept
as a Cloudflare secret that only the website can use. Meta lets this kind of key reach an Instagram account
through the Facebook Page it's linked to, so the website asks for the J+K Adventures Page and reads the
account linked to it. Every 10 minutes at most it fetches the latest reels, keeps a copy in Cloudflare
(Workers KV), and shows that copy to visitors.

**Never** put the key or the app secret in the repo, an email or a chat.

## What's in place
| Where | What | Keep it because |
|---|---|---|
| Meta | the app `j+k adventures website`, owned by J+K Adventures | the key is made for this app |
| Meta | the Facebook Page **J+K Adventures** (ID `1209633565574678`), linked to @ourjkadventures | it's the key's way in. It can stay empty |
| Meta | the system user **website** (Employee), assigned @ourjkadventures (Content on), the Page and the app | it owns the key |
| Cloudflare secret | `INSTAGRAM_ACCESS_TOKEN` | the key |
| Cloudflare secret | `META_APP_SECRET` | signs every request to Meta |
| Cloudflare | `META_APP_ID` (optional) | only for the "key" line in `/admin`'s test answers |
| `wrangler.jsonc` | `INSTAGRAM_PAGE_ID` and the `REEL_STORE` KV binding | which Page to ask for, and where the saved copy lives |

## If it ever needs setting up again
Meta changes its labels now and then, so the names below may be slightly different.

1. **The Page.** Business settings (business.facebook.com/settings, with J+K Adventures selected) >
   **Accounts** > **Pages**: the J+K Adventures Page should be listed. If not, **Add** > **Create a new
   Page**, then put its ID (shown there, or on the Page under **About** > **Page transparency**) in
   `wrangler.jsonc` as `INSTAGRAM_PAGE_ID`.
2. **Link the Page to Instagram.** On facebook.com, switch into the Page > **Settings & privacy** >
   **Settings** > **Linked accounts** > **Instagram** > **Connect account**, and log in as @ourjkadventures.
   (Business settings' **Connect assets** on the Instagram account only offers ad accounts.) Afterwards,
   **Accounts** > **Instagram accounts** > **ourjkadventures** > **Connected assets** shows the Page.
3. **The system user.** **Users** > **System users** > **Add**, named `website`, role **Employee**. Then
   **Assign assets**:
   - **Instagram accounts** > **ourjkadventures**, with **Content** on.
   - **Pages** > **J+K Adventures** (its switches may be greyed out, set "on the Instagram side": that's fine).
   - **Apps** > **j+k adventures website**.
4. **The key.** On `website`, **Generate new token**: app **j+k adventures website**, expiration **Never**,
   permissions **instagram_basic**, **pages_show_list**, **pages_read_engagement** and **instagram_manage_insights**
   (that last one is only for the share counts on a full-screen reel; without it the reels still show, with likes and
   comments but no shares). Copy it (shown once).
5. **Cloudflare.** **Workers & Pages** > **ourjkadventures** > **Settings** > **Variables and Secrets**:
   `INSTAGRAM_ACCESS_TOKEN` as a **Secret** (paste the key), then **Deploy** (not "Save version", which
   doesn't put it live). `META_APP_SECRET` (the app's **App settings** > **Basic** > App secret) as a Secret.
6. **Check.** Open `https://ourjkadventures.com/admin`. The **instagram** box should say "connected as
   @ourjkadventures, with the key in cloudflare." Then the About page shows the reels (a brand new reel can
   take up to 10 minutes).

## When something looks wrong
- **The box says "the key in cloudflare does not open @ourjkadventures":** under it is a list of Meta's
  answers to a few test questions. Send the whole list to Claude Code. The "page" line shows whether the key
  can read the Page and which Instagram account is linked to it.
- **The box says "the last fetch did not work":** Meta was unreachable or refused for a while. The About
  page keeps the last reels it saved and tries again within 10 minutes.
- **The "out and about." section has disappeared:** the website couldn't get any reels yet, or the account
  has no video posts. Check `/admin`.
- **A reel shows its cover with a play mark instead of playing in the ring:** it uses licensed music
  (including Instagram's audio library). Meta leaves the video file out for those, and Instagram's
  embedded player won't play them on other sites either. Tapping it asks "watch on instagram?" and opens
  the reel on Instagram in a new tab. Reels with your own original sound play right in the ring.
- **Only one or two reels show:** expected while there are only one or two video posts. One reel sits on
  its own; two each appear twice so the ring still turns. Photos and carousels never show.
- **To stop showing reels from Instagram:** delete `INSTAGRAM_ACCESS_TOKEN` in Cloudflare and press
  **Deploy**. To cancel the key itself, remove the `website` system user in Business settings.
- **Someone else should take over:** add their email to `ADMIN_EMAILS` (see `firebase.md`). The key belongs
  to the business portfolio, so it keeps working when people come and go.

## Cleaning up the first attempt (optional)
We first tried Meta's "connect instagram" sign-in (Unified login). It can't open an account in the app's own
business portfolio, so its code is gone (see `docs/decisions.md`). These leftovers are harmless; removing
them just keeps things tidy:
- **Cloudflare:** delete the variable `INSTAGRAM_CONFIG_ID` (and `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET`
  if they're still there), then **Deploy**. Keep `INSTAGRAM_ACCESS_TOKEN`, `META_APP_SECRET`, and
  `META_APP_ID` if you like the "key" line in `/admin`'s test answers.
- **Meta app** (developers.facebook.com > your app > **Use cases** > **Manage messaging & content on
  Instagram** > **Customize** > **API setup with Unified login**): you can delete the configuration, the two
  redirect URLs, and the Instagram tester. Nothing uses them.
- **Leave alone:** the app itself, the Facebook Page and its link to Instagram, and the `website` system user.

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
