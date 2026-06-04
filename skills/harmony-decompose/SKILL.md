---
name: harmony-decompose
description: Decompose a clarified ticket into a child hierarchy (Clarified → Decomposed). Triggers on "decompose B-123", "break this down", "harmony decompose", or picking up a Clarified ticket. Applies the manageability rule; even "no decomposition needed" is an explicit decision. Files a proposal brief; on accept, creates children at Idea state.
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

Query `engineering` (how this codebase structures multi-surface work) and `product` (feature
boundaries). Apply the manageability rule: split until each child is a clean, independently-shippable
unit; stop when further splitting adds coordination cost without clarity. The result is either:
- a list of proposed children (title + one-line intent each), or
- **"no decomposition needed"** — a single, explicit decision.

### 3. Compose the proposal brief

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

For "no decomposition needed", file a single decision item recommending "no split", and (optionally)
record a short `specification` decision documenting *why* — then `reference_knowledge` it.

### 4. Display + resolve

Show the rendered `content`. On the human's command:
- **accept** → first create the children, then advance:
  1. `mcp__harmony__manage_subtasks({ task_id, add_new: [{ title: "...", description: "..." }, ...] })`
  2. For each new child, bring it to **Idea** (state-machine §8.1 — children start at Idea):
     `mcp__harmony__advance_workflow({ task_id: <child>, activity: "capturing" })` then
     `mcp__harmony__advance_workflow({ task_id: <child>, activity: "promoting" })`.
  3. `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → advances the parent
     Clarified→Decomposed. (For "no decomposition needed", skip 1–2 and just accept.)
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

### 5. Report

List the created children with their IDs and confirm the parent is at Decomposed. Each child is now an
Idea ready for its own `/harmony-plugin:harmony-clarify`.
