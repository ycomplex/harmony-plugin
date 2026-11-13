---
name: harmony-queue
description: Show what's awaiting ME — the Guided-mode pull queue. Triggers on "my queue", "what's awaiting me", "what should I look at", "harmony queue", "what needs my input". Read-only conductor view that lists every ticket where the ball is in the human's court, with its one-line decision and brief reason.
capabilities: harmony-mcp read
allowed-tools: mcp__harmony__* Read Grep Glob
---

> **No `disallowed-tools` here (B-1117, 2026-10-13).** This skill never edits code or runs git — that is
> its role, stated in prose — but it no longer *revokes* Write/Edit/git: Claude Code applies an invoked
> skill's `disallowed-tools` to the rest of the session, subagents included, so in an auto-approved run
> (several gates in one worker leg) the revocation reached the build gate and denied its commit
> (B-1115). Same class as B-1114 (the conduct skill's Edit revocation).

# Harmony Queue

The pull-based conductor view (agent-model §5): *what is awaiting you, prioritised, with briefs ready.*
This is read-only — it never advances state. To act on an item, run `/harmony-plugin:harmony-next`
(picks the top item) or the activity skill the item points to.

## Flow

### 1. Confirm the project is in Guided mode

Call `mcp__harmony__get_project`. If `mode !== 'opinionated'`, tell the user the queue is an
Guided-mode feature and stop — Freeform-mode projects use the normal board.

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

**Incidents first (B-1452).** An awaiting task whose `awaiting_human_ref.incident` is set (today always
`'credential-exposure'`) is an **incident**: a leg exposed a credential outside the worker and stopped.
Pull every such task out of the reason groups. It has no brief — skip step 3 for it and read its round
instead with `mcp__harmony__get_elicitation({ task_id })`: the last round's `context_line` says what was
exposed and where, and its one question names what only a human can do.

### 3. Fetch each awaiting brief's one-line decision

For each **awaiting** task, call `mcp__harmony__get_brief({ task_id })` and read `doc.decide` (the BLUF
one-liner) + `iteration`. If a task has no active brief (e.g. `release-decision-pending` set before a
brief was composed), fall back to `awaiting_human_reason`. A Stale task that has **not** yet been patched has
no brief — describe it from `stale_ref` and point at `/harmony-plugin:harmony-next` (which delegates to the
patch author). A Stale task that already carries a `stale-patch-review` brief has its patch decision in
`doc.decide` like any other awaiting item.

### 4. Render the queue — incidents first, then awaiting grouped by reason, Stale grouped on its own

Incident items always come first, labelled **Incident**, ahead of every other item whatever its
priority. Each ends with how to release it: answer the round "resume" (continue) or "stop" (park
with the incident as the reason).

```
Awaiting you (4):

INCIDENT
  B-330  Rotate webhook secrets        [Planned]    "Incident — credential exposure: a GitHub token was exposed at commit 1a2b3c4 on feat/x."  → answer the round: resume | stop

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


### Interactive fast-track handoff
For `awaiting_human_reason=fast-track-merge-pending` / ref kind `fast-track-merge`, render **Human step** without fetching or implying a brief. Show: “Merge PR #N, then re-run fast-track (or harmony record) and confirm the work with an attestation sentence.” Link the ref’s recorded PR URL; omit the number if missing. Show `refusal_reason` beneath the instruction. No Accept, Defer, Manual override or merge-complete action is offered.
