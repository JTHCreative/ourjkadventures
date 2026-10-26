# First prompt for Claude Code

Paste everything below the line into Claude Code after the repo is on GitHub and open in Claude Code.

---

You're joining the j+k adventures repo. This is the website and shop for my small enamel pin business.
I'm the owner, not a full-time developer, so explain things plainly and use an everyday analogy when
something is technical.

Start by reading `CLAUDE.md`, then `docs/architecture.md`, `docs/roadmap.md`, `docs/brand-voice.md`
and `docs/decisions.md`. Skim `docs/manifesto.md` and `docs/pricing-and-loyalty.md`. They're why the
site sounds and behaves the way it does.

Then:
1. Tell me in a few sentences what you understand the site to be and how it works today. Flag anything in the docs that looks wrong, out of date or contradictory.
2. Run the site locally (`npx wrangler pages dev site`) and do the checks in CLAUDE.md that don't need Square keys. Report what passes and what doesn't.
3. Write a plan for **Phase 1 (port to Astro with no visible changes)**: the folder layout, which pieces become components, what stays vanilla JS, how checkout moves from `_worker.js` to `functions/`, how you'll prove nothing changed visually, and what I need to change in Cloudflare. List any questions.

Don't change any files yet. Wait for me to approve the plan.
