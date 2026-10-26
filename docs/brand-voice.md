# Brand voice and design

The north star is `manifesto.md`. Its test applies to every page and every line of copy:
*Would someone who genuinely loves this thing be delighted we made it?*

## Copy rules
- **Lowercase** everywhere a customer reads it: headings, buttons, errors, emails. Brand name is "j+k adventures".
- **No exclamation marks.** (Exception: the pup board's speech bubble, `<breed> woof!`, because the dog is talking.)
- **No sales or urgency language.** Never: sale, deal, % off, hurry, limited time, don't miss out, obsessed, cute!!, best seller.
- **Warm, sincere, adult.** A friend who loves the same thing, not a brand performing excitement.
- **Specific beats generic.** Name the breed, the place, the thing.
- **Short sentences that end in a period**, including buttons in sentence form ("in your bag.", "one moment.").
- **Errors are calm and helpful**, and offer the email: "we could not start checkout. try again, or write to us at ourjkadventures@gmail.com."

### Examples from the live site
| Good | Why |
|---|---|
| "inside. out." | short, sincere |
| "sixteen dogs, one pin each. $12. pick a pup to meet them." | specific, plain price, no push |
| "your bag is empty. a pin would look good in it." | warm, no pressure |
| "a pin that stays in a drawer is not doing its job." | straight from the manifesto |
| "the pack is out for a walk. check back soon." | a gentle error with character |

## Design rules
- Use the CSS variables in `styles.css`. Main ones: `--surface` (cream page), `--ink` (text), `--accent` (balloon red, primary buttons), `--honey` (tags, counts), `--cobalt` (links, focus ring), `--space-1`…`--space-8`, `--radius-sm/md/lg/pill`, `--shadow-card`.
- EB Garamond for everything. Generous spacing. Paper-like grain on the page background.
- One glowing "hero pin" per view at most (`.jka-glow`).
- Buttons: `.jka-btn` (filled), `.jka-btn--quiet` (outline), `--sm` size.
- Motion is gentle (hover wiggle, auto-rotate in 3D) and turns off under `prefers-reduced-motion`.
- Must work at 360px wide with no horizontal scroll. Icon buttons always have an `aria-label`.
