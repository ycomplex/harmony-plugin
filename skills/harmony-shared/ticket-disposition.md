# Ticket disposition (how to retire an existing ticket)

When you — agent, or human-via-agent — **RETIRE** a ticket, the end-state is keyed on ONE question: **does the work continue?** Answer that and the disposition follows. Do NOT free-style between archive-only, cancel-only, and cancel-then-archive; pick from the tree below.

## The decision tree

Ask *does the work continue, and where?*

- **Work continues under an ABSORBING ticket** — this ticket is folded / deduped *into* it → **Subsume**.
- **Work continues under a DIFFERENT parent** — re-homed, not absorbed → **Reparent**. *NOT a disposal — the ticket stays live.*
- **Deferred, might return** — paused, not killed → **Park**. *NOT a disposal — deferred ≠ killed.*
- **Won't be done** — irrelevant / obsolete / decided-against / a discarded orphan → **Drop**.

Only **Subsume** and **Drop** actually retire a ticket. **Reparent** and **Park** keep it live; they are in the tree so you don't mis-file a still-living ticket as dead.

## Subsume — work continues under an absorber

The work is **being done**, under the ticket that absorbs this one — so "won't be done" is false, and a Cancel would misrepresent it.

```
subsume_task({ task_id, subsumed_by_task_id, reason })
```

- Sets `subsumed_by_task_id`, **archives** the ticket, and logs `task_subsumed`.
- **KEEP its own `workflow_state` — never additionally Cancel it.** The work lives on in the absorber; Cancelling would assert the opposite.
- **Reversible** via the B-629 un-fold — `update_task` nulling `subsumed_by_task_id` (and un-archiving) restores it.

Use when you fold or dedupe a ticket into an existing / umbrella ticket that now carries its scope.

## Drop — won't be done (cancel-with-reason, THEN archive)

The work is genuinely dead: irrelevant, obsolete, decided-against, or a discarded orphan. Retire it in **this order** — cancel first to record the reason, then archive to clear it from active views:

1. `advance_workflow({ task_id, activity: 'cancelling' })` → `workflow_state = Cancelled`.
2. `add_comment({ task_id, body: 'Cancelled — <why>' })` — **durably record the reason.** `advance_workflow` has NO reason field; the comment IS the reason-capture mechanism. Do not skip it.
3. `update_task({ task_id, archived: true })` — remove it from active views.

**Never archive-only** — an archived-but-not-Cancelled ticket still reads as a *live* `workflow_state` (it is merely unlisted) AND loses the *why*. **Never cancel-only** — a Cancelled-but-not-archived ticket clutters active views. Drop is always **both, in this order.**

## Reparent / Park — NOT disposals

Neither retires the ticket; both are in the tree to stop you mis-filing a living ticket as dead.

- **Reparent** — the work is real and continues, just under a different parent (re-homed, not absorbed *into* it). `update_task({ task_id, parent_task_id: <new-parent> })`, or `manage_subtasks` on the new parent. The ticket stays live at its current `workflow_state`.
- **Park** — deferred, might return. Use the existing defer path (the ticket lands in **Parked**). Deferred ≠ killed; never Cancel a ticket you are merely deferring.

## Where this fires

Three surfaces all follow THIS convention:

1. **harmony-conduct disposal points** — a fold/dedup → **Subsume**; an "obsolete, don't proceed" → **Drop** (cancel+archive); a defer stays **Parked**.
2. **harmony-revise-scope child-disposition guard** (the B-473 two-tier policy) — a work-less orphan is auto-**Dropped** (cancel+archive); a work-bearing child's "discard its work" option is **Drop**, while **reparent** keeps the child live. (That skill's separate "abort the revert" option is NOT a disposition — it abandons the whole operation.)
3. **The general conversational "we decided to drop this"** — same tree: does the work continue? Subsume / Reparent / Park / Drop accordingly.

## Reconciling a ticket another run already finished

