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
question. On the human's confirm, mint them directly here (this manual mint is NOT §4's normal accept path and
is NOT the B-1034 double-write hazard — a `payload-unrecognized` result means the ledger's own
`applyAcceptanceEventPayload` never runs for this event at all, so this manual write is the only one
that will ever happen):
```
mcp__harmony__manage_subtasks({ task_id, add_new: [{ title: "...", description: "..." }, ...] })
```
then promote-to-Proposed exactly as §4 step 4's shape. Any `ac_transfer` items in the same `items`
array move the AC the same manual add-then-delete way §4 used to before B-1034, for the identical
reason (the ledger cannot apply an unrecognized-shape payload either):
```
mcp__harmony__manage_acceptance_criteria({ task_id: <child>, add: [{ content: "<AC content>" }] })
mcp__harmony__manage_acceptance_criteria({ task_id, delete: ["<from_ac_id>"] })
```
Then apply the deferred payload for real (`mcp__harmony__consume_pending_acceptance_event({ task_id })`
— B-1029: swapped from the commit-only `consume_acceptance_event`, since the same accepted event's
payload can also carry `gate_slot`/`knowledge_entry_content` items this manual self-heal never
materializes on its own).

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

For a split — this decompose creates (or confirms) at least one child — record the split's rationale
as a `specification` decision attached to the **parent** ticket, once per accept, right here in §3
before the `compose_brief` call below: the child set is already known at draft time (that's exactly what
the items above just proposed), so the entry's id is ready to pass as `decision_ref`. Set
`source_activity: "decompose"` so downstream readers (e.g. `harmony-design-decide`'s AC-filing self-heal,
B-744) can tell this record apart from clarify's own Accepted `specification` decision — both share
`type: "specification"`, and a selector that discriminates on `type` alone can silently pick this one
instead of clarify's:

```
const split = mcp__harmony__record_decision({
  type: "specification",
  title: "<parent ticket>: decomposition — split into <N> children",
  content: "<placeholder — one line: 'decomposition rationale for <parent ticket>; body derived from the ratified brief'>",
  domain: ["product", "process"],
  source_type: "manual",
  source_activity: "decompose",
  source_task_id: "<parent task uuid>",
  // B-1000: an agent-authored draft, same reasoning as harmony-clarify's own spec-draft note — append
  // ':<mode>' under harmony-conduct; this is not the accept's own provenance.
  provenance: "agent-synthesized",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: split.id })
```

Then pass `decision_ref: { type: "specification", id: split.id }` on the `compose_brief` call above, so
the accept promotes it (see the B-866 note below — `content` here is a placeholder seat, replaced by
`renderEntry(doc)` at accept). This is a genuinely NEW recording: B-972 and B-979 (real split tickets)
currently carry no decomposition entry at all. Never mint a second one for the same proposal — an
edit/iterate re-compose on the SAME split (§4 "edit" / "iterate") reuses this same `split.id`, it does
not record again.

