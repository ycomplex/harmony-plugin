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
| `product` | `product-design` | Behaviour spec + refined/extended acceptance criteria (clarify originates the happy-path set — B-648) | `product` |
| `technical` | `technical-design` | Architecture / implementation approach | `engineering`, `operations`, `data` |
| `ux-ui` | `ux-ui-design` | Experience design — look, feel, interaction | `product`, `customer` |

> **UX/UI sub-track → visual hand-off (P6).** For `--track ux-ui`, the experience decision is decided through
> a **generated, manipulable surface + an iterate loop**, not a prose-only brief (B-328). Delegate the whole
> ux-ui sub-track to `/harmony-plugin:harmony-visual-handoff <task>` — it owns surface generation, the
> elicit-don't-guess iterate loop, and **files the ux-ui decision** (`record_decision` + `reference_knowledge`
> + `compose_brief` + `resolve_brief`, advancing to Designed only on the last required sub-track). Do **not**
> also draft or compose a ux-ui brief here. The Product and Technical sub-tracks continue with the flow below.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

> **Knowledge-entry shape (B-395).** Author every decision as ONE atomic claim shaped **Decision · Why · How-to-apply · Scope**; pick the narrowest `type`; multi-tag `domain`; respect the Asserted→human-Accept lifecycle (never pre-Accept a replacement). See the *knowledge-entry authoring standard* doctrine and `record_decision`'s description.

## Flow

### 1. Load + determine required sub-tracks (ticket-scoped completion read)

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
opinionated-mode activity (manual-mode projects use the normal board, not the clarify→decompose→design
lifecycle). This guard matters most here: on a **non-last** sub-track the brief composes with
`pending_activity: null`, so `resolve_brief` does not advance state and the P1 transition guard never
fires — without this check there is no substrate backstop. Then
`mcp__harmony__get_task({ task_id })`; confirm `workflow_state === 'Decomposed'` (or that designing is in
progress). Propose which sub-tracks this ticket *requires* (a backend-only ticket has no UX/UI track —
state-machine §5); the human can override.

To know which required sub-tracks are already **Accepted for THIS ticket**, use the ticket-scoped read —
**not** `query_knowledge`, which has no ticket filter (it returns no `source_task_id`):

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

### 1c. Honor a cross-ticket-completion flag (reconcile before designing)

Before designing, check whether this ticket's work is **already done** by another run (B-643): honor a `possibly-subsumed-by` annotation on the description (grep the `possibly-subsumed-by:` token → `get_task` the covering ticket → subsume + stop if it covers this work), AND independently check for a Verified/Deployed sibling via `search_tasks` (it reaches done work; `find_related_tickets` excludes Verified/Deployed). If a covering done sibling exists → `subsume_task` + stop; else proceed. Full mechanism + rationale: `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished."**

### 2. Query domain knowledge for THIS sub-track

Use the sub-track's domains (table above). E.g. a technical-design decision queries `engineering` +
`operations` (deploy/infra) + `data` (schema):

```
mcp__harmony__query_knowledge({ domain: ["engineering", "operations", "data"], search: "<sub-track decision subject>" })
```

Ground the decision in what you find; surface gaps. If a
load-bearing gap blocks the decision, go research-first (see knowledge-discipline) and invoke
`/harmony-plugin:harmony-research`.

### 2b. Acceptance criteria — self-heal the filing (EVERY sub-track), then refine and extend (product track)

Clarify ORIGINATES the happy-path ACs — they land at the clarification brief's accept
(`harmony-clarify/SKILL.md` §5). A **web accept with no session running** defers that filing to HERE.

**The filing-pass self-heal below runs on EVERY sub-track invocation — not only the product track
(B-747).** It previously sat inside the product track's step, and that scoping was the defect: a ticket
whose product-design brief was accepted in the browser, or one that requires no product track at all,
could run technical design, plan and build without the filing ever happening, because the step that owned
it was never re-entered. B-744 fixed *what* the self-heal checks; this fixes *whether it runs*. The
REFINE AND EXTEND step that follows stays product-track-only — adding design-dependent criteria genuinely
is that track's job, and only that track composes a brief they can land on.

**Self-heal filing-pass check (B-744) — the SAME predicate as clarify's own accept-path, never a
ticket-wide "has any AC" check and never a `brief_resolved` read.** A `list_acceptance_criteria`
EMPTY check is the exact B-698 defect under a new name (some unrelated AC already on the ticket
reads as "clarify already ran"), and `brief_resolved` fires the instant the human accepts —
*before* filing runs — so a web-accepted-no-session clarification carries a `brief_resolved` entry
while filing is still outstanding. Both are rejected as the trigger here.

