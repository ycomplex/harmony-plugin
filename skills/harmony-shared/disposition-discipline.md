# Disposition discipline (cross-gate)

When you work a ticket through a gate (build, release, code-review) you will surface items that are **not** part of the ticket's accepted scope — an adjacent bug, a refactor, a nice-to-have, a review nit. **Do NOT auto-mint a standalone ticket for each one.** A by-product of work becoming a standalone first-class ticket, with no fix-first or triage gate, is the single largest source of board bloat. Force a disposition instead.

## The disposition

**1. Fix-first.** If the item is trivial, in-scope, or fixable in the same PR → **fix it inline now** (or record an explicit human waiver not to). The default for a small adjacent item discovered mid-build is to fix it in the same PR, not file it.

**2. Otherwise → append it to the per-parent "Follow-ups rollup".** Do NOT create a ticket. The rollup is a single consolidated **comment** on the ticket being worked (`add_comment`), posted by the **main session** at the release/verify gate, alongside the B-560 build-evidence comments. Accumulate follow-ups in-session and post ONE consolidated "Follow-ups rollup" comment. Tag each item:
- `do-now` — fixed this run/PR;
- `defer-with-trigger` — revisit when <condition>;
- `drop` — won't do (record why).

Consolidate *within* the rollup: group related follow-ups into one entry rather than listing near-duplicates separately.

**3. Triage-and-consolidate — the rollup is a consolidation funnel, not a holding pen.** Only an explicit triage step moves a `defer-with-trigger` item out of the rollup, and **consolidation is the default outcome; minting a new ticket is the exception.** For each item, run the dedup/fold check (`find_related_tickets`) and prefer, in order:
- **fold** → extend an existing related/umbrella ticket's scope and `subsume_task` the item into it;
- **dedupe** → an existing ticket already covers it → close the rollup item with a pointer to that ticket;
- **mint a NEW standalone ticket ONLY when genuinely novel** — nothing existing covers it.

## Why
This attacks bloat from both ends: don't reflexively mint, **and** actively fold what does warrant tracking into existing homes. It is a **convention over existing tools** (`add_comment`, `find_related_tickets`, `subsume_task`) — not a board feature, no new schema.

## Project-specific bindings
This discipline is **portable**. WHERE a given workspace routes specific follow-up streams (e.g. a dedicated running-log lane for usage/dogfood findings) is a **project-specific binding** — see the workspace's `CLAUDE.md`, not this file.