A distinct case from the tree above: your run's work **incidentally completed a *different*, already-open ticket** — not one you set out to retire, one your change happened to deliver. If you don't reach out and close it, it sits open and **stale**, still describing itself as broken. (The B-582/B-629 miss: B-629's commit fully fixed B-582, but B-582 sat Captured-and-stale for a day.) This is a **write-then-honor loop** across two gate touchpoints, and it **reuses Subsume** above — no new primitive.

### Touchpoint 1 — the covering run's release gate (writes the flag)

As part of the **release-gate audit** (`skills/harmony-shared/disposition-discipline.md`), ask one more question: *did this run's work fully or partially complete any **other** open ticket?* Seed the answer by scanning the branch's commits for `[B-XXX]` tags other than the ticket being released:

```
git log --format='%s%n%b' origin/main..HEAD | grep -oE '\[B-[0-9]+\]'
```

Each distinct other-ticket is a **candidate covered ticket**. `get_task` each one and decide (release is a human hard-floor, so surface the candidates + a recommended disposition on the release brief and let the human confirm):

- **Completely covered →** **Subsume** it into the covering ticket (`subsume_task`, per the Subsume section above — keeps its `workflow_state`, archives, reversible via the B-629 un-fold).
- **Coverage uncertain →** do **not** subsume. **Annotate** the *covered* ticket's description with a machine-recognizable forward-flag — append via `update_task`, never clobber the body:

  ```
  ## ⚠ Possibly subsumed
  possibly-subsumed-by: B-XXX — confirm at clarify/design (flagged by <covering> release audit, <date>)
  ```

  This defers the judgment to that ticket's own gate.
- **Not covered →** nothing.

Conservative bias: subsume+archive only on a **clear** cover — a wrong subsume+archive hides live work. When unsure, annotate and let the covered ticket's own gate decide.

### Touchpoint 2 — the covered ticket's own clarify / design gate (honors the flag)

Before drafting at a ticket's clarify or design gate, reconcile whether its work is **already done**:

1. **Honor a `possibly-subsumed-by` annotation** if the description carries one: grep the description for the `possibly-subsumed-by:` token, `get_task` the named covering ticket; if its work covers this ticket → `subsume_task(this, covering)` and **stop the gate** (don't rebuild). Otherwise clear/note the flag and proceed with the genuine remainder.
2. **Independently — even with no annotation — check for a Verified/Deployed sibling** that already covers this ticket. **You cannot use `find_related_tickets` for this** (see the rationale below). Use **`search_tasks`** (lexical; it does **not** filter by `workflow_state`, so it reaches done work) with this ticket's title + intent, keep hits whose `workflow_state ∈ {Verified, Deployed}`, and judge whether a high-similarity hit already delivered this work → subsume if so, else proceed.

### Why the explicit flag + `search_tasks` check — and not just `find_related_tickets`

`find_related_tickets` **deliberately excludes Verified/Deployed** (B-581/B-574 — its clarify fold card surfaces only *open*, foldable candidates; `EXCLUDED_WORKFLOW_STATES` in `src/tools/find-related-tickets.ts`). So a **done** ticket that already did this work is **invisible** to the normal dedup card. The forward-flag annotation (written *across* that exclusion at touchpoint 1) and the explicit `search_tasks` Verified-sibling check (touchpoint 2) are the two bridges over it. This is the **mechanism, not a ritual**: without them, B-582 is rebuilt from scratch because the Verified B-629 never surfaces.

## Adjacent axis

`skills/harmony-shared/disposition-discipline.md` is the **adjacent** axis. That doctrine governs **what a surfaced run ITEM becomes** (fix-first / follow-ups rollup / fold-dedupe-mint). THIS one governs **how to RETIRE an existing ticket.** Read them together: disposition-discipline decides whether a newly-found item earns a ticket at all; ticket-disposition decides the end-state when an existing ticket must be retired.
