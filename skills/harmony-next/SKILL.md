---
name: harmony-next
description: Pick up the highest-priority thing awaiting me and start the right activity. Triggers on "what's next", "harmony next", "pick up the next thing", "do the next item". Reads the queue, takes the top item, renders its brief, and either resolves it (accept/defer/expand/related) or hands off to the activity skill that owns it.
allowed-tools: mcp__harmony__* Read Grep Glob
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Next

Pull the top of the queue and act on it (agent-model §5: *pick up the highest-priority next thing and
start the appropriate activity*). One ticket can be named explicitly (`/harmony-plugin:harmony-next B-301`)
or left blank to take the highest-priority awaiting item.

## Flow

### 1. Resolve mode + the target item

Call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop (manual-mode projects don't use the
queue). If the user named a ticket, `mcp__harmony__get_task({ task_id })`. Otherwise
`mcp__harmony__query_tasks({ awaiting_human_input: true, sort_by: 'priority', limit: 1 })` and take the
single result. If the queue is empty, say so and stop.

### 2. Show the brief

Call `mcp__harmony__get_brief({ task_id })` and display the rendered `content` blob **verbatim** in a
fenced block (it is already BLUF-formatted and lint-clean — do not re-summarise it). Note the
`iteration` if > 1.

**Null brief on a `verification-ack-pending` umbrella (B-471):** `get_brief` can be **null** when
`awaiting_human_reason = 'verification-ack-pending'`. This is the trigger-surfaced **PR-less umbrella** —
a decomposed parent that the DB trigger auto-advanced **Decomposed → Released** once all its children
reached **Verified**; the trigger set the `awaiting_human_input` flag (with
`awaiting_human_ref = {"kind":"umbrella-auto-verify"}`) but **composed no brief**. Do **NOT** choke on the
missing brief and do NOT try to render it here. **Delegate to `/harmony-plugin:finish-work <ticket>`
(verify step)** — it composes the verification brief (via `compose_brief`) and then resolves it. This is
the same routing-table target as a normal `verification-ack-pending` accept (step 4); the only difference
is the brief doesn't exist yet, so there is nothing to show inline first.

### 3. Resolve by command — but `accept` is only inline for the PURE gates

**Critical (review F1):** P3's `resolve_brief` does exactly three things on accept — promote the
referenced decision, advance state via `pending_activity`, clear the flag. It does **no skill-side work.**
For three gates the *real* work (create children / merge+deploy / observe production) lives **outside**
`resolve_brief`, so resolving inline here would flip state while the ticket's reality lags. So:

- **defer** (any reason) → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"):
  before parking, author the deferral so the "not now" outlives the ticket (knowledge-model-v1 §5a) —
  ```
  const deferral = mcp__harmony__record_decision({
    type: 'deferral', title: '<ticket>: deferred — <why>',
    content: '<rationale: what we are not doing now + the condition/date to revisit>',
    review_by: '<watch/revisit date, ISO>', domain: [ /* the domain(s) it touches */ ],
    source_type: 'manual', source_activity: 'defer', source_task_id: '<task uuid>',
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: 'defer', detail: '<reason>' })   // → Parked
  ```
  **Fallback (B-352):** a defer with no rationale still parks — prompt once for the rationale, but if the
  human declines, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
  'defer' })`. Always safe inline (no external side-effect). (The web `defer`, P5, is mechanical-only and
  never authors this entry — the documented v1 asymmetry.)
  - **Exception — a `stale-patch-review` brief:** `defer` here is **reject / knowing-divergence**, not park
    (see the Stale bullet below + `harmony-stale-patch`). Do NOT author a `deferral` entry for it;
    `resolve_brief` clears Stale and records the divergence.
- **expand** / **related** → read `expand_sections` / `related` from `get_brief` and show them
  (pre-generated; no recompute). Inline.
- **accept** → branch on `awaiting_human_reason`:
  - **Pure gates** — `clarification-draft`, `design-decision-draft`, `plan-draft` (accept ==
    `resolve_brief` with no external side-effect) → resolve inline:
    `mcp__harmony__resolve_brief({ task_id, command: 'accept' })`; report the new `workflow_state`.
  - **Side-effecting gates** — `decomposition-proposal` (children must be created first),
    `release-decision-pending` (merge + deploy), `verification-ack-pending` (production observation) →
    **do NOT call `resolve_brief` here.** Delegate `accept` to the owning skill (step 4), which performs
    the work AND resolves in the correct order.
- **edit** / **iterate** → generative work owned by the gate skill → delegate (step 4); it re-composes
  the brief in place (bumping `iteration`).
- A **Stale** ticket (from the `stale` read, no brief yet) → **delegate to the patch author**: invoke
  `/harmony-plugin:harmony-stale-patch <ticket>` (it reads `stale_ref` + the ticket's referenced knowledge,
  drafts a concrete proposed patch, and composes a `stale-patch-review` brief). Then resolve **per that
  brief**: **accept** applies the patch (P3's extended `resolve_brief` clears the Stale flag, and backflows
  state if the patch carried a `revising-*` `pending_activity`); **defer** rejects it as a knowing-divergence
  (clears Stale, records it, does NOT park). If the ticket *already* has a `stale-patch-review` brief (the
  author ran earlier — it shows in both the `awaiting_human_input` and `stale` reads, de-dup by id), show the
  brief and resolve inline without re-invoking the author.

### 4. Routing table (used for `accept`-delegation on side-effecting gates AND for edit/iterate)

| `awaiting_human_reason` | accept is… | Hand off to |
|---|---|---|
| `clarification-draft` | inline `resolve_brief` | `/harmony-plugin:harmony-clarify <ticket>` (edit/iterate) |
| `design-decision-draft` | inline `resolve_brief` | `/harmony-plugin:harmony-design-decide <ticket> --track <sub-track>` |
| `plan-draft` | inline `resolve_brief` | `/harmony-plugin:start-work <ticket>` |
| `decomposition-proposal` | **delegated** (creates children, then resolves) | `/harmony-plugin:harmony-decompose <ticket>` |
| `release-decision-pending` | **delegated** (merge+deploy, then advances) | `/harmony-plugin:finish-work <ticket>` |
| `verification-ack-pending` | **delegated** (observe prod, then resolves) — also the **PR-less umbrella** path when `get_brief` is null (B-471): delegate the same way, finish-work composes the brief first | `/harmony-plugin:finish-work <ticket>` (verify step) |
| (Stale) | **delegated** — draft the patch, then resolve per the brief (accept applies / defer = knowing-divergence) | `/harmony-plugin:harmony-stale-patch <ticket>` |

### 5. Confirm the outcome

After resolving, report the new state and (if anything new is now awaiting) suggest running the skill
again. Never commit code or edit files from this skill — those are build/release activities.
