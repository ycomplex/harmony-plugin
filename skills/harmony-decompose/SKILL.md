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

**Self-heal fallback when this check finds NO children (B-816).** When this gate is entered as the
OWNING GATE's materialization for a `payload-unrecognized` `decomposition-proposal` event
(`harmony-conduct` §1c), `list_subtasks` returning zero non-archived children means there is nothing
pre-filed to confirm — but the accepted brief's snapshot is NOT lost: `consume_pending_acceptance_event`
echoed it verbatim on the result's `items` field. Render those `child_ticket` items (title/description
per item) as a **confirm-then-create ask** — never an open "what were the children?" re-dictation
question. On the human's confirm, mint them via the SAME §4 accept-step-1 `manage_subtasks add_new` +
promote-to-Proposed sequence, then commit the deferred advance
(`mcp__harmony__consume_acceptance_event({ event_id })`). Any `ac_transfer` items in the same `items`
array apply per §4 step 3, unchanged.

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

**AC reassignment (B-810).** While proposing children, check whether any of the PARENT's existing
acceptance criteria (`mcp__harmony__list_acceptance_criteria({ task_id })`) is actually scoped to ONE
specific child rather than the parent as a whole — e.g. an AC about the web surface once the web surface
becomes its own child. When that's the case, propose moving that AC onto its destination child as an
explicit, named part of the decomposition (never silently — the human sees and accepts the move like any
other decision item). The common case mints children with **no** AC reassignment; only propose a move
when an existing AC genuinely belongs on a specific new child.

### 3. Compose the proposal brief

Author the brief per `skills/harmony-shared/brief-authoring.md` §Decompose — the question, must-haves,
and engagement it owes the human, plus the legibility contract. Consult it; do not restate it.
Ticket ids named in the brief's prose follow `skills/harmony-shared/brief-authoring.md` §Ticket identity — never assume the letter `B`.

