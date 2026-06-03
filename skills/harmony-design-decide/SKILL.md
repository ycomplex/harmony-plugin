---
name: harmony-design-decide
description: Make a design decision on one sub-track (Decomposed → Designed). Triggers on "design B-123", "harmony design-decide B-123 --track ux-ui", "decide the technical approach". Runs one of three sub-tracks — Product Design, Technical Design, UX/UI Design — querying domain knowledge, drafting a typed decision, and filing it as a brief. State advances to Designed only when all required sub-tracks are accepted.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Design-Decide

Implements one sub-track of the `designing` activity (state-machine §5): Decomposed → Designed. "Design"
is the **umbrella** for three sub-tracks — always name the sub-track explicitly. The skill must NOT
write code (discovery role): it produces design *decisions*, not implementations.

Invoke with a sub-track: `--track product` | `--track technical` | `--track ux-ui`.

| `--track` | Decision `type` | Produces | Default `domain` |
|---|---|---|---|
| `product` | `product-design` | Behaviour spec + acceptance criteria | `product` |
| `technical` | `technical-design` | Architecture / implementation approach | `engineering`, `operations`, `data` |
| `ux-ui` | `ux-ui-design` | Experience design — look, feel, interaction | `product`, `customer` |

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

## Flow

### 1. Load + determine required sub-tracks (ticket-scoped completion read)

`mcp__harmony__get_task({ task_id })`; confirm `workflow_state === 'Decomposed'` (or that designing is in
progress). Propose which sub-tracks this ticket *requires* (a backend-only ticket has no UX/UI track —
state-machine §5); the human can override.

To know which required sub-tracks are already **Accepted for THIS ticket**, use the ticket-scoped read —
**not** `query_knowledge`, which returns no `source_task_id` and whose compat view hides `*-design` types:

```
const refs = mcp__harmony__list_ticket_knowledge({ task_id })
// refs: [{ decision_id, type, status, title }] for the decisions THIS ticket references.
const acceptedTracks = refs
  .filter(r => ['product-design','technical-design','ux-ui-design'].includes(r.type) && r.status === 'Accepted')
  .map(r => r.type)
```

`acceptedTracks` vs the required set tells you whether the sub-track you're about to file is the **last
required** one (which decides `pending_activity` in step 4).

> **One brief at a time (P3 substrate constraint).** There is **one active brief per task** (P3's partial
> unique index); a second `compose_brief` *updates the active brief in place* — it does not open a second.
> So although state-machine §5 calls the sub-tracks "concurrent", at the brief layer they are
> **serialized**: file one sub-track's brief → get it accepted (frees the active slot) → file the next.
> Never draft all three at once; you'd silently overwrite the first two. *(v1 limitation: P1 added no
> per-ticket sub-track-completion column — completion is derived from the Accepted referenced design
> decisions above. That's reliable because `list_ticket_knowledge` is ticket-scoped, so a peer ticket's
> accepted sub-tracks can't be mistaken for this one's.)*

### 2. Query domain knowledge for THIS sub-track

Use the sub-track's domains (table above). E.g. a technical-design decision queries `engineering` +
`operations` (deploy/infra) + `data` (schema):

```
mcp__harmony__query_knowledge({ domain: ["engineering", "operations", "data"], search: "<sub-track decision subject>" })
```

Ground the decision in what you find; surface gaps. If a
load-bearing gap blocks the decision, go research-first (see knowledge-discipline) and invoke
`/harmony-plugin:harmony-research`.

### 3. Draft the typed decision (Asserted)

```
const decision = mcp__harmony__record_decision({
  type: "technical-design",            // or product-design / ux-ui-design
  title: "<ticket>: <sub-track> — <decision>",
  content: "<the decision + rationale>",
  madr: { context: "...", drivers: ["..."], options: ["..."], outcome: "...", consequences: ["..."] },
  domain: ["engineering", "operations"],
  source_type: "manual",
  source_activity: "design-decide",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

### 4. Compose the brief — advance only on the LAST required sub-track

Set `pending_activity: "designing"` **only if this is the last required sub-track** (all others already
Accepted). Otherwise set `pending_activity: null` — accepting this brief promotes the decision and clears
the flag without advancing state (state advances to Designed only when *all* required sub-tracks are in).

```
mcp__harmony__compose_brief({
  task_id,
  reason: "design-decision-draft",
  pending_activity: <"designing" if last required sub-track, else null>,
  decision_ref: { type: "technical-design", id: decision.id },
  doc: {
    decide: "Technical approach for the saved-filter store?",
    recommend: { text: "Reuse the existing per-user settings JSONB column", confidence: "low" },
    why: ["Existing settings store handles per-user state", "Avoids a new table + RLS"],
    alternatives: [{ option: "New saved_filters table", rejection: "More schema + RLS for v1 scope" }],
    items: [{ kind: "decision", text: "Where saved-filter state lives", recommendation: "settings JSONB" }]
  }
})
```

### 5. Display + resolve

Show the rendered `content`. On the human's command:
- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → promotes this decision
  Asserted→Accepted; if it carried `pending_activity: "designing"`, advances Decomposed→Designed. Report
  whether the ticket is now Designed or still needs other sub-tracks.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"). Author the
  deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    type: "deferral", title: "<ticket>: <sub-track> design deferred — <why>",
    content: "<rationale: why this design decision is parked + when/what to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["engineering"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **expand** / **related** → show pre-generated sections.
- **edit** / **iterate** → revise and re-call `compose_brief`.

### 6. Cross-cutting scope (optional)

If the decision has scope beyond this ticket (state-machine §8.3 — `this-ticket-and-descendants` /
`named-peers`), note it in the decision `content` so a later supersession knows what it affects. (Full
scope-propagation automation is deferred.)
