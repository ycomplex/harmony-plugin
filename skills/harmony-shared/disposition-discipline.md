# Disposition discipline (cross-gate)

When you work a ticket through a gate (build, release, code-review) you will surface items that are **not** part of the ticket's accepted scope — an adjacent bug, a refactor, a nice-to-have, a review nit. **Do NOT auto-mint a standalone ticket for each one.** A by-product of work becoming a standalone first-class ticket, with no fix-first or triage gate, is the single largest source of board bloat. But the opposite failure is just as real: a deferred item left as a **note** nobody watches is *recorded but not tracked*. Force a disposition that ends **every** item somewhere tracked.

## The rollup is a within-run BUFFER, not a resting place

**1. Fix-first.** If the item is trivial, in-scope, or fixable in the same PR → **fix it inline now** (or record an explicit human waiver not to). The default for a small adjacent item discovered mid-build is to fix it in the same PR, not file it.

**2. Otherwise → accumulate on a live host that WILL reach a release gate.** Split umbrellas, decision-only hosts completing at a deliverable gate, Parked and Cancelled tickets cannot host the buffer. Route findings to the live release-bearing ticket whose gate is next, or drain them as the host leaves the flow. Verify that destination is live with `get_task`. This is one no-release-gate rule, not per-class lifecycle machinery; umbrella auto-advance is unchanged.

Use append-only `add_comment` snapshots with this exact first-line protocol (no Markdown heading prefix):

```text
Follow-ups rollup v1 id=<key>
- [do-now] id=<item-key> <text>
- [defer-with-trigger] id=<item-key> <text including trigger>
- [drop] id=<item-key> <text including reason>
```

Keys contain lowercase letters, digits and hyphens, beginning with a letter or digit. Each item ID is unique within its full snapshot. Working tags mean fixed this run (`do-now`), revisit when the stated condition occurs (`defer-with-trigger`), or won't do with a reason (`drop`). Updating a buffer appends a complete replacement snapshot with the same rollup key. Never rewrite another author's comment.

To drain, append a comment whose first line is exactly:

```text
Follow-ups rollup drained v1 id=<key>
```

Follow that line with every item ID, one terminal disposition and its evidence/destination or drop reason. The latest event by `(created_at, comment UUID)` for the same host plus rollup key wins. A drain for another key closes nothing. New findings after a drain use a new key. Legacy/malformed rollup-looking headings require explicit reconciliation of their source comments; never treat unknown counts as zero or silently auto-drain them.

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

**Also audit for cross-ticket completion.** The same release gate asks one more question: *did this run's work also complete another **open** ticket?* That is a **distinct axis** from this within-run item buffer — it retires *another existing ticket*, not a surfaced item — so it lives in `skills/harmony-shared/ticket-disposition.md` (**"Reconciling a ticket another run already finished"**): subsume-if-complete / annotate-if-unsure, surfaced on the same release brief for the human to confirm.

## Why
This attacks bloat from both ends: don't reflexively mint, **and** actively fold what does warrant tracking into a home that *gates completion* (AC / scope-item / subsume) — while never letting real deferred work rest as a note (**recording ≠ tracking**). It is a **convention over existing tools** (`add_comment`, `find_related_tickets`, `subsume_task`, ticket acceptance criteria) — not a board feature, no new schema.

## Adjacent axis
`skills/harmony-shared/ticket-disposition.md` is the adjacent axis — how to **retire an existing ticket** (subsume vs cancel+archive), keyed on *does the work continue?* This doctrine decides what a surfaced *item* becomes; that one decides an existing ticket's end-state.

## Project-specific bindings
This discipline is **portable**. WHERE a given workspace routes specific follow-up streams (e.g. a dedicated running-log lane for usage/dogfood findings) is a **project-specific binding** — see the workspace's `CLAUDE.md`, not this file.


When choosing an epic, filter `list_epics` to `retired_at == null` (missing means active during schema compatibility). Retired epics are historical lookup only; never assign new work to them.

## Milestone ship backstop

Web, CLI and agent shipping use the same permission-checked database scan over all pre-ship milestone members, including archived, Verified, Cancelled and hosts removed by that ship. It reports each undrained host, item count and working tags, with scanned-host count and explicit empty success. Missing capability, failed/incomplete scans and unresolved legacy/malformed records prevent ship mutations. The web requires acknowledgement of undrained items; changed results clear that acknowledgement and require review again. This reports residual bookkeeping without adding an umbrella advance blocker.