1. **Find the clarification's brief_id** — this site is filing CLARIFY's proposed set on its behalf,
   so it keys on CLARIFY's brief, never this sub-track's own in-flight product-design brief (a
   different brief type entirely) and never the Accepted `specification` DECISION's own id (a
   different id space — the exact B-744 rework fix: using the decision id in a field named
   `brief_id` produced a marker that could never match a lookup keyed on the real brief id). Locate
   the ticket's Accepted `specification` decision that clarify itself authored —
   `harmony-clarify/SKILL.md` §3.1 — to confirm a clarification exists and to read its proposed-ACs
   content. **A ticket can carry more than one Accepted `specification` decision** — clarify's own
   clarified-intent record AND decompose's "no split" record (`harmony-decompose/SKILL.md`) are both
   `type: 'specification'` — so the selector must discriminate on `source_activity`, the gate/skill
   that authored the decision, never on `type` alone. `.find()` on `type` + `status` alone is
   ordering-dependent and can silently pick decompose's record instead of clarify's, filing the wrong
   AC content (or none) while still writing a filing-pass marker that reports success (B-744, reopened
   round 2):
   ```
   const refs = mcp__harmony__list_ticket_knowledge({ task_id })
   const clarification = refs.find(r => r.type === 'specification' && r.status === 'Accepted' && r.source_activity === 'clarify')
   ```
   Then recover the clarification BRIEF's own `id` — never `clarification`'s `decision_id` — from the
   ticket's activity trail, since this self-heal never holds the clarification brief object itself
   and `get_brief` only returns the currently-*active* brief (long since resolved by the time design
   runs):
   ```
   const activity = mcp__harmony__list_activity({ task_id })
   const resolved = activity.find(e =>
     e.event_type === 'brief_resolved' && e.metadata?.reason === 'clarification-draft')
   const clarificationBriefId = resolved.metadata.brief_id
   ```
   This is NOT the race B-744's first draft was rejected for: that draft would have gated the FILING
   decision itself on whether a `brief_resolved` event exists yet, which races clarify's own accept
   path (filing runs BEFORE `resolve_brief` there, so a web-accepted-no-session clarification can
   carry `brief_resolved` while filing is still outstanding). Here the event is read only to recover
   *which id to key on* — by the time this self-heal ever runs the ticket has already left
   `Clarified`, so clarify's `resolve_brief` (and therefore this event) unconditionally exists,
   filed or not. Whether the filing itself already happened is answered by step 2 below, never by
   this lookup. `clarificationBriefId` is the exact same `brief.id` clarify's own accept-path uses
   (`harmony-clarify/SKILL.md` §5) — captured once, as plain text, in the marker comment; it needs
   no further round-trip through `get_brief` to stay usable, which is what makes the two sites
   interlock under one key instead of writing two non-interlocking records.
