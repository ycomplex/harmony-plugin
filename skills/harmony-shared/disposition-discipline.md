# Disposition discipline (cross-gate)

When you work a ticket through a gate (build, release, code-review) you will surface items that are **not** part of the ticket's accepted scope — an adjacent bug, a refactor, a nice-to-have, a review nit. **Do NOT auto-mint a standalone ticket for each one.** A by-product of work becoming a standalone first-class ticket, with no fix-first or triage gate, is the single largest source of board bloat. But the opposite failure is just as real: a deferred item left as a **note** nobody watches is *recorded but not tracked*. Force a disposition that ends **every** item somewhere tracked.

## The rollup is a within-run BUFFER, not a resting place

**1. Fix-first.** If the item is trivial, in-scope, or fixable in the same PR → **fix it inline now** (or record an explicit human waiver not to). The default for a small adjacent item discovered mid-build is to fix it in the same PR, not file it.

**2. Otherwise → accumulate it in the per-parent "Follow-ups rollup" (a within-run buffer).** Do NOT create a ticket yet. The rollup is a single consolidated **comment** on the ticket being worked (`add_comment`), posted by the **main session** at the release gate, alongside the B-560 build-evidence comments. Accumulate follow-ups in-session and tag each with a *working* tag:
- `do-now` — fixed this run/PR;
- `defer-with-trigger` — revisit when <condition>;
- `drop` — won't do (record why).

These tags describe an item **mid-run**; **they are not terminal states.** Consolidate *within* the rollup: group related follow-ups into one entry rather than listing near-duplicates separately.

## At run-end (release gate): DRAIN the buffer — every item resolves to a terminal outcome

The rollup is **drained at the release gate**. **Every** buffered item MUST resolve to exactly one of **four terminal outcomes — nothing may persist as a note:**

1. **fix-inline** — fixed this run/PR (or an explicit human waiver). [`do-now` lands here.]
2. **fold-into-existing** — attach to something that **gates the host ticket's completion**: an **acceptance criterion or explicit scope item** on a live ticket, or `subsume_task` into a sibling/umbrella that already covers it. A **bare comment is NOT a valid fold** — a comment gates nothing and is lost the same way a note is; if the item is non-actionable context, it is a `drop-with-reason`.
3. **drop, with a one-line reason** — a genuine non-issue; the reason is **REQUIRED** (this is the bloat guard — a dropped item leaves a *why*, not a ticket). [`drop` lands here.]
4. **file-a-ticket** — anything real and deferred that isn't 1–3: mint a standalone ticket.

The three working tags map onto these outcomes: `do-now` → **fix-inline**, `drop` → **drop-with-reason**, and `defer-with-trigger` → **fold-into-existing OR file-a-ticket**.

**`defer-with-trigger` is NOT a terminal disposition.** At run-end it resolves to **fold-into-existing** (an AC / scope-item / `subsume_task`, per outcome 2) or a **low-priority backlog ticket whose body states the trigger** ("Revisit when <condition>"). The trigger concept survives — it just lives *on* a tracked ticket, not *instead of* one. A note on a rollup comment — especially on a ticket that then goes Verified — is surfaced by no working view and watched by no trigger: **recording ≠ tracking.**

**Triage-and-consolidate governs outcome 2 (fold) vs 4 (file)** — consolidation is the default, minting the exception. For each item run the dedup/fold check (`find_related_tickets`) and prefer, in order:
- **fold** → extend an existing related/umbrella ticket's scope (as an AC / scope item) and `subsume_task` the item into it;
- **dedupe** → an existing ticket already covers it → close the rollup item with a pointer to that ticket;
- **mint a NEW standalone ticket ONLY when genuinely novel** — nothing existing covers it.

## Release-gate audit (drain → surface → verify)

Draining happens **at the release gate**, and the drained buffer is **surfaced on the release brief for human review**: list each item with its terminal resolution — filed (with ticket IDs), folded (into which tickets, as AC / scope-item / subsume), or dropped (with reasons). The human can **veto a drop or upgrade a fold to a file** before verify. Only after the buffer is drained and reviewed does the run proceed to verify. **Drain → surface → verify.**

## Why
This attacks bloat from both ends: don't reflexively mint, **and** actively fold what does warrant tracking into a home that *gates completion* (AC / scope-item / subsume) — while never letting real deferred work rest as a note (**recording ≠ tracking**). It is a **convention over existing tools** (`add_comment`, `find_related_tickets`, `subsume_task`, ticket acceptance criteria) — not a board feature, no new schema.

## Project-specific bindings
This discipline is **portable**. WHERE a given workspace routes specific follow-up streams (e.g. a dedicated running-log lane for usage/dogfood findings) is a **project-specific binding** — see the workspace's `CLAUDE.md`, not this file.
