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

> **Product legibility (B-434).** The `clarifying` activity IS the product-legibility transformation. Agent-filed findings may enter at Captured in a raw working-context register, but the clarification must render the ticket in the **product register**: title = product-visible outcome (not mechanism); plain-language first paragraph; mechanism + searchable keywords under a `## Technical` heading. See the *ticket two-audience register* doctrine and `create_task`'s description.

## Flow

### 1. Load the ticket + check it's ready

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
opinionated-mode activity (manual-mode projects use the normal board, not the clarify→decompose→design
lifecycle). Then `mcp__harmony__get_task({ task_id })`. Confirm `workflow_state === 'Idea'` (or near it).
If a brief is already active (`mcp__harmony__get_brief` returns one with `reason: 'clarification-draft'`),
you're iterating — load it and skip to step 4.

### 1b. Honor a cross-ticket-completion flag (reconcile before drafting)

Before drafting, check whether this ticket's work is **already done** by another run (B-643) — because a run that completed this work may have flagged it forward, and `find_related_tickets` (step 3c) **excludes Verified/Released**, so a *done* sibling will not surface there:

1. **Honor a `possibly-subsumed-by` annotation** if the description carries one (grep for the `possibly-subsumed-by:` token): `get_task` the named covering ticket; if its work covers this ticket → `subsume_task({ task_id, subsumed_by_task_id: <covering>, reason })` and **stop** — don't clarify already-delivered work. Else clear/note the flag and proceed with the genuine remainder.
2. **Independently, check for a Verified/Released sibling** via `search_tasks` (it does **not** filter by `workflow_state`, so unlike `find_related_tickets` it reaches done work): search this ticket's title + intent, keep hits whose `workflow_state ∈ {Verified, Released}`, and if a high-similarity hit already delivered this work → subsume + stop.

See `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished"** for the full mechanism and rationale.

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

### 3c. Surface related / duplicate / overlapping tickets

After drafting the clarification (and before composing the brief), check whether this
work already exists or overlaps an open ticket — dedup-on-clarify (B-475). Call the
dedup pipeline:

```
mcp__harmony__find_related_tickets({ task_id })   // top ~5; pass limit to widen
```

Render a **"Related / duplicate / overlapping tickets"** card from the result as a
**SINGLE relevance-ranked list** — the candidates arrive in relevance order (RRF fused
across the intent + lexical routes), and **that order is authoritative**. Do NOT group,
section, or reorder. One row per candidate, each row showing:

- **id** (visual id, e.g. `B-123`) + **title**
- **state** (`workflow_state`) and **milestone** — or the literal **"unmilestoned"** when `milestone_id` is null
- a **one-line relatedness reason** (why it overlaps — paraphrase the shared intent; note which routes surfaced it, `intent` and/or `lexical`)
- a **recommended disposition**: `fold` (this ticket should be absorbed into that umbrella), `dedupe` (that ticket is the same ask — absorb this one into it), or `ignore` (related but distinct)
- **badges** (salience only — they NEVER reorder the list; relevance order stays authoritative):
  - **"⚠ deferred — fold while you're here"** for any candidate with `unmilestoned: true`

If `candidates` is empty, render **"Related tickets: none found"** explicitly. If the
result has `degraded: true`, note that intent retrieval was unavailable and the list is
lexical-only (so it may be incomplete) — never let this fail the clarify gate.

**This card is SURFACE-ONLY.** Surfacing it does not change any ticket's scope or status.
Act on a disposition ONLY on the human's explicit command (step 5) — never auto-fold,
auto-dedupe, or auto-subsume.

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

#### Acting on a related-ticket disposition (B-475)

When the human picks a `fold`/`dedupe` disposition on a surfaced candidate, record the
subsume — **only on that explicit command** (surface-only guardrail; never automatic):

- **dedupe** (this ticket duplicates an existing umbrella → absorb THIS ticket into it):
  ```
  mcp__harmony__subsume_task({ task_id, subsumed_by_task_id: "<umbrella visual id>", reason: "<why>" })
  ```
  This sets `subsumed_by_task_id` + archives this ticket + logs a `task_subsumed` event (idempotent).
- **fold** (a related candidate should be absorbed INTO this ticket as the umbrella):
  ```
  mcp__harmony__subsume_task({ task_id: "<candidate visual id>", subsumed_by_task_id: task_id, reason: "<why>" })
  ```
  Then **edit this (umbrella) ticket's clarification** to absorb the folded candidate's
  requirement — re-call `record_decision`/`compose_brief` with the broadened spec so the
  umbrella now covers what the folded ticket asked for.
- **ignore** → no-op (the candidate is related but distinct; leave both tickets as-is).

`subsume_task` is idempotent and requires BOTH the absorbed id and the umbrella id, so it
can never run without an explicit human-chosen target.