2. **Check for an existing filing-pass record scoped to that id:**
   ```
   mcp__harmony__list_comments({ task_id })
   ```
   Match a line `AC-FILING-PASS brief_id=<clarificationBriefId> filed=<N>` — an exact
   `brief_id` match, never fuzzy text matching against rendered brief prose.
   - **Found → the happy-path set is already filed** (by clarify's own accept-path, or a prior run
     of this self-heal) — do not re-file it. Read the current set (`list_acceptance_criteria`) and
     go straight to the ADD/SHARPEN step below.
   - **Not found → file the clarification's proposed happy-path set now, unconditionally** —
     regardless of what other unrelated ACs already exist on the ticket — from the clarification
     brief's structured proposed-ACs data (`clarification`'s content, the `source_activity === 'clarify'`
     decision resolved in step 1 above, never decompose's — and never re-parsed from THIS brief's
     rendered markdown, which never carried them):
     ```
     mcp__harmony__manage_acceptance_criteria({ task_id, add: [{ content: "..." }, ...] })
     ```
     then write the filing-pass record — **a zero-count pass still writes it** (a silent zero is
     exactly the original bug's failure mode, so zero must be exactly as loud as N):
     ```
     mcp__harmony__add_comment({ task_id, content: `AC-FILING-PASS brief_id=${clarificationBriefId} filed=${N}` })
     ```
   This one comment IS the idempotency marker — no second mechanism layered on top.

Then, either way:

- **ADD** the design-dependent criteria — edge cases, error paths, non-functional
  (mechanism-register criteria belong here, not at clarify). You may **SHARPEN** a happy-path AC
  (update). **NEVER silently drop a clarify-authored AC** — a drop is an explicit decision item on the
  design brief that the human accepts.
- The product track's AC writes (add/update/delete via `manage_acceptance_criteria`) land at ITS
  brief's ACCEPT, symmetric with clarify — never at compose.
- **Product track only — keep the ADD/UPDATE/DELETE lists you just decided; step 4's `doc.payload`
  carries them so a cross-session accept can apply them automatically (B-810).**

### 3. Draft the typed decision (Asserted)

```
const decision = mcp__harmony__record_decision({
  type: "technical-design",            // or product-design / ux-ui-design
  title: "<ticket>: <sub-track> — <decision>",
  content: "<the decision + rationale>",
  madr: { context: "...", decision_drivers: ["..."], considered_options: ["..."], decision_outcome: "...", consequences: ["..."] },
  domain: ["engineering", "operations"],
  source_type: "manual",
  source_activity: "design-decide",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

**Revising THIS ticket's own governing sub-track decision (B-715 defense in depth).** Before drafting a
brand-new decision on a `revising-*` re-entry, check whether this same ticket already has an Accepted
decision for this sub-track:
```
const refs = mcp__harmony__list_ticket_knowledge({ task_id })
const priorOwn = refs.find(r => r.type === '<this sub-track's decision type>' && r.status === 'Accepted')
```
If `priorOwn` exists, this revision is superseding this SAME ticket's own governing decision — prefer
`mcp__harmony__update_knowledge_entry` (amend-in-place with a dated "REVISED by <ticket>" banner, status
stays Accepted) over authoring a fresh `record_decision`, per the B-460/B-581 amend-not-supersede
convention (§6 below) and `harmony-stale-patch`'s existing amend-vs-supersede rule. Amending in place keeps
the ticket from spuriously self-flagging Stale off its own revision. The stale-coupling trigger's
self-supersede skip (B-715, Part 4 of this fix) is a second, DB-level backstop for when this is missed or
skipped — not a substitute for choosing amend here. Only fall through to a fresh `record_decision` when no
prior Accepted decision exists for this sub-track on this ticket, or the human explicitly chooses "retire
and replace" over "amend" for this revision.

### 4. Compose the brief — advance only on the LAST required sub-track

Author the brief per `skills/harmony-shared/brief-authoring.md` §Design — the question, must-haves,
and engagement it owes the human, plus the legibility contract. Consult it; do not restate it.

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
    recommend: { text: "Reuse the existing per-user settings JSONB column", confidence: "high" },
    why: ["Existing settings store handles per-user state", "Avoids a new table + RLS"],
    alternatives: [{ option: "New saved_filters table", rejection: "More schema + RLS for v1 scope" }],
    items: [{ kind: "decision", text: "Where saved-filter state lives", recommendation: "settings JSONB" }]
  }
})
```

**`doc.payload` — PRODUCT track only (B-810).** Carry step 2b's ADD/UPDATE/DELETE lists in as
structured items, `ref` via `slugRef(...)` + `dedupeRefs(...)` over the whole list
(`src/tools/payload-refs.ts`'s scheme, the one every gate reuses):
- Each **ADD** → a recognized `acceptance_criterion` item: `{ write_kind: "acceptance_criterion", ref:
  slugRef("ac", content), content }`.
- Each **UPDATE** / **DELETE** → a **forward-compat, NOT-yet-applied** kind — `acceptance_criterion_update`
  `{ ref: slugRef("ac-update", from_ac_id), from_ac_id, content }` / `acceptance_criterion_delete`
  `{ ref: slugRef("ac-delete", from_ac_id), from_ac_id }` — keyed off the AC's OWN stable id
  (`from_ac_id`), never off `content`, since the new wording can change across an iterate while the
  identity of which AC is being touched does not; a content-keyed ref would silently mint a second
  logical write on a re-word instead of re-deriving the same one. Neither RPC exists yet, so including EITHER
  kind deliberately makes the WHOLE payload classify `'unrecognized'` (`classifyPayload` requires
  every item's `write_kind` to be recognized) — auto-consume is skipped and the accept falls back to
  this track's own `manage_acceptance_criteria` call, exactly as before this payload existed. An
  ADD-only sub-track (the common case) is fully structured and applies automatically; the moment any
  update/delete is present, correctness — never a silent partial apply — takes priority over
  automation. Technical and UX/UI sub-tracks author no AC writes at all, so their briefs carry no
  `payload` (unchanged).

```
// dedupeRefs([
//   ...adds.map(a => ({ write_kind: "acceptance_criterion", ref: slugRef("ac", a.content), content: a.content })),
//   ...updates.map(u => ({ write_kind: "acceptance_criterion_update", ref: slugRef("ac-update", u.ac_id), from_ac_id: u.ac_id, content: u.content })),
//   ...deletes.map(d => ({ write_kind: "acceptance_criterion_delete", ref: slugRef("ac-delete", d.ac_id), from_ac_id: d.ac_id })),
// ])
payload: [
  { write_kind: "acceptance_criterion", ref: "ac-empty-filter-list-shows-cta", content: "With zero saved filters, the list view shows a create-one call to action" }
]
```

**Decision-only completion line (B-681).** If the ticket carries the **`decision-only` label** (a decision
ticket whose deliverable IS this design decision — e.g. an inception S2 decision ticket), the **last
required sub-track's** brief is its **deliverable gate**: that brief MUST carry an explicit completion line
in its context — *"Accepting this completes the ticket to Verified via the decision-only fast-forward;
nothing is built, and the decided thing's realization stays `agreed`."* (Author the design decision itself
with `realization: 'agreed'` — decided-not-yet-built.) The completion is never silent, and that brief is
**hard-floor** — never auto-advanced under any delegation flag (see
`skills/harmony-shared/gate-routing.md` §The decision-only fast-forward). A non-last sub-track brief is
unaffected.

### 5a. De-risk the decision

A read-through is **NOT** a de-risk. For any load-bearing integration / auth / cross-surface handshake, before
you write *"no adapter needed"* / *"this just works"*:

1. **Trace the EXACT mechanism on BOTH sides and name them** — what token *format*, what verification *method*,
   not just "a JWT." Name the concrete contract each side actually speaks.
2. **Where feasible, RUN the smallest *live* call** — a real request, not a mock. The functional smoke **IS** the
   de-risk; a passing one-shot beats a confident paragraph.
3. **If you can't run it at design time, record it as an explicit build/verify gate** — never as "de-risked."

A read-through can launder a confidently-wrong conclusion into Accepted knowledge. This **sharpens** the existing
convention `6b12ee67` ("de-risk with the cheapest highest-information experiment before building"): for a
load-bearing handshake the cheapest *high-information* experiment is the live smoke, not another read.

### 5. Display + resolve

Show the rendered `content`. On the human's command:

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conductor-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })`
  → promotes this decision
  Asserted→Accepted. **B-797 (product track only — the response's `pending_acceptance_event_id` is null
  for the technical/ux-ui sub-tracks, which stay synchronous):** if non-null, the advance (if
  `pending_activity: "designing"` was carried — the last required sub-track) is DEFERRED to this event,
  not applied yet. Since you already performed this track's AC add/update/delete writes above (step 2b) —
  there is nothing left to APPLY, only the deferred advance to COMMIT. Call
  `mcp__harmony__consume_acceptance_event({ event_id: <that id> })` right away, in this same turn. Then
  report whether the ticket is now Designed or still needs other sub-tracks.
  **Decision-only fast-forward (B-681):** if the ticket carries the `decision-only` label AND this was the
  LAST required sub-track (the brief carried the completion line), run the trailing mechanical completion
  the accept just authorized:
  ```
  mcp__harmony__advance_workflow({ task_id, activity: "fast-forwarding" })   // Designed -> Verified
  ```
  — one human accept, two writes; report the ticket as **Verified (decision-only fast-forward, realization
  stays 'agreed')**. Idempotent guard: skip if the ticket is already Verified. A WEB accept with no session
  running leaves the trailing fast-forward to the next running session (re-run the conductor to apply it).
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
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise and re-call `compose_brief`.
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
- **A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

### 6. Cross-cutting scope (optional)

If the decision has scope beyond this ticket (state-machine §8.3 — `this-ticket-and-descendants` /
`named-peers`), note it in the decision `content` so a later supersession knows what it affects. (Full
scope-propagation automation is deferred.)

**Amend vs supersede when this decision REVISES a governing invariant (B-585).** Separate the invariant's
**goal** from its **mechanism**. If this decision **revises-in-part** (reverses/refines *one clause* of a
multi-clause Accepted decision, especially on a Verified ticket) → `update_knowledge_entry` + a dated
"REVISED by <ticket>" banner and **keep status Accepted** (no Stale cascade onto dependents). If it **retires**
the governing decision wholesale → `supersede_decision`. Present amend-in-place vs supersede as the human's
explicit choice. The full reconciliation recipe lives in `harmony-stale-patch` §3 (b460 / b581 / `f80ce0f6`).
