---
name: harmony-queue
description: Show what's awaiting ME — the opinionated-mode pull queue. Triggers on "my queue", "what's awaiting me", "what should I look at", "harmony queue", "what needs my input". Read-only conductor view that lists every ticket where the ball is in the human's court, with its one-line decision and brief reason.
allowed-tools: mcp__harmony__* Read Grep Glob
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Queue

The pull-based conductor view (agent-model §5): *what is awaiting you, prioritised, with briefs ready.*
This is read-only — it never advances state. To act on an item, run `/harmony-plugin:harmony-next`
(picks the top item) or the activity skill the item points to.

## Flow

### 1. Confirm the project is in opinionated mode

Call `mcp__harmony__get_project`. If `mode !== 'opinionated'`, tell the user the queue is an
opinionated-mode feature and stop — manual-mode projects use the normal board.

### 2. Pull both queue signals (two reads — they are set independently)

The queue is the union of **two** flags (state-machine §6.4–§6.5), set by different triggers:

```
const awaiting = mcp__harmony__query_tasks({ awaiting_human_input: true, sort_by: "priority" })
const stale    = mcp__harmony__query_tasks({ stale: true,               sort_by: "priority" })
```

**Why two reads:** P2's supersession trigger sets `stale`/`stale_ref` **only** — it does NOT set
`awaiting_human_input` (P2 A8). A freshly-Stale ticket therefore has the Stale flag but no awaiting flag and
no brief *until* the patch author (`/harmony-plugin:harmony-stale-patch`, Task E2) runs and composes its
`stale-patch-review` brief — after which it carries **both** flags and appears in both reads. So an
`awaiting_human_input` read alone would miss every not-yet-patched Stale ticket. (A ticket can appear in both
lists; de-dupe by id.)

Awaiting tasks carry `workflow_state`, `awaiting_human_reason`, `awaiting_human_ref`, `priority`, `title`.
The `awaiting_human_reason` is the grouping key (state-machine §6.5): `clarification-draft`,
`decomposition-proposal`, `design-decision-draft`, `plan-draft`, `release-decision-pending`,
`verification-ack-pending`. Stale tasks carry `stale_ref` (which superseded entry invalidated them).

### 3. Fetch each awaiting brief's one-line decision

For each **awaiting** task, call `mcp__harmony__get_brief({ task_id })` and read `doc.decide` (the BLUF
one-liner) + `iteration`. If a task has no active brief (e.g. `release-decision-pending` set before a
brief was composed), fall back to `awaiting_human_reason`. A Stale task that has **not** yet been patched has
no brief — describe it from `stale_ref` and point at `/harmony-plugin:harmony-next` (which delegates to the
patch author). A Stale task that already carries a `stale-patch-review` brief has its patch decision in
`doc.decide` like any other awaiting item.

### 4. Render the queue — awaiting grouped by reason, Stale grouped on its own

```
Awaiting you (3):

CLARIFICATION
  B-316  Saved Filter state            [Proposed]   "Is a saved filter per-user or shared?"   → /harmony-next

RELEASE DECISION
  B-301  Bulk export to CSV            [Built]      "Release the CSV export to production?"    → /harmony-plugin:finish-work B-301

STALE — KNOWLEDGE CHANGED (agent will draft a patch for review)
  B-288  Deploy webhook                [Deployed]   superseded: "harmony-web CI/CD…"  → /harmony-next B-288
```

### 5. Offer to pick one up

End by offering: "Run `/harmony-plugin:harmony-next` to start on the highest-priority item, or name a
ticket." Do not take any write action from this skill.
