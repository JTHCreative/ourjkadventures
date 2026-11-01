# reel door — build spec for claude code

Oct 31, 2026 · @Justin

## Goal

Build the reel door: a carousel of portrait reels arranged on an invisible ring, where dragging or tapping an arrow pulls the next reel forward and pushes the current one back. Reels always face the viewer; only their position, size and stacking change, plus a brief swing as two reels trade places. The approved prototype is the [reel door design canvas](https://claude.ai/artifact/TktWUDTmMR7EmQxXPbH59k); this spec is self-contained so Claude Code does not need to open it.

**How to use this spec:** export this doc as Markdown, save it in the repo (for example `docs/reel-door-spec.md`), then give Claude Code this prompt:

> Read docs/reel-door-spec.md and implement the reel door component exactly as specified. Start by inspecting the repo to choose the framework and styling approach that matches the existing code. Build it with placeholder reels first (section: Implementation plan, step 1–4), then wire real reels from our own Instagram account using Path A in the Instagram section. Stop and ask before creating any Meta app, storing tokens, or adding a backend route. When done, run through the acceptance checklist and report which items pass.

## Interaction behaviour

The whole component is driven by one number, the ring angle in degrees; everything on screen is computed from it every frame.

- **Ring model.** N reels (default 8) sit at angles `i × (360 / N)` on a ring. The reel nearest angle 0 relative to the ring is the front reel. The ring loops forever; there is no first or last reel.
- **Reels face forward.** Never rotate a reel to follow the ring. A reel's position on the ring only sets its x offset, a small upward shift, its scale and its stacking order.
- **Front reel overlaps neighbours.** At rest the front reel is larger and sits on top, covering a sliver (about 20%) of the reels on either side.
- **Drag.** Pointer down anywhere on the stage, move more than 4 px horizontally to start a drag, then capture the pointer. The front reel tracks the pointer one to one: dragging right brings the previous reel forward, dragging left brings the next one. Vertical scrolling must still work (`touch-action: pan-y`).
- **Release and momentum.** On release, project the angle forward by the pointer's recent velocity (velocity × 0.22 s), snap to the nearest reel, and cap the fling at 3 reels from where it was released. If the pointer was still for more than 90 ms before release, use zero velocity.
- **Spring.** Animate toward the snapped angle with a slightly under-damped spring (stiffness 120, damping ratio 0.92), carrying the release velocity in. Stop when within 0.03° and slower than 0.4°/s.
- **Arrows.** Left and right buttons step one reel. Rapid clicks queue: each click moves the target, not the current angle.
- **Keys.** With the stage focused, Left and Right arrow keys step one reel. Bind on the stage element, never on `window`.
- **Click a reel or a dot.** A tap (no drag) on any reel, or on its dot below, brings that reel to the front by the shortest way round.
- **Swap without clipping.** While a reel is between the front spot and a neighbour's spot, it swings outward, pops forward and turns a few degrees to face away from the centre. Both reels in a swap do this, so they pass with clear space; it peaks halfway and is zero at rest, and it works the same dragging either way.
- **Stacking.** Use z-index from the distance to the front (closest on top), not real 3D depth. Real 3D depth makes two crossing reels slice through each other.
- **Progress bar.** Only the front reel shows a progress bar. With auto-advance on, the ring steps to the next reel when the bar (or the real video) finishes.

## Geometry and maths

Per frame, for each reel i, compute its placement from the ring angle; this is the exact model from the prototype.

```js
const s = 360 / N;                                   // step between reels, degrees
const Rx = (0.8 * W / Math.sin(2 * Math.PI / N)) * spread; // sideways reach, W = reel width
const d = mod(i * s - angle + 180, 360) - 180;      // signed offset from front, -180..180
const ad = Math.abs(d), rad = d * Math.PI / 180;
const w = Math.max(0, 1 - ad / s);
const ease = w * w * (3 - 2 * w);                   // 1 at front, 0 at neighbour
const t = Math.min(1, ad / s);
const bump = Math.sin(Math.PI * t);                 // 0 at rest, 1 mid-swap
const side = Math.sign(d);
const back = (1 - Math.cos(rad)) / 2;               // 0 front, 1 directly behind
const z = -2 * depth * back + lift * ease + pop * bump;
const scale = perspective / Math.max(1, perspective - z);
const x = (Rx * Math.sin(rad) + side * clearance * bump) * scale;
const y = -arc * back * scale;
const rotY = side * swing * bump;
const zIndex = 1000 - Math.round(ad * 10);
const haze = Math.min(0.78, (ad / s) * 0.22);      // cream overlay opacity
// transform: translate(x, y) scale(scale) perspective(900px) rotateY(rotY)
```

Drag mapping: `angle = startAngle - dx × (180 / π) / Rx × 1.1`. Expose the tuning values below as props with these defaults.

| Prop | Default | Range | What it does |
| --- | --- | --- | --- |
| count | 8 | 4–12 | Number of reels on the ring |
| spread | 1.0 | 0.6–1.6 | Sideways spacing; lower = more overlap |
| depth | 260 px | 100–600 | How far back the rear reels sit (sets their size) |
| lift | 90 px | 0–220 | How far the front reel comes forward |
| arc | 36 px | 0–120 | How much rear reels rise |
| perspective | 1500 px | 600–3000 | Camera distance used for the scale calculation |
| pop | 40 px | 0–160 | Extra forward pop mid-swap |
| clearance | 56 px | 0–140 | Extra outward slide mid-swap |
| swing | 14° | 0–35 | Turn away from centre mid-swap |
| autoAdvance | false | — | Step to the next reel when the current one ends |

Reel size in the prototype is 208 × 370 px (9:16); scale it with the container rather than hard-coding it.

## Visual design

Style it with the j+k adventures design system: cream paper, EB Garamond, lowercase copy, a 1.5px ink pen outline and one balloon red element per view. If the repo already has these tokens, use them by name; otherwise define them as CSS variables.

| Token | Value | Used for |
| --- | --- | --- |
| surface | #f9f9f7 | Page ground; also the haze overlay on rear reels |
| surface-raised | #f4f3ef | Arrow buttons, reel caption panel, chips |
| ink | #3a3532 | Text, 1.5px outlines, icon strokes, active dot |
| ink-muted | #6a645e | Captions, counter, subtitle |
| honey-text | #8a5a1c | Eyebrow label |
| line-strong | #86807a | Arrow button border, inactive dots |
| cream-400 | #e5e3d9 | Progress track |
| accent (balloon red) | #bf5249 | Progress bar fill only (the one red element) |
| focus-ring | #10407b | 2px focus outline, 2px offset |

- **Type.** EB Garamond for everything. Eyebrow 15/18 weight 600, tracked 0.12em; title 40/44 weight 500; body 18/28; captions 14/20 weight 500. Nothing below 14px; everything lowercase.
- **Reel card.** 9:16, radius 20px, 1.5px ink border, shadow `0 2px 4px rgba(58,53,50,.06), 0 12px 28px rgba(58,53,50,.10)`. Inside: the video or thumbnail filling the card; a reel-number pill top-left; a caption panel at the bottom on surface-raised with a 1.5px ink top border holding avatar, handle, caption and (front only) the progress bar.
- **Controls.** Arrow buttons are 56px circles on surface-raised with a 1.5px line-strong border and a 24px chevron drawn with a 1.5px round ink stroke. Dots are 44 × 44 buttons with an 8px dot; the active one widens to a 24px ink pill.
- **Never.** Gradients, pure white or black, uppercase, bold for emphasis, emoji, or a second red element.

## Implementation plan

Build it as one self-contained component in whatever framework the site already uses, with placeholders first and real reels second.

1. **Data shape.** The component takes `reels: Array<{ id, thumbnailUrl, videoUrl?, permalink, caption?, username? }>`. Start with 8 placeholder items so the motion can be built and tuned before any Instagram work.
2. **Motion core.** Keep the angle, target, velocity and drag state in refs, not framework state. Run one `requestAnimationFrame` loop only while moving and write transforms straight to each reel element's style, so a frame does not re-render the component tree. Cancel the loop on unmount.
3. **Layout.** A stage element (`position: relative`, `touch-action: pan-y`, `user-select: none`) holds absolutely positioned reels centred on its middle. Use only `transform` and `opacity` for animation, with `will-change: transform` on reels.
4. **Controls.** Prev and next as real `<button>` elements with `aria-label`; dots as buttons with `aria-current`; the stage as `role="group"`, `aria-roledescription="carousel"`, `tabindex="0"`. Announce the change through a polite live region ("reel 3 of 8"). Mark non-front reels `aria-hidden`.
5. **Video playback.** Only the front reel plays; pause the others and reset them when they leave the front. Start muted with a visible unmute control (browsers block unmuted autoplay). Preload metadata only for neighbours, nothing for the rest.
6. **Reduced motion.** When `prefers-reduced-motion: reduce` is set, jump straight to the target angle, skip the swap swing, and do not autoplay video.
7. **Responsive.** Derive reel width from the stage width (for example `clamp(160px, 22vw, 260px)`) and recompute `Rx` from it. On phones, show fewer visible neighbours by lowering `spread`, and hide the arrow buttons below 480px if swipe is enough.
8. **Real reels.** Swap the placeholder data for the source chosen in the next section.

## Real Instagram reels

Decision: the reels come from our own Instagram account, so use Path A. Pull them through the Instagram API and play the video files in the reel door's own `<video>` elements. The official embed is kept only as a fallback for reels the API returns without a video file.

| Option | Whose reels | Plays inside our design? | What it needs | Main catch |
| --- | --- | --- | --- | --- |
| Instagram API (`/me/media`) | Only your own professional (business or creator) account | Yes: `media_url` is the video file, `thumbnail_url` the poster | A Meta app, Instagram login for the account, `instagram_business_basic` permission, a server that holds the token | `media_url` is left out when a reel has copyrighted material such as licensed music |
| Official embed (oEmbed + `embed.js`) | Any public post or reel | No: Instagram's own card in an iframe | Since 15 June 2026, no token or app for public content | Fixed Instagram card styling; our code can't control playback inside it; the iframe swallows drag gestures |
| Scraping or unofficial APIs | Any | Yes | — | Breaks Meta's terms and breaks often; do not use |

### Path A: our own account (chosen)

1. Our account is already a creator account, which the API supports, and the team has login access to it, so no conversion is needed. A person on the team signs in during the Meta app login step; never put the account's login details in code, the repo or this spec.
2. Create a Meta app with Business Login for Instagram, request `instagram_business_basic`, and exchange the login for a long-lived Instagram user token. Store it server-side only, and refresh it on a schedule before it expires.
3. Add a server route (for example `GET /api/reels`) that calls `/me/media?fields=id,media_type,media_product_type,media_url,thumbnail_url,permalink,caption,username,timestamp` and keeps `VIDEO` items. Meta's reference notes that `media_product_type` (which tells reels apart from feed videos) and `caption` are only returned when the app uses Instagram API with Facebook Login, so if you use Business Login for Instagram, filter on `media_type = VIDEO` instead.
4. Cache the response (for example for 15 to 60 minutes) so page views never hit Meta directly. Meta's reference doesn't say how long `media_url` links stay valid, so refetch on that schedule rather than storing them for good.
5. Map each item to the component's data shape. When `media_url` is missing, show the thumbnail and make the front reel open its `permalink`, or use the embed fallback below for that reel.

### The server piece on Cloudflare

The site is hosted on Cloudflare, so the server piece is a Cloudflare Worker route (or a Pages Function, whichever the repo already uses: check the existing `wrangler` config and folder layout first).

1. **Route.** `GET /api/reels` returns the cleaned list of reels as JSON in the component's data shape. The browser never sees the Instagram token.
2. **Token storage.** Keep the long-lived Instagram token in a Workers KV namespace (for example `REEL_STORE`), not hard-coded and not in the repo. Put the Meta app ID and secret in Worker secrets with `wrangler secret put`. The token lives in KV rather than a secret because the Worker must overwrite it when it refreshes, and a Worker can't change its own secrets.
3. **First token.** A one-time step: a team member signs in to Instagram through the Meta app's login, and the long-lived token it produces is written into KV. Add a small admin-only route or a one-off script for this, and ask before building it.
4. **Cache.** Store the last Instagram response in KV with a timestamp; serve it if it is under 30 minutes old, otherwise refetch from Instagram, save and serve. If Instagram fails, serve the last saved copy rather than an error.
5. **Refresh.** Add a Cron Trigger (for example weekly) that refreshes the long-lived token and writes the new one back to KV, so it never reaches its roughly 60-day expiry.
6. **Local dev.** Use `wrangler dev` with a local KV namespace and the placeholder reels, so the component can be built without touching the live account.

### Fallback: official embed for reels without a video file

1. Use this only for reels whose API result has no media\_url; take the reel URL from its permalink.
2. On the server, call `https://graph.facebook.com/<version>/instagram_oembed?url=<reel url>` and cache the returned `html`. No token is needed for public content since 15 June 2026, but tokenless calls may have lower rate limits.
3. In the ring, show a styled placeholder or poster for each reel. Mount the embed HTML (and load `embed.js` once) only inside the front reel after it settles. Unmount it when it leaves the front.
4. Keep the drag working: while a reel is not at the front, cover it with a transparent layer that catches pointer events. Expect the embed to look like Instagram's card, not our cream card, and to need more height than 9:16.

Either way, show only reels you have the right to show, and link each one back to its Instagram post.

## Acceptance checklist

- [ ] Dragging left brings the next reel forward; dragging right brings the previous one; the front reel tracks the pointer
- [ ] A quick flick coasts past up to 3 reels and settles with a soft spring
- [ ] Two reels never slice through each other at any point in a swap, in either direction
- [ ] At rest every reel faces forward and the front reel slightly overlaps its neighbours
- [ ] Arrows, Left/Right keys, dots and tapping a reel all work, and rapid arrow clicks queue
- [ ] Vertical page scroll still works on touch devices over the stage
- [ ] Only the front reel plays video; it starts muted and pauses when it leaves the front
- [ ] Holds 60 fps on a mid-range phone; no component re-render per animation frame
- [ ] Screen reader hears "reel 3 of 8" on change; all controls reachable by keyboard with a visible focus ring
- [ ] With reduced motion on, changes jump without animation and nothing autoplays
- [ ] Matches the j+k adventures tokens: cream, EB Garamond, lowercase, 1.5px ink outlines, one red element

## Open questions

- Settled: the doc's author has access, and will create the Meta developer app and do the first sign-in when Claude Code reaches that step (creator account confirmed).
- Confirm in the repo whether the site uses Cloudflare Workers or Pages Functions (hosting confirmed: Cloudflare).
- Should the reel door be full-width on phones, and do the arrows stay on mobile?

## Sources

- [Meta: IG Media reference (fields, permissions, copyrighted audio)](https://developers.facebook.com/docs/instagram-platform/reference/instagram-media)
- [WP Mayor: Meta's tokenless oEmbed change, 15 June 2026](https://wpmayor.com/meta-tokenless-oembed-wordpress/)
- [Spotlight: what Meta's 2026 tokenless change means](https://spotlightwp.com/?p=429941)
- [Smash Balloon: Basic Display API shutdown](https://smashballoon.com/instagram-is-shutting-down-basic-display-api-continue-displaying-instagram-feeds-on-your-site/)