For "no decomposition needed", **never** mint a per-ticket `specification` entry — 264 near-identical
"<ticket>: decomposition — no split" entries crowded out load-bearing knowledge this way and were retired
for it (B-849). Instead query-or-amend ONE shared `convention` entry, identity-keyed by the stable tag
`decompose-no-split` (mirrors `skills/finish-work/SKILL.md`'s B-836 "Author procedural convention entries
per changed surface" — read that section for the exact query/create/amend/couple shape this mirrors):

```
mcp__harmony__query_knowledge({ type: "convention", tags: ["decompose-no-split"], status: "Accepted" })
```

Judge the amend rule yourself, as PROSE — never defer it to a human — over exactly three states:
- **No-op — the DEFAULT.** This ticket's no-split reasoning is already covered by the convention entry's
  stated heuristic. Do nothing to the entry: the ticket's own retained decompose brief/decision trail
  (list_briefs lineage) is the record. This is the path the ordinary run exercises.
- **One dated section — a genuinely new pattern.** The reasoning introduces a pattern the entry doesn't
  yet state. Amend in place — never `supersede_decision` (an amend is always in-place, matching B-836's
  disallowed-tools convention):
  ```
  mcp__harmony__update_knowledge_entry({
    entry_id,
    content: "<prepend ONE newest-first dated section naming the pattern and this ticket as its
      canonical example, onto the EXISTING content — never replace or drop history>",
    // B-1000: agent-authored, same reasoning as the split write above.
    provenance: "agent-synthesized",
  })
  ```
- **Create-on-first-use — the entry does not exist yet.** Create it directly as Accepted (system-authored
  procedural knowledge, not a proposal awaiting human promotion — mirrors B-836's finish-work pattern):
  ```
  mcp__harmony__record_decision({
    type: "convention", title: "Decompose: when a ticket does not split",
    content: "<the heuristic + the measured retired-count + AT MOST 5 canonical examples — never a full
      id list; retired per-ticket entries stay reachable via include_superseded>",
    tags: ["decompose-no-split"], domain: ["product", "process"],
    status: "Accepted", source_task_id: "<task uuid>", source_activity: "decompose",
    // B-1000: agent-authored, same reasoning as the split write above.
    provenance: "agent-synthesized",
  })
  ```

After whichever of the two non-default states fires (never after the no-op), couple the ticket to the
entry exactly like B-836 does:

```
mcp__harmony__reference_knowledge({ task_id, decision_id: <entry.id> })
```

Then pass `decision_ref: null` on the `compose_brief` call above — `withDerivedEntryContent` returns the
doc unchanged when `decisionRef` is falsy, so no other change is needed there.

> **B-866 — the split entry's prose is DERIVED, not authored here.** `content` on the split's
> `record_decision` above is a **placeholder seat**, not the entry's text. The brief's accept promotes
> `renderEntry(doc)` — a mechanical projection of the very `doc` you compose above — so anything you would
> have written into the entry belongs in the doc (`recommend` / `why` / `alternatives` / `context` /
> `frame`). Do not write the decision out twice, and do not hand-author a `knowledge_entry_content`
> payload item: `compose_brief` derives it, sets its `ref` and `entry_id`, and REPLACES anything you
> author there. See `skills/harmony-shared/brief-authoring.md` §"The brief is the only authored copy".
> (The no-split path's shared convention entry is never a `decision_ref` target, so it never receives
> derived content — its prose is whatever the no-op/amend/create logic above wrote by hand.)


### 4. Display + resolve

Show the rendered `content`. On the human's command:

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conductor-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → resolve, then apply the payload (which mints any new children and moves any transferred
  ACs), then promote every child to Proposed:
  1. For confirmed-EXISTING children, there's nothing to do here — they are already the hierarchy.
     **Genuinely net-new children, and any AC transfer onto a child (§3's `child_ticket` / `ac_transfer`
     payload items, B-810), are NOT minted/moved here directly — do NOT call `manage_subtasks add_new`
     or `manage_acceptance_criteria` for them.** Doing so would double-write against those SAME items'
     own ledgered insert in step 3 below (B-1034 — this is HIGHER STAKES than an ordinary double-filed
     row: a double-mint here creates a literal duplicate CHILD TICKET). The ledger's `ON CONFLICT` key on
     `(event_id, write_kind, external_ref)` can't see a write it didn't make, so a manual write ahead of
     the ledgered apply always double-files. `consume_child_mint_write` / `consume_ac_transfer_write`
     (`src/tools/acceptance-events.ts`) have no title-dedupe of their own beyond that key — which is
     exactly why the `list_subtasks`-based B-646 "does this child already exist" pre-check in §2 REMAINS
     ESSENTIAL as the read-side guard deciding which children get authored as `child_ticket` items in §3
     in the first place. Never `add_new` a fresh set that duplicates existing non-archived children.
  2. `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })` →
     records the decision. For a split, this is also where the `specification` entry recorded in §3
     above is PROMOTED — its placeholder `content` replaced by `renderEntry(doc)`, the mechanical
     projection of the ratified brief. (For "no decomposition needed", `decision_ref` is `null` there, so
     nothing is promoted; any touch to the shared `decompose-no-split` convention entry was already
     written directly, back in §3.)
  3. **B-797 — finalize the deferred advance NOW, same session; this is also where the children actually
     mint and the ACs actually transfer (B-1034).** The response carries `pending_acceptance_event_id`.
     Call `mcp__harmony__consume_pending_acceptance_event({ task_id })` right away, in this same turn
     (B-1029: swapped from the commit-only `consume_acceptance_event`). This is the SINGLE write for
     every `child_ticket` and `ac_transfer` item §3's payload carries — applied in that order, children
     before transfers, so a transfer's destination child already exists when it resolves
     (`applyAcceptanceEventPayload`'s own ordering) — plus any `gate_slot`/`knowledge_entry_content`
     items B-866/B-867 added.
     **B-975 — a shipped-parent milestone refusal is NOT an ordinary tool failure, and now surfaces from
     THIS call** (the mint moved here from the old direct `manage_subtasks add_new`). Each new child
     INHERITS the parent's `milestone_id` (an unmilestoned parent still yields an unmilestoned child —
     no change there). If the parent's milestone has already **shipped**, the underlying
     `consume_child_mint_write` RPC throws a `ShippedMilestoneGuardError` for that item — no child is
     created for it (every other item in the payload, applied earlier in the ordering, stays landed —
     each write_kind's own ledger commits independently). Do not retry it, do not silently drop the
     milestone and re-attempt, and do not report it as a generic build/tool error. Instead, **stop and
     file a `worker-question` round right here** (per `skills/harmony-shared/elicitation-engine.md` §The
     worker-question trigger) with `stakes: 'load-bearing'` / `kind: 'open'`, quoting the guard's own
     error message VERBATIM (it already names the shipped milestone and when it shipped) and asking the
     human to decide: assign the children to a different (open) milestone, leave them unmilestoned, or
     reassign the parent's own milestone first. Only resume this step once that round concludes.
  4. Then bring EVERY still-**Captured** child — existing and just-minted alike — to **Proposed**
     (state-machine §8.1). Re-query `mcp__harmony__list_subtasks({ task_id })` now that step 3 has minted
     any new children (the ledger's `consume_child_mint_write` RPC lands them at **Captured**, same target
     state the old direct `manage_subtasks add_new` used to), and existing children pre-filed at triage
     typically sit at Captured too; promote each one Captured→Proposed in a single step — do **not**
     call `capturing` first (the child is already Captured, so `capturing` has no valid edge and the
     transition guard rejects it):
     `mcp__harmony__advance_workflow({ task_id: <child>, activity: "proposing" })`.

  **Decompose has no existing marker mechanism analogous to clarify's `AC-FILING-PASS` to re-key onto this
  ledgered call's counts — flagged as an open gap here, not invented (out of this ticket's scope).**

  The existing-children branch also makes accept idempotent for free: a re-run after a crash mid-accept
  (resolve already run, children minted) sees them as existing on the next `list_subtasks` and confirms
  instead of re-creating — and the ledger's own `(event_id, write_kind, external_ref)` key makes a
  repeated `consume_pending_acceptance_event` call a no-op for anything already applied.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"). Author the
  deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    type: "deferral", title: "<ticket>: decomposition deferred — <why>",
    content: "<rationale: why not breaking this down now + when to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["engineering", "product"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
    // B-1000: a defer is always human — carries the SAME provenance as the resolve_brief defer below.
    provenance: "human-in-session",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **edit** / **iterate** → revise the proposed hierarchy and re-call `compose_brief`, passing `iterate_feedback` = the human's words VERBATIM. B-843: the re-compose no longer edits the brief in place — it retains the previous revision and stores the feedback that caused this one, so a paraphrase (or an omission) loses the human's actual words permanently. B-903: pass it ONLY when a send-back CAUSED this revision — the recompose that CONSUMES a `pending_resolution` marker supplies that marker's `detail`, and every OTHER recompose OMITS it: a self-redraft, a rebase, an answer to an accept-with-remark, and the single recompose that follows a concluded `discuss` exchange (a brief that was talked over has no send-back words to attribute). `compose_brief` never reads `pending_resolution` for you, so re-stamping the last feedback you happen to know about marks a revision nobody sent back. The call is also a PARTIAL: fields you omit CARRY FORWARD from the previous revision, so never re-state `decision_ref` merely to keep it, and pass an explicit null only when you mean to clear it. Every recompose that is NOT a send-back passes `revision_cause` — see `skills/harmony-shared/brief-authoring.md` §Stating the cause of a redraft (B-1017). A lint-warning-driven recompose is capped at one per lineage per leg — see the same file's §Fixing a lint warning in the leg that raised it (B-1054).
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
- **A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

### 5. Report

List the created children with their IDs and confirm the parent is at Decomposed. Each child is now an
Proposed ready for its own `/harmony-plugin:harmony-clarify`.
