---
name: harmony-design-decide
description: Make a design decision on one sub-track (Decomposed → Designed). Triggers on "design B-123", "harmony design-decide B-123 --track ux-ui", "decide the technical approach". Runs one of three sub-tracks — Product Design, Technical Design, UX/UI Design — querying domain knowledge, drafting a typed decision, and filing it as a brief. State advances to Designed only when all required sub-tracks are accepted.
capabilities: harmony-mcp read web
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
---

**Knowledge claims:** Author `claim` as one quotable sentence (at most 50 words) on every `record_decision` / `create_knowledge_entry` write, and on `update_knowledge_entry` when confirming or replacing a claim. A successor uses `claim` in `supersede_decision` or `new_claim` in `supersede_knowledge_entry`; retire-only calls have no successor claim. On every entry-producing `compose_brief`, author the exact approved sentence as `doc.claim`, separately from the recommendation. Use a sentence-shaped title; compatibility-derived proposals are unconfirmed, not authored statements.

> **No `disallowed-tools` here (B-1117, 2026-10-13).** This skill never edits code or runs git — that is
> its role, stated in prose — but it no longer *revokes* Write/Edit/git: Claude Code applies an invoked
> skill's `disallowed-tools` to the rest of the session, subagents included, so in an auto-approved run
> (several gates in one worker leg) the revocation reached the build gate and denied its commit
> (B-1115). Same class as B-1114 (the conduct skill's Edit revocation).

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
> also draft or compose a ux-ui brief here. The Product and Technical sub-tracks continue with the flow below. On the Figma path the hand-off composes only in
> the project's working file per `harmony-visual-handoff` 3c "Working file (B-1325)".

For a feature-changing UX/UI hand-off, pass the shared
`skills/harmony-shared/current-account-maintenance.md` procedure to the owning
visual-handoff flow as well: capture the clause intent in its ratified brief and
reconcile after acceptance. Its generated surface does not authorize publishing
account text. Unchanged behaviour reuses an earlier sub-track's accepted intent.

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

> **Knowledge-entry shape (B-395).** Author every decision as ONE atomic claim shaped **Decision · Why · How-to-apply · Scope**; pick the narrowest `type`; multi-tag `domain`; respect the Asserted→human-Accept lifecycle (never pre-Accept a replacement). See the *knowledge-entry authoring standard* doctrine and `record_decision`'s description.

## Flow

### 1. Load + determine required sub-tracks (ticket-scoped completion read)

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
Guided-mode activity (Freeform-mode projects use the normal board, not the clarify→decompose→design
lifecycle). This guard matters most here: on a **non-last** sub-track the brief composes with
`pending_activity: null`, so `resolve_brief` does not advance state and the P1 transition guard never
fires — without this check there is no substrate backstop. Then
`mcp__harmony__get_task({ task_id })`; confirm `workflow_state === 'Decomposed'` (or that designing is in
progress). Propose which sub-tracks this ticket *requires* (a backend-only ticket has no UX/UI track —
state-machine §5); the human can override.

**A linked designer frame always gets the UX/UI track (B-1320).** Before you propose any track as
`not-required`, run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" design adopt-check --task <ticket> --links-only`
(read-only, one JSON line). When it reports a readable Figma frame link on the ticket (description or comments), the
UX/UI track is **required**, even when the layout looks settled: the track is what runs the adopt check
(`harmony-visual-handoff` 3c "Adopt first"). Never mark UX/UI `not-required` while such a frame is unjudged. If the
check cannot run (no Figma connection, command unavailable), say so on the brief rather than declaring the track away.

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

**Product-track coverage check (B-1203) — Figma-connected workspaces only.** Run it **only when the Figma
connection preflight resolves to `figma`** (`src/tools/figma-connection.ts`). When it resolves to `html`,
`stop`, or cannot be read, this check does not run and the track proposal above is exactly as it always was.
Read the clarify slot's `sketch` and the clarify exchange's answered questions
(`mcp__harmony__get_elicitation`). For each product-behaviour point in the clarification and its criteria, mark
it **covered** if an answer or a sketch frame settles it. **All covered** → propose the product track as
`not-required`, with a note naming the answers and frames that cover it. **Some uncovered** → the product track
runs on the residual only, and its brief lists **"Already answered, not re-asked"**. An existing sketch is
reused, never recomposed. Any Figma composing uses the project's working file per `harmony-visual-handoff` 3c
"Working file (B-1325)" (never the library file).

**"I've made edits in Figma" (B-1204).** A marker `pending_resolution.command === 'edited-in-tool'` (poll trigger
`edited-in-tool`) on a design brief is **not** a worded reshape: route it to
`skills/harmony-visual-handoff/SKILL.md` → **Reconcile a designer's edits (B-1204)**, which reads the edits back over
REST and recomposes the brief in place.

### 1c. Honor a cross-ticket-completion flag (reconcile before designing)

Before designing, check whether this ticket's work is **already done** by another run (B-643): honor a `possibly-subsumed-by` annotation on the description (grep the `possibly-subsumed-by:` token → `get_task` the covering ticket → subsume + stop if it covers this work), AND independently check for a Verified/Deployed sibling via `search_tasks` (it reaches done work; `find_related_tickets` excludes Verified/Deployed). If a covering done sibling exists → `subsume_task` + stop; else proceed. Full mechanism + rationale: `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished."**

### 1d. Reconcile accepted feature-account intents on pickup (B-1235)

Follow `skills/harmony-shared/current-account-maintenance.md` → **Reconcile accepted
intents** before drafting another sub-track. Consume pending acceptance events through
the normal owning-gate path first. Read ticket comments and the source decisions,
including a prior sub-track accepted in the browser with no session running. Resume
only ratified intents; an Asserted draft's comment does not authorize a proposal.
Unavailable account tools/storage produce an explicit blocked maintenance record,
never a generic entry write. This is a side-effect consume, not another gate accept.

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
     e.event_type === 'brief_resolved' && e.metadata?.command === 'accept' &&
     e.metadata?.reason === 'clarification-draft')
   const clarificationBriefId = resolved.metadata.brief_id
   ```
   **`metadata.command === 'accept'` is load-bearing, not decoration (B-896).** `brief_resolved` is
   the event type for every recorded brief decision, not just accepts: `reshape_brief` records an
   `iterate` under the same event type and the same `reason`, so a reason-only predicate would match
   a *send-back-for-rework* entry — a clarification that was pushed back, not one that concluded —
   and key the filing-pass marker off it.

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

   **Fallback when this lookup finds nothing (B-816) — `clarification` or `resolved` comes back
   `undefined`, so there is no id to key the filing-pass marker on.** When THIS self-heal is reached
   via `harmony-conduct` §1c's `payload-unrecognized` route for `clarification-draft`, that caller
   already holds `consume_pending_acceptance_event`'s echoed `items` (the `acceptance_criterion`
   entries clarify's own `compose_brief` authored at `doc.payload`, B-810) — present THOSE items for
   confirm (never re-derive, never re-read the brief) and file them via `manage_acceptance_criteria`
   on the human's confirm, same as step 2's "not found" branch below, keyed on the ticket id (there is
   no `clarificationBriefId` to scope the marker to in this branch — key the marker on the ticket
   instead: `AC-FILING-PASS task_id=<task_id> filed=<N>`). When this self-heal is instead reached
   generically (every sub-track invocation, independent of any B-797 event — no `items` available),
   this is `ac-pickup-points.md` route 5: a ticket clarified before criteria-at-clarify existed
   (pre-B-648) genuinely has no proposed set anywhere to echo — the only legitimate open question is
   an elicitation round asking the human to state the happy-path criteria from scratch, since nothing
   was ever captured to confirm.
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
- The product track's AC writes land at ITS brief's ACCEPT (§5), symmetric with clarify — never at
  compose. **Which mechanism performs them there is a genuine branch (B-1034), because
  `acceptance_criterion_update` / `acceptance_criterion_delete` are deliberately OUTSIDE
  `KNOWN_WRITE_KINDS` (§4):**
  - **This round's edits are ADD-only** (every proposed change is a plain new criterion — no SHARPEN,
    no drop) — **do NOT call `manage_acceptance_criteria` for them yourself, at compose OR at accept.**
    They ride as `acceptance_criterion` payload items (§4) and land SOLELY through §5's ledgered
    `consume_pending_acceptance_event` call — a manual write first would double-file against that same
    ledgered insert (the ledger's `ON CONFLICT` key on `(event_id, write_kind, external_ref)` can't see
    a write it didn't make).
  - **This round's edits carry a SHARPEN (update) or a drop (delete) — alongside any adds in the SAME
    round** — the whole payload classifies `'unrecognized'` (one non-`KNOWN_WRITE_KINDS` item drags
    every item in the round down with it, adds included; see §4), so the ledger will never auto-apply
    ANY of it. This branch is **unchanged, intentionally**: execute every add/update/delete yourself via
    `manage_acceptance_criteria`, at this track's brief ACCEPT (§5) — it is the only writer for this
    round, and always was.

### 3. Draft the typed decision (Asserted)

```
const decision = mcp__harmony__record_decision({
  claim: "<one sentence stating what this entry establishes>",
  type: "technical-design",            // or product-design / ux-ui-design
  title: "<ticket>: <sub-track> — <decision>",
  content: "<placeholder — one line: '<sub-track> decision for <ticket>; body derived from the ratified brief'>",
  madr: { context: "...", decision_drivers: ["..."], considered_options: ["..."], decision_outcome: "...", consequences: ["..."] },
  domain: ["engineering", "operations"],
  source_type: "manual",
  source_activity: "design-decide",
  source_task_id: "<task uuid>",
  // B-1000: an agent-authored draft, same reasoning as harmony-clarify's own spec-draft note — append
  // ':<mode>' under harmony-conduct; this is not the accept's own provenance.
  provenance: "agent-synthesized",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

> **B-866 — the entry's prose is DERIVED, not authored here.** `content` above is a **placeholder seat**,
> not the entry's text. The brief's accept promotes `renderEntry(doc)` — a mechanical projection of the
> very `doc` you compose below — so anything you would have written into the entry belongs in the doc
> (`recommend` / `why` / `alternatives` / `context` / `frame`). Do not write the decision out twice, and
> do not hand-author a `knowledge_entry_content` payload item: `compose_brief` derives it, sets its `ref`
> and `entry_id`, and REPLACES anything you author there. See
> `skills/harmony-shared/brief-authoring.md` §"The brief is the only authored copy".

> The `madr` block is NOT derived — it is structured metadata, not prose, and it keeps its own authored
> value. Only the entry's `content` body is the projection.

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

**Affected feature account (B-1235).** Before composing, follow
`skills/harmony-shared/current-account-maintenance.md` → **Capture the intent before
the design brief**. Record each affected account's exact clause replacements and
untouched neighbours on the ticket and include the intent in `doc.context`, linked
to THIS separate design decision. Do not submit while that decision is Asserted.
State pending-only authorship explicitly; `current_text` remains live production.
When no feature is affected, give a concrete `not-applicable` scope reason. Absent
capability is instead `blocked-unavailable` and stays visible through plan/build and release.

Set `pending_activity: "designing"` **only if this is the last required sub-track** (all others already
Accepted). Otherwise set `pending_activity: null` — accepting this brief promotes the decision and clears
the flag without advancing state (state advances to Designed only when *all* required sub-tracks are in).

**Also author `doc.frame` (B-876) — the design gate's own must-haves.** One gate reason serves three
sub-tracks and three different readers, and the brief today cannot say which of three serialized
decisions the human is holding, what the other tracks own, or how far this decision reaches. The frame
says all of it:

- **`track` + `tracks[]`** — which sub-track this brief decides, and the status of the others
  (`accepted` / `this-brief` / `pending` / `not-required`). A `not-required` entry MUST carry a `note`:
  declaring a track away is a decision, and it is the line a designer would object to. B-698 shipped a
  new status vocabulary with no designer in the loop off an uncontested `context[]` aside.
- **`reach`** — the spillover: how far this decision goes beyond this ticket. `brief-authoring.md` calls
  it the highest-signal element of the brief and it rendered as a labelled block in 2/14. The KEY is
  required; `[]` ("this reaches nothing beyond the ticket") is a real answer, and a *negative* reach
  claim is often exactly what carries a no-UX/UI-track proposal.
- **`not_reopened`** — the upstream decisions this brief is NOT reopening. Scope discipline.
- **`derisk`** — `run` is what you actually executed; `not_run` is what was NOT run and is NOT claimed.
  Both halves, always: "not run and not claimed" is the easiest sentence in a brief to skim past.
- **`files_on_accept`** — **PRODUCT TRACK ONLY**: the AC manifest this accept files, as a list. The
  product accept is a WRITE and nothing marks it today.
- **`reach_level` + `rules[]` (B-1047)** — see **Reach and rules** below. Every design brief, on every
  track (product, technical, and the delegated ux-ui track), declares its reach level.

**Reach and rules (B-1047).** A rule future tickets must follow is recorded once, as a rule, at accept.

- **Every design brief must declare `frame.reach_level`**: `this_ticket_only` | `this_surface` |
  `this_product`. A frame with no `reach_level` composes with a warning (legacy only); never author one.
- **A beyond-ticket design must produce a rule.** `this_surface` or `this_product` with zero
  `frame.rules` is refused at compose. `this_ticket_only` creates no rule: it may carry only
  `reference` rules (citing an existing one); `create` / `amend` are refused.
- **Each rule** is `{ ref, operation: create|amend|reference, wording, domains[], surfaces[],
  knowledge_scope: product|deployment, reach: this_surface|this_product, target_entry_id,
  expected_fingerprint, before?, title? }`. `create` and `amend` require `wording`, `knowledge_scope`
  and `reach`; `wording` is the exact obligation, shown verbatim before acceptance. `amend` and
  `reference` name `target_entry_id` + `expected_fingerprint`; `amend` also carries `before` (the
  target's current content) so the brief shows before and after. A `reference` carries **no**
  `wording` (and no `knowledge_scope` / `reach`; the server ignores them): it renders as "Cites rule
  <target_entry_id>", plus the optional display-only `title`. `before` and `title` never reach the payload.
- **Match before you declare.** Search Accepted rules first: `query_knowledge` with type `convention`
  and tag `rule`, same project, the same domains and surfaces. Read every candidate in full, then:
  - equivalent obligation and applicability ⇒ `reference` it. **Reference the existing rule, never
    restate its wording**: a design that restates an existing rule must instead reference it.
  - same rule, changed wording ⇒ an explicit `amend` with the target and its expected fingerprint.
  - ambiguous or conflicting candidates ⇒ do not guess; return to design or elicit from the human.
  - a different obligation ⇒ `create`.
- **Obtain the target from the registry, never guess it.** For each candidate you will amend or
  reference, read its registry row: `read_rule_registry({ entry_id: "<candidate id>" })` (or
  `read_rule_registry({ search: "<claim words>", domains: [...], surfaces: [...] })` to scan; CLI
  `harmony knowledge rules --entry <id>`). It returns `{ availability, rules: [{ entry_id, fingerprint,
  normalized_claim, scope, reach, domains, surfaces, title, status, content }] }`. Set
  `target_entry_id` = `entry_id` and `expected_fingerprint` = `fingerprint` (the sha256 of the entry's
  current content). For an `amend`, quote that row's `content` verbatim as `before`; for a `reference`,
  you may pass its `title`. A candidate with no registry row is not a registered rule: it cannot be an
  amend/reference target. If `availability` is `'unavailable'`, the rule registry is not on this
  environment yet: amend and reference cannot be declared here. Say so in the brief and never guess a
  fingerprint.
- **Compose derives the payload** item `rule_bundle` from `frame.rules`; never hand-author it. On an
  environment without the B-1047 database support, a brief with rules is refused at compose: say so,
  never drop the rules to get it through.

`frame.kind` must be `"design"`; the render places it below the recommendation. The `ux-ui-design` track
is the one exempt from the alternatives rule — `visual-handoff.md` §D2 forbids auto-generating a guessed
variant, so an empty `alternatives` is correct there and only there.

```
mcp__harmony__compose_brief({
  task_id,
  reason: "design-decision-draft",
  pending_activity: <"designing" if last required sub-track, else null>,
  decision_ref: { type: "technical-design", id: decision.id },
  doc: {
    claim: "<the exact one-sentence claim the human will approve>",
    decide: "Technical approach for the saved-filter store?",
    recommend: { text: "Reuse the existing per-user settings JSONB column", confidence: "high" },
    frame: {
      kind: "design",
      track: "technical-design",                      // the sub-track THIS brief decides
      tracks: [
        { track: "product-design", status: "accepted" },
        { track: "technical-design", status: "this-brief" },
        { track: "ux-ui-design", status: "not-required", note: "<why — e.g. an operator table view analogous to the existing views, not a new visual language. Override me if you disagree.>" }
      ],
      reach: ["<what this decision touches beyond this ticket>"],   // [] is a real answer; absence is not
      reach_level: "this_surface",                    // this_ticket_only | this_surface | this_product (B-1047)
      rules: [{ ref: "rule-<slug>", operation: "create", wording: "<the exact obligation>",
                domains: ["<domain>"], surfaces: ["<surface>"], knowledge_scope: "product",
                reach: "this_surface", target_entry_id: null, expected_fingerprint: null }],
      // a reference cites, never restates: rules: [{ ref: "rule-<slug>", operation: "reference",
      //   domains: [...], surfaces: [...], target_entry_id: "<entry_id>",
      //   expected_fingerprint: "<fingerprint from read_rule_registry>", title: "<its title>" }]
      not_reopened: ["<the upstream decisions this brief does NOT reopen>"],
      derisk: { run: ["<what you actually executed, with the observation>"],
                not_run: ["<what was NOT run and is NOT claimed>"] }
      // PRODUCT TRACK ONLY — the AC manifest this accept files:
      // , files_on_accept: ["<criterion 1>", "<criterion 2>"]
    },
    why: ["Existing settings store handles per-user state", "Avoids a new table + RLS"],
    alternatives: [{ option: "New saved_filters table", rejection: "More schema + RLS for v1 scope" }],
    items: [{ kind: "decision", text: "Where saved-filter state lives", recommendation: "settings JSONB" }]
  }
})
```

**Also author `doc.payload` with an `entity_link` item, on EVERY sub-track — not just product (B-997).**
Read `field_values.implements_entities` off `get_task` (it may already be in context from step 1) — the
array of feature-entity name(s) clarify's own accept confirmed:
- **Present with one or more names** → one `entity_link` item PER NAME, added to this SAME `doc.payload`
  (alongside the product track's own AC edits below, when this is the product sub-track — the two
  coexist in one array):
  ```
  { write_kind: "entity_link", ref: slugRef("entity", name), entity_name: name, kind: "feature", decision_id: decision.id }
  ```
  Names in `implements_entities` are feature entities, so author `kind: "feature"` (author the kind the
  entity actually is if you link something else). A name-only item for an ambiguous name is refused before any write.
- **Absent entirely** (the PERMANENT state for every ticket already past clarify before B-977 shipped —
  e.g. B-975, B-978, and every other open v1.5 ticket at Designed-or-later; not a transition window that
  closes) or **present but an empty list** (`names: []` — a legitimate "no linkable feature" answer) →
  author NO `entity_link` item at all. No throw, no warn, no empty-edge write.

`consume_pending_acceptance_event` (step 5) resolves each name to an entity (create-if-absent, via the
SAME path `record_decision`'s `affected_entity_names` uses) and lands BOTH edges —
`ticket_implements_entity` and `decision_affects_entity` — the write the old inline `link_ticket_entities`
call used to make at accept; it now lands whether the accept happens in this session or over the web with
no session at all (B-997 — the inline call was measurably inert in the latter case).

**On an iterate (round 2+), also author `doc.revision`** — `{ round, changes: [{ change, responds_to }] }`,
one entry per change made this round, each bound to the feedback it answers. It renders under the
**On accept:** line, never above the frame: the human approves the totality, never the diff.

`doc.revision` and `iterate_feedback` are not substitutes for each other and you owe BOTH: `doc.revision`
records what YOU changed, `iterate_feedback` records what THEY said, verbatim (B-843).

**PRODUCT track only (B-810) — also author `doc.payload` for step 2b's ADD/SHARPEN/drop edits.** The
technical and UX/UI sub-tracks author no `doc.payload` at all (they carry no AC edits — unchanged by
B-810). For the product track, mirror step 2b's edits exactly:

- An **ADD** (a genuinely new design-dependent AC) → a recognized `acceptance_criterion` item —
  `{ write_kind: "acceptance_criterion", ref: slugRef('ac', content), content }`.
- A **SHARPEN (update)** of an existing AC → the literal, deliberately-UNRECOGNIZED `write_kind:
  "acceptance_criterion_update"` — `{ write_kind: "acceptance_criterion_update", ref: slugRef('ac',
  content), content, from_ac_id: "<the AC's own id being sharpened>" }`. Deliberately absent from
  `KNOWN_WRITE_KINDS` (acceptance-events.ts) — never "fix" this by adding it there; that file is out of
  scope.
- A **drop** of an existing AC (never silent — step 2b's own rule) → the literal, deliberately-
  UNRECOGNIZED `write_kind: "acceptance_criterion_delete"` — `{ write_kind: "acceptance_criterion_delete",
  ref: slugRef('ac', content), content, from_ac_id: "<the AC's own id being dropped>" }`.

Because `classifyPayload` (acceptance-events.ts) requires EVERY item to carry a recognized `write_kind`
before it will call this payload `'structured'`, a SINGLE update/delete item downgrades the WHOLE payload
to `'unrecognized'` — which is exactly the intended fallback: the B-797 cross-session consumer refuses to
auto-apply an unrecognized payload and instead routes to this track's OWN accept step (step 5 below,
step 2b's inline add/update/delete), which already performs the real writes. An **add-only** product-design
brief (the common case: only new ACs, nothing sharpened or dropped) is therefore fully recognized and
auto-applies with zero agent judgment on a web accept with no session running. `ref`s in both cases come
from `slugRef`/`dedupeRefs` (`payload-refs.ts`) — never reinvented.

**The fallback when step 5's accept step runs in a FRESH session (B-816) — never re-derive the
ADD/SHARPEN/DROP set from scratch.** The routing above assumes step 5 runs with step 2b's just-drafted
edits still in context (the same-session accept path) — but when `harmony-conduct` §1c routes here for a
`payload-unrecognized` `design-decision-draft` event picked up in a LATER session, that context is gone.
Do NOT re-derive the edits by re-reading the design decision and guessing what changed, and do NOT ask
the human to restate which ACs were added/sharpened/dropped — the accepted brief's snapshot already
carries the exact write_kind-tagged set verbatim on `consume_pending_acceptance_event`'s `items` field
(B-816). Present those items for confirm (each `acceptance_criterion` as an add, each
`acceptance_criterion_update` as a sharpen with its `from_ac_id`, each `acceptance_criterion_delete` as
a drop with its `from_ac_id`), then on confirm execute them via the SAME `manage_acceptance_criteria`
calls step 5 always makes.

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

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conduct-loop-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })`
  → promotes this decision
  Asserted→Accepted. **B-904 extended B-797 to every design track** — the response's
  `pending_acceptance_event_id` is non-null for product, technical, AND ux-ui sub-tracks alike (all three
  derive a `knowledge_entry_content` payload item uniformly, per `GATE_REASON_FLOW`); none stay synchronous
  anymore. If non-null, the advance (if
  `pending_activity: "designing"` was carried — the last required sub-track) is DEFERRED to this event,
  not applied yet. **This track's AC add/update/delete writes (§2b) branch on shape, per §2b/§4's
  ADD-only-vs-mixed split (B-1034) — do not assume either half unconditionally:**
  - **ADD-only this round** — nothing has been manually written for those items yet (§2b deliberately
    skipped the manual call). The ledgered call below is their SOLE writer.
  - **SHARPEN/drop carried this round (alongside any adds)** — you already performed those writes
    directly above (§2b), unchanged, and this event's payload classifies `'unrecognized'` for that exact
    reason (§4), so the ledgered call below will not re-touch them.

  Either way, B-866/B-867 mean the SAME event's payload can ALSO carry `knowledge_entry_content` (and
  possibly `gate_slot`) items this skill never materializes on its own — so this is NOT commit-only. Call
  `mcp__harmony__consume_pending_acceptance_event({ task_id })` right away, in this same turn (B-1029:
  swapped from the commit-only `consume_acceptance_event`). On an ADD-only round this call is what files
  the new criteria — report the count from `by_write_kind.acceptance_criterion` — as well as landing
  those other write kinds. On a mixed round, per §4's classification, this call sees an `'unrecognized'`
  payload and never re-applies (or double-files) the AC edits you already made above — that branch's
  behavior is unchanged by B-1034.

  **Rule bundle (B-1047).** When the brief declared `frame.rules`, that same call applies the
  `rule_bundle` FIRST (preflight, apply the bundle, then project the design), as one ledgered write.
  A refusal (`B-1047: …`, e.g. a stale amend target) rolls the bundle back and leaves the event pending:
  report the blocker verbatim and do not advance. A retry skips a bundle that already committed.

  **Fingerprint the accepted Figma design (B-1203).** Right after that `consume_pending_acceptance_event`
  call, when the accepted brief's frame carries a **figma** `design_artefact`, run
  `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" design fingerprint take --task <ticket>` (a `harmony` on PATH works
  too). It takes ONE REST read of the accepted frames and stores a content fingerprint at
  `field_values.design_fingerprint`, which the plan and build gates compare later to detect drift (a
  versionless record has no version to compare). It exits 0 on every expected state and prints one JSON line.
  A failure (no token, Figma unreachable, rate limited) is written as `not-taken` with a reason and **never
  blocks** the accept or the advance; say so in your report. A non-Figma design, or one without nodes, is
  skipped with no write. The token comes from `HARMONY_FIGMA_TOKEN` or `/secrets/figma/pat` and is never
  echoed. The web only displays the status; it never calls Figma.

  **The ticket + decision's implemented-entity edges (B-977) already landed above (B-997).** Step 4's
  `doc.payload` authored one `entity_link` item per confirmed name (three-state handling: present/
  absent/empty — see step 4), and the SAME `consume_pending_acceptance_event` call just above lands them
  — there is nothing further to do here. This replaces what used to be a separate inline
  `link_ticket_entities` call here — that call only ever ran in a same-session accept, so the wiring was
  measurably inert whenever the accept happened over the web with no session running.

  Then report whether the ticket is now Designed or still needs other sub-tracks.
  **Before returning or advancing to the next gate**, reconcile this track's accepted
  feature-account intents per `skills/harmony-shared/current-account-maintenance.md`.
  The source must now be Accepted and its acceptance payload consumed. Read, preview
  and propose through the guarded foundation tools; record/read back pending amendment
  ids or explicit blockers. This also runs for non-last tracks. Never publish live
  text, emit an `amended` claim or use the separate decision's generic edit path as an
  account writer. A fresh pickup runs §1d when acceptance occurred outside this session.
  **Decision-only fast-forward (B-681):** if the ticket carries the `decision-only` label AND this was the
  LAST required sub-track (the brief carried the completion line), run the trailing mechanical completion
  the accept just authorized:
  ```
  mcp__harmony__advance_workflow({ task_id, activity: "fast-forwarding" })   // Designed -> Verified
  ```
  — one human accept, two writes; report the ticket as **Verified (decision-only fast-forward, realization
  stays 'agreed')**. Idempotent guard: skip if the ticket is already Verified. A WEB accept with no session
  running leaves the trailing fast-forward to the next running session (re-run the conduct loop to apply it).
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge"). Author the
  deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    claim: "<one sentence stating what this entry establishes>",
    type: "deferral", title: "<ticket>: <sub-track> design deferred — <why>",
    content: "<rationale: why this design decision is parked + when/what to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["engineering"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
    // B-1000: a defer is always human — carries the SAME provenance as the resolve_brief defer below.
    provenance: "human-in-session",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })
  ```
  **Fallback (B-352):** no rationale still parks — prompt once, then skip the authoring if declined. (Web
  `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise and re-call `compose_brief`, passing `iterate_feedback` = the human's words VERBATIM. B-843: the re-compose no longer edits the brief in place — it retains the previous revision and stores the feedback that caused this one, so a paraphrase (or an omission) loses the human's actual words permanently. B-903: pass it ONLY when a send-back CAUSED this revision — the recompose that CONSUMES a `pending_resolution` marker supplies that marker's `detail`, and every OTHER recompose OMITS it: a self-redraft, a rebase, an answer to an accept-with-remark, and the single recompose that follows a concluded `discuss` exchange (a brief that was talked over has no send-back words to attribute). `compose_brief` never reads `pending_resolution` for you, so re-stamping the last feedback you happen to know about marks a revision nobody sent back. The call is also a PARTIAL: fields you omit CARRY FORWARD from the previous revision, so never re-state `decision_ref` merely to keep it, and pass an explicit null only when you mean to clear it. Every recompose that is NOT a send-back passes `revision_cause` — see `skills/harmony-shared/brief-authoring.md` §Stating the cause of a redraft (B-1017). A lint-warning-driven recompose is capped at one per lineage per leg — see the same file's §Fixing a lint warning in the leg that raised it (B-1054).
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


