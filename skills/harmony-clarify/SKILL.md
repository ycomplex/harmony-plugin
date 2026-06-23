---
name: harmony-clarify
description: Clarify a ticket's intent into a specification (Idea → Clarified). Triggers on "clarify B-123", "what does this ticket mean", "harmony clarify", or picking up an Idea-state ticket. Dialogues with the human, queries domain knowledge first, drafts a clarification, and files it as a brief for accept/edit/defer.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Clarify

Implements the `clarifying` activity (state-machine §4): Idea → Clarified, producing a clarification
knowledge entry. The skill *is* the agent (agent-model §1): it reads state, drafts, files a brief, and
records the result back through MCP. It never edits code (discovery role).

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## Flow

### 1. Load the ticket + check it's ready

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
opinionated-mode activity (manual-mode projects use the normal board, not the clarify→decompose→design
lifecycle). Then `mcp__harmony__get_task({ task_id })`. Confirm `workflow_state === 'Idea'` (or near it).
If a brief is already active (`mcp__harmony__get_brief` returns one with `reason: 'clarification-draft'`),
you're iterating — load it and skip to step 4.

### 2. Query domain knowledge BEFORE drafting

Per the discipline, query the relevant domains. For most clarifications that's `product` (feature
semantics, business rules) plus `customer` where relevant:

```
mcp__harmony__query_knowledge({ domain: ["product", "customer"], search: "<the ticket's subject>" })
```

Also pull similar past tickets/decisions (`query_knowledge` by `type: 'specification'`). If a relevant
entry exists, ground the clarification in it. If none exists and the question is **load-bearing** (the
whole spec hinges on it and you're out of depth), do NOT guess — go to step 3b.

### 3. Draft the clarification

Resolve the real open questions (scope, per-user vs shared, project vs workspace scope, what's in/out —
the kind of questions a human would ask, state-machine §1). Write the clarified intent as an **Asserted**
specification entry:

```
const decision = mcp__harmony__record_decision({
  type: "specification",
  title: "<ticket>: clarified intent",
  content: "<the clarified spec — what this is, in/out of scope>",
  domain: ["product"],
  source_type: "manual",
  source_activity: "clarify",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

#### 3b. Load-bearing gap → research-first

If a load-bearing gap blocks the spec, compose the brief with `load_bearing_gap: true`, the concrete
research prompts in `research[]`, decision items marked `deferred: true`, then invoke
`/harmony-plugin:harmony-research <ticket>` to run the v1 relay. Re-query knowledge after research
returns, then resume step 3.

### 4. Compose the brief

Build the BLUF `BriefDoc` and file it — this sets `awaiting_human_input` and lints the doc:

```
mcp__harmony__compose_brief({
  task_id,
  reason: "clarification-draft",
  pending_activity: "clarifying",
  decision_ref: { type: "specification", id: decision.id },
  doc: {
    decide: "Is a 'Saved Filter' per-user or shared at project scope?",
    recommend: { text: "Per-user, project-scoped — matches existing filter UX", confidence: "medium" },
    why: ["Existing filters are per-user", "No product entry on filter sharing yet"],
    items: [
      { kind: "decision", text: "Scope of a saved filter", recommendation: "Per-user, project-scoped" },
      { kind: "content-input", text: "Confirm whether sort/grouping is part of the saved state" }
    ]
  }
})
```

If `compose_brief` throws a lint error (naked fork, mislabelled derived constraint, or a load-bearing
gap without research), fix the `doc` and recompose — what's linted is exactly what's rendered.

### 5. Display + resolve

Show the rendered `content` verbatim. On the human's command:
- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → promotes the
  specification Asserted→Accepted and advances Idea→Clarified. Report the new state.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"). First author the
  deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    type: "deferral", title: "<ticket>: deferred — <why>",
    content: "<rationale: what we're not clarifying now + when to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["product"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })   // → Parked
  ```
  **Fallback (B-352):** a defer with no rationale still parks — prompt once for the rationale, but if the
  human declines, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
  "defer" })`. (The web `defer`, P5, is mechanical-only and never authors this entry — the documented v1
  asymmetry.)
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise the `doc` per the human's input and re-call `compose_brief` (updates
  in place, bumps `iteration`).
