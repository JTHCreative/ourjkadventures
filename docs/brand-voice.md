# Brand voice and design

The north star is `manifesto.md`. Its test applies to every page and every line of copy:
*Would someone who genuinely loves this thing be delighted we made it?*

## How we sound
Like justin and kitty talking to you across the table at a craft fair. Casual, homey and conversational:
real people telling you about something they made, not a brand writing poetry. If a line sounds like it
belongs on a gallery wall, say it the way you would to a friend instead.

The about page is the reference for this voice:
> we're justin and kitty, the j and k behind j+k adventures! this story started on the road.

- **Talk like a person.** Say "we", "us" and "you". Contractions are good ("we're", "it's", "you'll").
  Everyday words over clever ones. It's fine to share a little of our own story and feelings.
- **Warm and sincere.** A friend who loves the same thing. Excited is fine when we really are; never hype.
- **Specific beats generic.** Name the breed, the place, the thing.
- **Not cold, not poetic.** Avoid clipped, moody fragments ("inside. out.") and lofty lines that keep the
  reader at arm's length. A full, friendly sentence is better than a striking one.

## Copy rules
- **Lowercase** everywhere a customer reads it: headings, buttons, errors, emails. Brand name is "j+k adventures".
- **Exclamation marks: fine in friendly text, not in big headings.** Use them where a person would, in
  story paragraphs, personal notes, thank-yous and small details ("we hope they do the same for you!").
  Keep them out of page titles and large display headings (`h1`, `h2`, `.display`, the `<title>`), which
  end in a period. Don't stack them ("!!") and don't use them to push a sale. The "woof!" bubble, the
  "i'm interested!" button and the "it's here!" email stay as they are. (Owner's call, 2026-11-04.)
- **No sales or urgency language.** Never: sale, deal, % off, hurry, limited time, don't miss out, obsessed, cute!!, best seller.
  Being excited about a pin is fine; pressuring someone to buy one is not.
- **Buttons and short labels stay short and plain**, often as a little sentence ("in your bag.", "one moment.").
- **Errors are calm and helpful**, and offer the email: "we couldn't start checkout. try again, or write to us at support@ourjkadventures.com."

### Examples
| Good | Why |
|---|---|
| "we're justin and kitty, the j and k behind j+k adventures!" | personal, friendly, sounds like us |
| "thank you for being a part of our journey. we're excited to help you share yours." | warm and direct |
| "sixteen dogs, one pin each. $12. pick a pup to meet them." | specific, plain price, no push |
| "your bag is empty. a pin would look good in it." | warm, no pressure |
| "the pack is out for a walk. check back soon." | a gentle error with character |

| Avoid | Why |
|---|---|
| "inside. out." | too clipped and poetic, says little |
| "a little flag that says, this one is mine." | lovely, but reads like a poem, not a chat |
| "don't miss out!!" | urgency and stacked exclamation marks |
| "THE THINGS YOU LOVE!" as a page heading | big headings stay lowercase and end in a period |

## Design rules
- Use the CSS variables in `styles.css`. Main ones: `--surface` (cream page), `--ink` (text), `--accent` (balloon red, primary buttons), `--honey` (tags, counts), `--cobalt` (links, focus ring), `--space-1`…`--space-8`, `--radius-sm/md/lg/pill`, `--shadow-card`.
- EB Garamond for everything. Generous spacing. Paper-like grain on the page background.
- One glowing "hero pin" per view at most (`.jka-glow`).
- Buttons: `.jka-btn` (filled), `.jka-btn--quiet` (outline), `--sm` size.
- Motion is gentle (hover wiggle, auto-rotate in 3D) and turns off under `prefers-reduced-motion`.
- Must work at 360px wide with no horizontal scroll. Icon buttons always have an `aria-label`.
- Links are never smaller than the body text, 18px (back links like "← all of the shop" and the sign-in links are 19px). EB Garamond runs small, so a 14px or 16px link is hard to read for anyone whose eyes aren't perfect. A link inside small print grows to 18px; the small print around it can stay smaller.