## Removal declarations (B-1231)

When a design removes a mechanism, check or guarantee, author `doc.removes` as one
`{ claim: "what is removed", invalidates: ["affected knowledge-entry UUID", ...] }` per removal.
Read the affected entries first. Every removal names at least one existing entry in the same project;
self-links, missing targets and empty lists are rejected at acceptance in both browser and agent routes.
No removals: omit the field or use `[]`; existing briefs retain their behavior.

The brief displays these declarations before acceptance. Acceptance records durable invalidator links
and flags the old entries as “removal agreed, not yet effective”. Only the invalidator's explicit
`rollout_state: live` on the environment of record retires them automatically. `Verified`, decision
acceptance and `realization` never stand in for production cutover. Missing rollout support stays
pending and is reported. Before the enforcement migration is available, removal writes fail visibly.

For a policy-only removal with nothing to deploy, a HUMAN may explicitly choose
`removal_policy_only: true` plus `removal_effective_on_accept: true` on the brief. This writes the same
live rollout state at acceptance; the default is false. An agent-synthesized acceptance cannot make
that choice. Clause amendments remain the separate B-1138 contract; preserve affected entry prose.


### Knowledge metadata (B-1141)

Follow `skills/harmony-shared/knowledge-discipline.md` §Scope, vocabulary and surface identity for
knowledge writes: new entries declare product/deployment scope, authored tags use the explicit project
vocabulary, type is advisory, and composed entries carry `doc.knowledge_scope`. Keep legacy operations
usable before schema promotion; never drop an explicitly requested scope or filter on error.
