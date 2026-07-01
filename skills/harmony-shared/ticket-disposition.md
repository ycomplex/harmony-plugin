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

## Adjacent axis

`skills/harmony-shared/disposition-discipline.md` is the **adjacent** axis. That doctrine governs **what a surfaced run ITEM becomes** (fix-first / follow-ups rollup / fold-dedupe-mint). THIS one governs **how to RETIRE an existing ticket.** Read them together: disposition-discipline decides whether a newly-found item earns a ticket at all; ticket-disposition decides the end-state when an existing ticket must be retired.