**Also author `doc.payload` (B-810)** — one `child_ticket` item per GENUINELY NEW child (confirmed-
existing children get no item), `ref: slugRef('child', title)`, plus one `ac_transfer` item per AC the
proposal actually moves (see §2 above), authored in the SAME payload as the `child_ticket` items it
targets. Ordering inside the array does not matter — `applyAcceptanceEventPayload` (acceptance-events.ts)
applies every `child_ticket` before any `ac_transfer`, regardless of authored order. Per `ac_transfer`
item: `ref: slugRef('actransfer', <the AC's own content>)` (never the child's title); `content` = the AC's
full text, copied verbatim — never reworded; `target_child_ref` = that destination child's own
`child_ticket` item `ref` from this SAME payload; `from_ac_id` = the parent AC's own id being removed
(omit only for the rare copy-not-move case). Mint-then-mirror: `ref`s from `slugRef`/`dedupeRefs`
(`payload-refs.ts`) — never reinvented. The common case (no AC reassignment) still authors `ac_transfer:
[]`, never omits the key. "No decomposition needed" authors `payload: []`.

**Also author `doc.frame` (B-876) — the decompose gate's own must-haves.** Two of them have no other
typed home, so without the frame they degrade into `context[]` and stop being read: the **element
inventory** (what is actually inside this ticket, each with its repo/file surface and the acceptance
criteria it covers) and the **coverage attestation** against the accepted clarification (no gaps, no
overlaps). Set `existing_children_checked` truthfully — B-646 duplicated a hierarchy 4 → 8 because nobody
checked. `frame.kind` must be `"decompose"`; the render places it below the recommendation.

**Carry `alternatives` too — the rejected cut, named and priced by independent shippability.** Measured
1/14 across the decompose corpus, and it is the block that makes the no-split default a *priced* choice
rather than an unexamined one. Say the asymmetry once, in `coverage` or in the rejection: over-splitting
is the expensive error (un-splitting needs `subsume_task`, which has no inverse per B-617, and discards
the children's clarifications), un-*no*-splitting is cheap. A cross-capable reader knowing the asymmetry
and being made to price it are different acts.

```
mcp__harmony__compose_brief({
  task_id,
  reason: "decomposition-proposal",
  pending_activity: "decomposing",
  doc: {
    decide: "Decompose <ticket> into N children, or keep as one ticket?",
    recommend: { text: "Three children: schema, MCP surface, web UI" },
    frame: {
      kind: "decompose",
      // One entry per element INSIDE this ticket — the inventory the split/no-split fork is priced against.
      elements: [
        { text: "<what this element is, in one line>",
          surface: "<repo: the file/module surface it touches>",
          covers: "<the acceptance criterion/criteria it discharges>" }
      ],
      // The attestation, plus the one thing to price before accepting (an unknown repo footprint, a
      // cross-repo lockstep the release gate will later ask for in one irreversible accept, ...).
      coverage: "Every acceptance criterion maps to at least one element and no element is claimed by two. <the one thing to price>",
      existing_children_checked: true   // did you actually check for an existing child set? (B-646)
    },
    // The rejected cut — never omit it; a fork with one arm named is not a fork.
    alternatives: [
      { option: "<the cut you did NOT take, e.g. two children split by repo>",
        rejection: "<why it loses — independent shippability, and the asymmetry between the two errors>" }
    ],
    items: [
      { kind: "decision", text: "Child 1 — schema migration", recommendation: "create" },
      { kind: "decision", text: "Child 2 — MCP tools", recommendation: "create" },
      { kind: "decision", text: "Child 3 — web surface", recommendation: "create" }
    ],
    // dedupeRefs([...children, ...transfers]) — children minted first is a documentation convenience
    // only; applyAcceptanceEventPayload re-orders by write_kind regardless of authored order.
    payload: [
      { write_kind: "child_ticket", ref: "child-schema-migration", title: "Child 1 — schema migration", description: "..." },
      { write_kind: "child_ticket", ref: "child-mcp-tools", title: "Child 2 — MCP tools", description: "..." },
      { write_kind: "child_ticket", ref: "child-web-surface", title: "Child 3 — web surface", description: "..." }
      // e.g. moving an existing web-scoped AC onto Child 3:
      // { write_kind: "ac_transfer", ref: "actransfer-the-web-surface-renders-x", content: "The web surface renders X",
      //   target_child_ref: "child-web-surface", from_ac_id: "<parent AC's own id>" }
    ]
  }
})
```

On an already-decomposed ticket (B-646), the items enumerate each EXISTING child — visual id + title,
e.g. `{ kind: "decision", text: "<ticket> — schema migration (existing)", recommendation: "confirm" }` —
never `"create"`. Genuinely net-new children the decomposition introduces are separate items
recommended `"create"`; a removal/restructure of an existing child is its own explicit decision item,
never silent.

For "no decomposition needed", file a single decision item recommending "no split", and (optionally)
record a short `specification` decision documenting *why* — then `reference_knowledge` it. When you do
record one, set `source_activity: "decompose"` so downstream readers (e.g. `harmony-design-decide`'s
AC-filing self-heal, B-744) can tell this record apart from clarify's own Accepted `specification`
decision — both share `type: "specification"`, and a selector that discriminates on `type` alone can
silently pick this one instead of clarify's:

```
const noSplit = mcp__harmony__record_decision({
  type: "specification",
  title: "<ticket>: decomposition — no split",
  content: "<why no decomposition is needed>",
  domain: ["product", "process"],
  source_type: "manual",
  source_activity: "decompose",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: noSplit.id })
```

### 4. Display + resolve

Show the rendered `content`. On the human's command:

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conductor-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → first create the children, then move any proposed ACs, then advance:
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
  3. **AC transfer (B-810) — for each `ac_transfer` item the brief's `doc.payload` carries** (§3 §2),
     move that AC onto its destination child: add the SAME content verbatim onto the child, then delete
     it from the parent —
     `mcp__harmony__manage_acceptance_criteria({ task_id: <child>, add: [{ content: "<AC content>" }] })`
     then
     `mcp__harmony__manage_acceptance_criteria({ task_id, delete: ["<from_ac_id>"] })`
     — in that order (add before delete), so a crash between the two calls leaves the content on BOTH
     tickets rather than losing it. Never reword the content in transit. Skip an item whose target
     child already carries that exact content (idempotent re-run after a crash mid-accept).
  4. `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })` →
     records the decision. (For "no decomposition needed", skip 1–3 and just accept.)
  5. **B-797 — finalize the deferred advance NOW, same session.** The response carries
     `pending_acceptance_event_id`: since you just minted/confirmed the children (and moved any ACs)
     yourself above, there is nothing left to APPLY — only the deferred Clarified→Decomposed advance to
     COMMIT. Call `mcp__harmony__consume_acceptance_event({ event_id: <that id> })` right away, in this
     same turn.

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
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **edit** / **iterate** → revise the proposed hierarchy and re-call `compose_brief`.
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
- **A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

### 5. Report

List the created children with their IDs and confirm the parent is at Decomposed. Each child is now an
Proposed ready for its own `/harmony-plugin:harmony-clarify`.
