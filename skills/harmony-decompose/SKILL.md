---
name: harmony-decompose
description: Decompose a clarified ticket into a child hierarchy (Clarified → Decomposed). Triggers on "decompose B-123", "break this down", "harmony decompose", or picking up a Clarified ticket. Applies the manageability rule; even "no decomposition needed" is an explicit decision. Files a proposal brief; on accept, creates children at Proposed state.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Decompose

Implements the `decomposing` activity (state-machine §4, §8): Clarified → Decomposed. Decomposition is
**non-skippable** — "no decomposition needed" must be an explicit human decision, not a silent skip.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## Flow

### 1. Load + check readiness

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
opinionated-mode activity (manual-mode projects use the normal board, not the clarify→decompose→design
lifecycle). Then `mcp__harmony__get_task({ task_id })`; confirm `workflow_state === 'Clarified'`. Read the
clarification (`mcp__harmony__query_knowledge({ type: 'specification' })` or follow `awaiting_human_ref`) —
children inherit the parent's **clarification**, not design (state-machine §8.1).

### 2. Query knowledge + propose the hierarchy

**Detect prior decomposition first (B-646).** Before proposing anything, call
`mcp__harmony__list_subtasks({ task_id })`. "Already decomposed" = ≥1 **non-archived** child (each row
carries `archived`, `workflow_state`, `title`). If children already exist, the existing set IS the
proposed hierarchy — confirm/adjust the existing children; never draft a fresh competing hierarchy
(B-646: manual pre-decomposition is common — children get filed during triage — and an unguided run
would duplicate them, e.g. B-550's 4 → 8).

Query `engineering` (how this codebase structures multi-surface work) and `product` (feature
boundaries). Apply the manageability rule: split until each child is a clean, independently-shippable
unit; stop when further splitting adds coordination cost without clarity. **Complexity/structure
splitting is THIS gate's job alone** — clarify may split only to de-scope a later phase of product
intent on the human's explicit answer, never on size or compositeness; see
`skills/harmony-shared/gate-routing.md` §Split ownership. (Self-heal, B-518: if the accepted
clarification carries an unexecuted **"De-scope — re-ticketed on accept:"** block — a web accept with
no session running — execute the re-ticket here first, idempotently, before proposing the hierarchy.)
The result is either:
- a list of proposed children (title + one-line intent each), or
- **"no decomposition needed"** — a single, explicit decision, or
- confirmation of the existing child set (plus any genuinely net-new children the decomposition
  introduces).

### 3. Compose the proposal brief

Author the brief per `skills/harmony-shared/brief-authoring.md` §Decompose — the question, must-haves,
and engagement it owes the human, plus the legibility contract. Consult it; do not restate it.

```
mcp__harmony__compose_brief({
  task_id,
  reason: "decomposition-proposal",
  pending_activity: "decomposing",
  doc: {
    decide: "Decompose B-240 into N children, or keep as one ticket?",
    recommend: { text: "Three children: schema, MCP surface, web UI" },
    items: [
      { kind: "decision", text: "Child 1 — schema migration", recommendation: "create" },
      { kind: "decision", text: "Child 2 — MCP tools", recommendation: "create" },
      { kind: "decision", text: "Child 3 — web surface", recommendation: "create" }
    ]
  }
})
```

On an already-decomposed ticket (B-646), the items enumerate each EXISTING child — visual id + title,
e.g. `{ kind: "decision", text: "B-551 — schema migration (existing)", recommendation: "confirm" }` —
never `"create"`. Genuinely net-new children the decomposition introduces are separate items
recommended `"create"`; a removal/restructure of an existing child is its own explicit decision item,
never silent.

For "no decomposition needed", file a single decision item recommending "no split", and (optionally)
record a short `specification` decision documenting *why* — then `reference_knowledge` it.

### 4. Display + resolve

Show the rendered `content`. On the human's command:
- **accept** → first create the children, then advance:
  1. For confirmed-EXISTING children, skip `manage_subtasks add_new` entirely — they are already the
     hierarchy. Call `mcp__harmony__manage_subtasks({ task_id, add_new: [{ title: "...", description: "..." }, ...] })`
     ONLY for genuinely net-new children. Never `add_new` a fresh set that duplicates existing
     non-archived children (B-646).
  2. Then bring EVERY still-**Captured** child — existing and newly created alike — to **Proposed**
     (state-machine §8.1). `manage_subtasks add_new` lands children at **Captured** (the
     `tasks_default_workflow_state` insert trigger), and existing children pre-filed at triage
     typically sit at Captured too; promote each one Captured→Proposed in a single step — do **not**
     call `capturing` first (the child is already Captured, so `capturing` has no valid edge and the
     transition guard rejects it):
     `mcp__harmony__advance_workflow({ task_id: <child>, activity: "proposing" })`.
  3. `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → advances the parent
     Clarified→Decomposed. (For "no decomposition needed", skip 1–2 and just accept.)

  The existing-children branch also makes accept idempotent for free: a re-run after a crash
  mid-accept (children created, resolve not yet run) sees them as existing and confirms instead of
  re-creating.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"). Author the
  deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    type: "deferral", title: "<ticket>: decomposition deferred — <why>",
    content: "<rationale: why not breaking this down now + when to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["engineering", "product"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **edit** / **iterate** → revise the proposed hierarchy and re-call `compose_brief`.
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).

### 5. Report

List the created children with their IDs and confirm the parent is at Decomposed. Each child is now an
Proposed ready for its own `/harmony-plugin:harmony-clarify`.
