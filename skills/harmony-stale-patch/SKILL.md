---
name: harmony-stale-patch
description: Draft a reconciliation patch for a ticket gone Stale because a knowledge decision it depends on was superseded (state-machine §6.4). Triggers on "patch the stale ticket", "harmony stale-patch B-123", "reconcile B-123 against the superseding decision", or being delegated a Stale item by harmony-next. Reads the superseded decision + its successor, drafts a concrete proposed patch (knowledge reconciliation and/or a state re-work), and files it as a stale-patch-review brief for the human to accept or reject.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Stale-Patch

Implements the §6.4 **agent patch step** of the Stale loop. When a knowledge decision is superseded
(`supersede_decision`), P2's trigger flags every dependent ticket `stale=true` and writes
`stale_ref = { type:'decision', id:<superseded>, superseded_by:<successor> }` (P2 A8) — but the flag alone
just tells the human "this is stale." This skill is the agent that **drafts a concrete proposed patch** and
files it as a `stale-patch-review` brief so the human can accept (apply) or reject (knowing-divergence). It
never edits code (discovery role): it produces a *proposed reconciliation*, not an implementation.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## Flow

### 1. Load the Stale ticket + its supersession context

`mcp__harmony__get_task({ task_id })` (or, picking one up, `mcp__harmony__query_tasks({ stale: true,
sort_by: 'priority', limit: 1 })`). Confirm `stale === true`. Read `stale_ref` — it names the **superseded**
decision (`stale_ref.id`) and its **successor** (`stale_ref.superseded_by`). Pull both entries
(`mcp__harmony__get_knowledge_entry`) so you can see exactly what changed: the old decision the ticket was
built on, and the new one that replaced it.

Also read the ticket's current `workflow_state` and the knowledge it references:

```
const refs = mcp__harmony__list_ticket_knowledge({ task_id })
// every decision THIS ticket depends on, with type + status — the surface the supersession invalidated
```

### 2. Query relevant domain knowledge

Per the discipline, query the domain(s) of the superseded decision (`mcp__harmony__query_knowledge({ domain:
[...], search: "<subject>" })`) so the patch is grounded in current knowledge, not just the diff between the
two entries. Surface any gap explicitly; if a load-bearing gap blocks the patch, go research-first
(`/harmony-plugin:harmony-research`) before drafting.

### 3. Draft a concrete proposed patch

Decide what reconciliation the supersession actually requires. Two (non-exclusive) shapes:
- **Knowledge reconciliation** — the ticket's referenced decision is now out of step with the successor;
  propose the corrected understanding (and, if a new ticket-level decision is warranted, describe it — but
  do NOT author it here; the human applies the patch). Pure knowledge patches do **not** revert state.
- **State re-work** — the supersession invalidates work the ticket already passed (e.g. a Designed ticket
  whose technical-design decision was superseded needs re-design). Propose a backflow to the right activity
  (a `revising-*`), so accepting the patch re-opens the ticket at the correct state.

The patch is a **proposal**, concrete enough that the human can say yes/no — not a vague "this is stale."

### 4. Compose the stale-patch-review brief

File the patch as a brief. Setting `pending_activity` to a `revising-*` activity **iff the patch reverts
state** (accept backflows the ticket through P3's existing `resolve_brief` path); otherwise `null`
(knowledge-only reconciliation — accept just clears Stale, no state change):

```
mcp__harmony__compose_brief({
  task_id,
  reason: "stale-patch-review",
  pending_activity: <a "revising-*" activity IF the patch reverts state, else null>,
  decision_ref: { type: "<successor type>", id: stale_ref.superseded_by },   // the superseding decision (optional, for linkage)
  doc: {
    decide: "Reconcile B-288 against the superseding 'harmony-web CI/CD' decision?",
    recommend: { text: "Re-open at Designed and redo the deploy-step technical-design", confidence: "low" },
    why: ["The CI/CD decision this ticket built on was superseded", "The new flow changes the deploy step"],
    items: [
      { kind: "decision", text: "Apply the reconciliation (backflow to Designed)", recommendation: "accept" }
    ]
  }
})
```

`compose_brief` sets `awaiting_human_input=true` + `awaiting_human_reason='stale-patch-review'`, so the
ticket now appears in **both** queue reads — the `awaiting_human_input` read (it has a brief now) and the
`stale` read (still flagged) — `harmony-queue`/`harmony-next` de-dupe by id. The §3.2 lint applies as usual.

### 5. Display + resolve

Show the rendered `content` verbatim. On the human's command:
- **accept** → `mcp__harmony__resolve_brief({ task_id, command: 'accept' })`. P3's extended `resolve_brief`
  clears the Stale flag (`tasks.stale=false, stale_ref=NULL`) on a `stale-patch-review` resolution, and — if
  the brief carried a `revising-*` `pending_activity` — **backflows state** through the existing path. Report
  the cleared flag + the new `workflow_state` (if it changed).
- **defer** → `mcp__harmony__resolve_brief({ task_id, command: 'defer', detail: '<why diverging>' })`. For a
  `stale-patch-review` brief, **defer means reject / knowing-divergence**, not park: P3's `resolve_brief`
  clears the Stale flag and records the rejection in `resolved_detail` (`knowing-divergence: <why>`), but does
  **NOT** Park the ticket (it keeps its current state — the human knowingly accepts the divergence). This is
  the §6.4 "human rejects → Stale clears, marked knowing-divergence" path, mapped onto the command set (there
  is no `reject` command — reject = this scoped `defer`).
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise the proposed patch and re-call `compose_brief` (updates in place, bumps
  `iteration`).

### 6. Report

State whether the patch was applied (Stale cleared; new state if backflowed) or rejected as a knowing
divergence (Stale cleared; state unchanged). Either way the ticket leaves the Stale queue.
