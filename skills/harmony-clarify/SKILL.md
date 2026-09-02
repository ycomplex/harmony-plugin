---
name: harmony-clarify
description: Clarify a ticket's intent into a specification (Proposed → Clarified) — elicitation-first (B-462): infer from the ticket + Accepted knowledge, interrogate only the load-bearing residual through a question exchange BEFORE drafting, then draft. Triggers on "clarify B-123", "what does this ticket mean", "harmony clarify", or picking up a Proposed-state ticket. Queries domain knowledge first, opens an elicitation exchange when intent is opaque, drafts a clarification, and files it as a brief for accept/edit/defer.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Clarify

Implements the `clarifying` activity (state-machine §4): Proposed → Clarified, producing a clarification
knowledge entry. **Elicitation-first (B-462 — the reference trigger configuration of the B-550/B-645
engine):** the first move is an inference attempt against the ticket + Accepted knowledge; only where
intent stays opaque does the skill interrogate the human through a round-based exchange *before*
drafting — elicit → draft → (much lighter) approve, instead of draft-then-approve. The skill *is* the
agent (agent-model §1): it reads state, infers, elicits, drafts, files a brief, and records the result
back through MCP. It never edits code (discovery role).

> Before deciding, follow `skills/harmony-shared/knowledge-discipline.md`.

> **The exchange behaviour is INHERITED, not implemented.** This skill supplies only its trigger
> configuration — `trigger: 'pre-draft-clarify'` (or `'phase-split-probe'` when the phase-split
> question is the sole load-bearing residual — step 2b), `gate: 'clarifying'`, and the clarify-specific
> flow below. ALL turn, convergence, and emission behaviour (stakes-split, round lints, cold-start cap,
> force-quit, claims provenance + disposal, mint-time dedupe) comes from
> `skills/harmony-shared/elicitation-engine.md` and its tools (`start_elicitation`,
> `file_elicitation_round`, `get_elicitation`, `conclude_elicitation`,
> `submit_elicitation_answers`). A behaviour gap found here is
> an ENGINE amendment to surface to the human — never a local workaround in this skill.

> **Product legibility (B-434).** The `clarifying` activity IS the product-legibility transformation. Agent-filed findings may enter at Captured in a raw working-context register, but the clarification must render the ticket in the **product register**: title = product-visible outcome (not mechanism); plain-language first paragraph; mechanism + searchable keywords under a `## Technical` heading. See the *ticket two-audience register* doctrine and `create_task`'s description.

## Flow

### 1. Load the ticket + check it's ready (+ resume an open exchange)

First call `mcp__harmony__get_project`; if `mode !== 'opinionated'`, stop — the discovery gates are an
opinionated-mode activity (manual-mode projects use the normal board, not the clarify→decompose→design
lifecycle). Then `mcp__harmony__get_task({ task_id })`. Confirm `workflow_state === 'Proposed'` (or near it).

**Resume check — exchanges survive session death, like briefs.** `mcp__harmony__get_elicitation({
task_id })` and branch:

- **Active exchange with an unconsumed marker** (`answers_submitted_at` or `force_quit_requested_at`
  non-null) → the human answered (or force-quit) while no session was watching. Consume per the engine
  contract: answers → step 2c's consume (next round or converge); force-quit → `conclude_elicitation('force-quit')`
  and draft best-efforts (step 3).
- **Active exchange, no marker** → the round is still awaiting the human. Re-render the last round as
  prose and re-enter the wait (step 2c) — never re-ask what is already on the table.
- **Concluded exchange (converged/force-quit) with no clarification spec recorded yet** → the session
  died mid-emission. Proceed to the convergence handoff (step 3) using the exchange's recorded answers.

If a brief is already active (`mcp__harmony__get_brief` returns one with `reason:
'clarification-draft'`), you're iterating — load it and skip to step 4. (A brief iterate does NOT
reopen the exchange; post-brief discussion is B-461's trigger, not this skill's.)

### 1b. Honor a cross-ticket-completion flag (reconcile before drafting)

Before drafting, check whether this ticket's work is **already done** by another run (B-643) — because a run that completed this work may have flagged it forward, and `find_related_tickets` (step 1c) **excludes Verified/Deployed**, so a *done* sibling will not surface there:

1. **Honor a `possibly-subsumed-by` annotation** if the description carries one (grep for the `possibly-subsumed-by:` token): `get_task` the named covering ticket; if its work covers this ticket → `subsume_task({ task_id, subsumed_by_task_id: <covering>, reason })` and **stop** — don't clarify already-delivered work. Else clear/note the flag and proceed with the genuine remainder.
2. **Independently, check for a Verified/Deployed sibling** via `search_tasks` (it does **not** filter by `workflow_state`, so unlike `find_related_tickets` it reaches done work): search this ticket's title + intent, keep hits whose `workflow_state ∈ {Verified, Deployed}`, and if a high-similarity hit already delivered this work → subsume + stop.

See `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished"** for the full mechanism and rationale.

### 1c. Early dedup retrieval — BEFORE any interrogation (B-475, moved up by B-462)

Call the dedup pipeline NOW, before the human is asked anything — **never interrogate the human about
a duplicate**:

```
mcp__harmony__find_related_tickets({ task_id })   // top ~5; pass limit to widen
```

- A **dedupe-grade top candidate** (the same ask, open) → surface it immediately with the recommended
  disposition and stop for the human's call. (In a conducted run this is a pause — a strong dedup hit
  pauses even under `--unattended`, the B-619 precedent.)
- Otherwise **keep the result**: candidates feed step 2's residual assessment (a real overlap is
  legitimate elicitation material — "this overlaps <ticket> — how is your intent different?"), and the
  full card renders with the draft brief at step 3c. The disposition surface is unchanged.

### 2. KB-inference attempt — infer first, interrogate only the residual (rule 1)

Query the relevant domains. For most clarifications that's `product` (feature semantics, business
rules) plus `customer` where relevant:

```
mcp__harmony__query_knowledge({ domain: ["product", "customer"], search: "<the ticket's subject>" })
```

Also pull the ticket's own comment stream — a founder-authored comment placed on the ticket (an
explicit fold instruction, a correction, a "this belongs in this ticket's remit" note) is a
first-class scope input the census must not miss:

```
mcp__harmony__list_comments({ task_id })
```

**Filter out skill-authored bookkeeping markers, then treat every remaining comment as scope
input.** The marker filter is a single, named exclusion list — today it holds exactly one entry,
lines matching `AC-FILING-PASS brief_id=... filed=N` (this same skill's own idempotency marker,
filed at step 5). A future skill-authored bookkeeping-marker convention is added to this SAME list
at the point it's introduced — never a new ad-hoc filter. Every non-marker comment feeds the SAME
residual-assessment mining targets below as the ticket body and Accepted KB, with the same
inferable / inference-needing-validation / unknown classification and load-bearing/low-stakes
staking: a comment carrying scope-relevant content becomes load-bearing residual exactly like any
other unknown, and can trigger the exchange (step 2b) through the same trigger-config mechanism as
any other load-bearing unknown — this is not a new trigger type.

Also pull similar past tickets/decisions (`query_knowledge` by `type: 'specification'`). **Inference
grounds on Accepted knowledge only** (the tool's default). An Asserted entry never silently steers
inference — it may enter the dialogue only as an explicit validation candidate ("I hold an unratified
claim that X — confirm?"), which is precisely its ratification route.

Then form the **residual assessment** over the mining targets (rule 2 — beliefs and intent, not
slots): the ticket's **drivers** (motivations), the **behaviour** to be performed, any
**solution-shape** already in the human's head, and the **scope boundaries** (in/out) — mined from
the ticket body, Accepted KB, and the ticket's own non-marker comments alike. Classify each
as *inferable* (ticket + Accepted KB settle it) / *inference-needing-validation* / *unknown*, and by
stakes: *low* / *load-bearing*.

**Phase-split detection (B-518).** While assessing the scope boundaries, check whether the ticket
**bundles a now-phase and a later-phase of product intent** — two asks at different priority horizons
("do X — and eventually Y"). A detected now-vs-later mixture is a **load-bearing scope-boundary
unknown** (only the human knows which phase is in immediate scope): it enters the residual like any
other load-bearing unknown and is asked via the **phase-split probe** (step 2c). **Size or technical
compositeness is NEVER this signal** — a ticket that is merely big or multi-part passes whole to
decompose, which owns complexity-splitting (`skills/harmony-shared/gate-routing.md` §Split ownership).

### 2b. The trigger decision — open an exchange, or draft directly?

Open an exchange **iff the residual holds ≥1 load-bearing unknown OR a load-bearing inference that
needs the human's validation.** Otherwise — an all-low-stakes residual — **draft directly**: go to
step 3, folding the low-stakes validation candidates into the brief's decision items as today (the
"much lighter approve").

- **Phase-split probe trigger (B-518):** a detected now-vs-later bundle (step 2) is such a
  load-bearing unknown. When it is the **sole** load-bearing residual — everything else inferable,
  where draft-directly would otherwise fire — still open the exchange, with
  `trigger: 'phase-split-probe'` instead of `pre-draft-clarify`, and ask just the phase-split
  question. (The trigger value records *why* the exchange exists; the engine behaviour is identical.)
- **Cold start (rule 7):** a thin KB must not translate into maximal interrogation of the
  least-invested user. Lead with your own best-effort inferences as validate questions, gate depth by
  stakes, keep force-quit prominent from round one.
- **v1 claims constraint (founder-pinned at the B-462 design gate):** the draft-directly path emits
  the **specification only** — claims are minted only from an actual exchange (step 3). Inference-only
  claims would launder a brief accept into 'human-validated' provenance without the human ever having
  spoken in dialogue — the precise rubber-stamp surface elicitation-first removes.

### 2c. The exchange (the trigger configuration — everything else is inherited)

```
mcp__harmony__start_elicitation({ task_id, trigger: 'pre-draft-clarify', gate: 'clarifying' })
mcp__harmony__file_elicitation_round({ task_id, context_line: "<one plain-prose line>", questions: [...], prior_answers: {...}? })
```

Rounds follow the engine contract (≤5 questions, stakes-split — a load-bearing question MUST be
`kind:'open'`; the tool lints enforce this at point-of-use). Filing hands the ball to the human
(`awaiting_human_reason = 'elicitation-round'`). Then:

- **The phase-split probe question (B-518):** always `stakes:'load-bearing'` → `kind:'open'` (the
  lint enforces open). NAME the bundle, WITHHOLD your split candidate — *"The ticket asks for X and
  also Y — which of these is in immediate scope now?"*, never *"I think Y is later."* Its answer feeds
  exactly one disposition: **de-scope** (step 3's de-scope block); an "all of it now" answer changes
  nothing — no split at clarify, decompose decides structure later.
- **In a conducted session:** return control to the conductor — it arms the §4c watch and re-invokes
  this skill when the poll classifies **`answers-landed`** (a web submit) or the human answers in the
  terminal. Never leave a filed round without an armed watch in a conducted run.
- **In a direct terminal session:** render the round as prose — the SAME anatomy as the web surface
  (fbcdb1e0 terminal parity): the context line, the questions in order (a validate question shows its
  statement to confirm/correct; a load-bearing question is asked openly), a question's `why` field (its
  "why I'm asking" expander) rendered inline after the question when present (B-785 — parity with the
  web surface, which now shows it too; never omit it just because the terminal has no collapse/expand
  affordance), and the force-quit phrase ("Enough — draft with what you have") — then take the answers
  in-conversation.
- **Echo terminal-given answers into the record (B-462):** answers that arrive in the terminal are
  echoed via the NEXT engine write's `prior_answers` — on `file_elicitation_round` when filing the
  following round, or on `conclude_elicitation` at convergence. The exchange history stays complete
  regardless of which surface the human answered on; the engine stamps each echo `via:'terminal'`.
- **Not filing or concluding this turn? Record the answers on their own (B-893):**
  `submit_elicitation_answers({ task_id, answers })` banks the open round's terminal answers (same
  shape, same guards, stamped `via:'terminal'`), leaves the exchange ACTIVE, and hands the ball back
  to the agent. Use it whenever the answers are in hand but the next move isn't decided — never
  `conclude_elicitation` just to get them on the record.
- **Consume (either surface):** `get_elicitation` → read the last round's answers → *converged?*
  (per the engine's convergence test) → `conclude_elicitation('converged')` and go to step 3. *More
  load-bearing residual?* → file the next round (filing IS the consume of the web marker; carry
  `prior_answers` for terminal answers). Partial submits are legitimate — re-ask a skipped
  load-bearing question re-framed, or let it go. *Force-quit* (the marker, or said in-terminal) →
  `conclude_elicitation('force-quit')` → step 3, drafting from what you have.

### 3. Draft the clarification — the convergence handoff (emission order: spec → proposed ACs → de-scope block → brief → claims)

Resolve the open questions from what the exchange established (or from inference alone on the
draft-directly path). The emission is **one discrete, ordered step** — the order is what lets claims
couple to the brief they underwrite:

1. **Spec.** Write the clarified intent as an **Asserted** specification entry (unchanged):

```
const decision = mcp__harmony__record_decision({
  type: "specification",
  title: "<ticket>: clarified intent",
  content: "<placeholder — one line: 'clarified intent for <ticket>; body derived from the ratified brief'>",
  domain: ["product"],
  source_type: "manual",
  source_activity: "clarify",
  source_task_id: "<task uuid>",
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

2. **Proposed ACs (B-648).** Derive the ticket's **happy-path acceptance criteria** from the
   clarification — on the exchange path, from the elicitation dialogue (stating them and having the
   human confirm without correction is the convergence correlate); on the draft-directly path, from
   the ticket + Accepted-KB inference. **Both paths emit ACs** — the v1 exchange-only constraint
   governs CLAIMS (step 4), not ACs. Keep the set small (**1–5 — happy path only**; edge cases, error
   paths, and non-functional criteria are design's to add). **Intent-register guard (drafting lint,
   applied per AC):** clarify-authored ACs are written in **user-observable-behaviour register, never
   mechanism** — "the board exports a PDF that matches the on-screen layout", not "PDF renderer added
   to export pipeline". A mechanism-flavoured draft is rewritten into the observable outcome or pushed
   to design's refine step — mechanism-flavoured ACs at clarify are the solution-shape-smuggling
   failure mode. **The proposed set rides the brief through `doc.payload` — you author it ONCE, as
   the `acceptance_criterion` items B-810 already requires (the brief call in step 4), and the RENDER
   emits the block mechanically (B-874).** Do NOT hand-write the block into `doc.context`: the
   renderer derives one line per criterion from that payload and emits it under the heading
   **"Proposed acceptance criteria (happy path) — filed on accept:"** whenever the gate reason is
   `clarification-draft`. One authored source means the criteria the human READS and the criteria the
   accept FILES can never disagree. That heading string is **byte-stable forever** — older resolved
   briefs keep the bytes they were rendered with, so it must never change. The ACs are NOT written to
   the ticket at emission time — they land at the brief's ACCEPT (see step 5); filing-at-compose would
   persist unratified proposals on defer/iterate.

3. **De-scope block (B-518) — only when the human's answer put work out of immediate scope.** When
   the exchange's phase-split answer (or the human's explicit direction) marked a later phase, the
   clarified spec covers the **immediate scope only**, and the brief carries a clearly-delimited
   context block headed exactly **"De-scope — re-ticketed on accept:"** — one line per later-phase
   item (working title + one-line intent). Like the proposed ACs, the re-ticket is NOT executed at
   emission time — it lands at the brief's ACCEPT (step 5); executing at compose would persist an
   unratified split on defer/iterate. **A de-scope only ever originates from the human's explicit
   "later" answer (or an explicit human choice on the brief) — never from agent inference alone.**
   Never author this block for a split motivated by size or technical compositeness — that is
   decompose's axis (`skills/harmony-shared/gate-routing.md` §Split ownership).

4. **Brief.** Compose the brief (step 4) with `decision_ref` = the spec. **When an exchange ran**, the
   doc's context carries a **"What I learned from you"** section — one line per load-bearing claim
   that steered the draft, badged by provenance: **You said** / **You confirmed** / **Best effort —
   unvalidated** (force-quit).

5. **Claims — ONLY when an exchange actually ran (v1).** Mint each load-bearing claim that steered the
   brief via `record_decision` with `claim_provenance` (`'human-stated'` |
   `'agent-inferred-human-validated'` | `'force-quit'`) and `underwriting_brief_id` = the
   just-composed brief's id. **Mint-time dedupe** per the engine contract: a duplicate of an existing
   entry becomes a validation candidate, not a twin. Disposal is then mechanical at brief resolution —
   accept promotes (except force-quit, which stays quarantined), defer archives, iterate prunes.

#### 3b. Load-bearing gap → research-first

If a load-bearing gap blocks the spec **and it is not the human's tacit knowledge** (an exchange can't
answer it — it needs external facts), compose the brief with `load_bearing_gap: true`, the concrete
research prompts in `research[]`, decision items marked `deferred: true`, then invoke
`/harmony-plugin:harmony-research <ticket>` to run the v1 relay. Re-query knowledge after research
returns, then resume step 3. (Opacity about the human's own intent is the exchange's job, step 2b;
research is for gaps no dialogue can fill.)

### 3c. Surface related / duplicate / overlapping tickets

Render the **"Related / duplicate / overlapping tickets"** card from step 1c's result (do NOT
re-fetch) as a **SINGLE relevance-ranked list** — the candidates arrive in relevance order (RRF fused
across the intent + lexical routes), and **that order is authoritative**. Do NOT group, section, or
reorder. One row per candidate, each row showing:

- **id** (visual id, e.g. `<ticket>`) + **title**
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

Author the brief per `skills/harmony-shared/brief-authoring.md` §Clarify — the question, must-haves,
and engagement it owes the human, plus the legibility contract. Consult it; do not restate it.
Ticket ids named in the brief's prose — and in the related-tickets card at step 3c — follow `skills/harmony-shared/brief-authoring.md` §Ticket identity, never an assumed `B-`.

Build the BLUF `BriefDoc` and file it — this sets `awaiting_human_input` and lints the doc. **Also
author `doc.payload` (B-810)** — one `acceptance_criterion` item per proposed happy-path AC from step 3's
same derived set (never re-derived independently), so a WEB accept with no session running can auto-file
them via the B-797 safety net instead of stalling on the design-gate self-heal. `ref: slugRef('ac',
content)` (import from `payload-refs.ts` — never reinvent the scheme), deduped via `dedupeRefs` before the
call.

**Also propose `label_add` when clarify judges the ticket decision-only-shaped (B-688 — the
clarify-proposed producer).** This rides in the SAME brief as a PROPOSAL, never an auto-apply — the
human's brief accept is what confirms it, exactly like any other clarify recommendation (never gate it
behind a new bespoke heuristic invented for this alone). **Detection signal — a conservative, documented
judgment call, not a mechanically-derived predicate; flag for a human reviewer to sanity-check:** propose
`label_add` when this ticket is **capture-only** — its entire deliverable IS this clarification, with
nothing left to plan/build/deploy afterward. The concrete tell this step already computes: **step 3's
derived happy-path AC set is EMPTY** (zero `acceptance_criterion` payload items). An empty set means no
buildable, verifiable behavior is implied by this ticket's scope — the same condition the "Decision-only
completion line" note below already keys its own prose on for an ALREADY-labeled ticket, just applied
here to recognize the shape for the FIRST time. A ticket with even one derived AC is NOT decision-only-
shaped (something concrete needs to be built and verified downstream) — never propose in that case. Skip
the proposal entirely when the ticket ALREADY carries the `decision-only` label (the completion-line note
below governs that case, unchanged). When the signal fires, add ONE more item to the SAME `dedupeRefs(...)`
call as the AC items (so refs stay unique within the one payload array):
```
{ write_kind: "label_add", ref: slugRef("label", "decision-only"), label_name: "decision-only" }
```
The DB-side guard (`can_mark_decision_only`, consumed by `consume_label_add_write` at accept time) is the
actual authority on whether the label may land — this proposal is never a guarantee, only a recommendation
riding the same accept the human already reviews (see step 5's accept branch for what happens on a
guard-blocked or not-yet-deployed apply).

**Also author `doc.frame` (B-876) — the clarify gate's own must-haves.** The clarification IS the
artefact being ratified, and the two things the human is actually being asked to lock have no other typed
home: without the frame they degrade into `context[]`, the block that everywhere else means "no action
needed", and stop being read.

- **`solving`** — the **OUTCOME**: what becomes true for the product when this ships, in product terms.
  Never a restatement of the problem. Briefs restate pain fluently and then never say what changes —
  "triage is slow because filters reset" is the problem; "a triager reopens the board and their filter is
  already applied" is the outcome. Pitched so a reader can judge it without the repo open.
- **`in_scope`** — what this ticket covers, as a list. The positive half of the boundary.
- **`not_solving`** — what it excludes, and **for each exclusion, where it lands**: a ticket id, a later
  phase, or the explicit `"nowhere — nobody is tracking this"`. That last value is sanctioned and is the
  highest-signal entry in the block, not an escape hatch — an exclusion with no destination is the
  deferred work that quietly evaporates (`skills/harmony-shared/disposition-discipline.md`). The KEY is
  **required even when nothing is excluded**: `[]` ("this excludes nothing") is a legal, meaningful
  answer; absence is not, because silence and "nothing" are different claims.

The de-scope block (step 3) and `not_solving` answer different questions and both stand: the de-scope
block is the *executable* list the accept re-tickets, `not_solving` is the *boundary* the human is
ratifying — an exclusion can be out of scope without being re-ticketed here.

`frame.kind` must be `"clarify"`; the render places it **above DECIDE** — the boundary is the first thing
read, not a footnote under the ask. Every frame rule is a **WARNING** — a frame defect can never refuse a
brief — and omitting the frame entirely renders exactly the pre-B-876 bytes.

**"Ticket comments considered" context block (B-821).** When step 2's `list_comments` call found any
non-marker comments, `doc.context` carries a block headed exactly **"Ticket comments considered:"** —
one line per comment, rendered the same way step 3c renders the related-tickets disposition list (one
row per candidate, each with an explicit disposition): `→ reflected: <how it fed the drafted spec>` or
`→ excluded: <one-line reason it was judged out of scope>`. Silence is never acceptable — every comment
gets a line, even a load-bearing one already surfaced via the exchange's "What I learned from you"
block above. When the ticket has zero comments, the `list_comments` call still ran unconditionally
(step 2) but this block is simply omitted — no "no comments" placeholder — the same convention as the
de-scope block (step 3), which appears only when it applies:

```
mcp__harmony__compose_brief({
  task_id,
  reason: "clarification-draft",
  pending_activity: "clarifying",
  decision_ref: { type: "specification", id: decision.id },
  doc: {
    decide: "Is a 'Saved Filter' per-user or shared at project scope?",
    recommend: { text: "Per-user, project-scoped — matches existing filter UX", confidence: "medium" },
    frame: {
      kind: "clarify",
      // The OUTCOME — what becomes true for the product when this ships. Never the problem restated.
      solving: "A triager reopens the board and the filter they saved is already applied.",
      in_scope: ["saving and restoring a filter per user", "renaming a saved filter"],
      // Every exclusion names where it lands: a ticket id, a later phase, or the explicit
      // "nowhere — nobody is tracking this". The KEY is required even when the list is empty.
      not_solving: [
        { item: "sharing a saved filter across a project", lands: "phase 2 — de-scoped below" },
        { item: "saved sort/grouping", lands: "nowhere — nobody is tracking this" }
      ]
    },
    why: ["Existing filters are per-user", "No product entry on filter sharing yet"],
    context: [
      "What I learned from you: (You said) saved filters exist to speed up triage, not reporting; (You confirmed) per-user scope",
      "Ticket comments considered:\n→ reflected: founder comment confirming per-user scope fed the recommendation directly\n→ excluded: an earlier comment about export formatting — unrelated to this ticket's saved-filter scope"
    ],
    items: [
      { kind: "decision", text: "Scope of a saved filter", recommendation: "Per-user, project-scoped" },
      { kind: "content-input", text: "Confirm whether sort/grouping is part of the saved state" }
    ],
    // one item per proposed happy-path AC (step 3's derived set) — dedupeRefs(acs.map(ac =>
    // ({ write_kind: "acceptance_criterion", ref: slugRef("ac", ac), content: ac })))
    payload: [
      { write_kind: "acceptance_criterion", ref: "ac-a-saved-filter-persists-per-user", content: "A saved filter persists per-user across sessions" }
    ]
  }
})
```

A **capture-only** ticket (step 3 derived zero happy-path ACs — e.g. "Decide the default export format")
proposes `label_add` INSTEAD of any `acceptance_criterion` items, in the same `dedupeRefs(...)` call:
```
payload: dedupeRefs([
  { write_kind: "label_add", ref: slugRef("label", "decision-only"), label_name: "decision-only" }
])
```

If `compose_brief` throws a lint error (naked fork, mislabelled derived constraint, or a load-bearing
gap without research), fix the `doc` and recompose — what's linted is exactly what's rendered.

**Decision-only completion line (B-681).** If the ticket carries the **`decision-only` label** (a
capture-only ticket — e.g. an inception proposition-root — whose deliverable IS this clarification), **or
this brief's own `doc.payload` proposes adding it** (the `label_add` item just above, B-688's
clarify-proposed producer), clarify is its **deliverable gate**: the brief MUST carry an explicit
completion line in its context — *"Accepting this completes the ticket to Verified via the decision-only
fast-forward; nothing is built, and the captured decision's realization stays `agreed`."* When the label
is only PROPOSED (not yet carried), phrase the line as conditional on the proposal landing — e.g. *"...if
this brief's decision-only proposal is accepted and the guard allows it; otherwise this clarification
completes normally and the ticket continues through the remaining gates."* — since the DB-side guard (not
this skill) has final say (see step 5's accept branch for the guard-blocked / not-yet-deployed cases). The
completion is never silent, and this brief is **hard-floor** — never auto-advanced under any delegation
flag (see `skills/harmony-shared/gate-routing.md` §The decision-only fast-forward).

**On an iterate of a brief with coupled claims**, compute the kept-set (which claims still underwrite
the revised doc) and pass it as `underwriting_claim_ids` to `compose_brief` — coupled Asserted claims
NOT in the list are archived in the same write. Never let a dropped claim ride into promotion on a
brief it no longer underwrites (the engine contract's iterate-prune).

### 5. Display + resolve

Show the rendered `content` verbatim. On the human's command:

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conductor-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → **first file the proposed ACs (B-648) UNLESS this brief's payload carries a `label_add`
  item (B-688 — see branch B below), then execute the de-scope block (B-518), then resolve.**

  **A. This brief's `doc.payload` has NO `label_add` item — the overwhelming majority of clarify briefs,
  unchanged behavior.** **Idempotency (B-744, corrected — reopened after a verify rejection) — the
  filing-pass RECORD is the marker, never a ticket-wide "has any AC" check.** A ticket-wide check is the
  exact B-698 defect: some unrelated AC predating this clarification would silently read as "clarify
  already ran" and drop the happy-path set this accept owes the ticket. The record is scoped to
  **this clarification brief's own id** — `brief.id` (the `briefs` row id: what `compose_brief`
  returns on a same-turn compose→accept, what `get_brief` returns on a resumed one, and the same id
  `resolve_brief` later records as `brief_resolved`'s `metadata.brief_id`) — **never the brief's
  `decision_ref.id`** (a different id space entirely: the Accepted `specification` DECISION
  this clarification produced, not the brief that produced it). Using the decision id is exactly the
  live-production defect this rework fixes (caught at verify against B-756 and B-691): the marker is
  written under a `brief_id=` label but holds a decision id, so a later lookup keyed on the real
  brief id never matches and the guard silently re-files the whole set. `brief.id` needs no
  round-trip through `get_brief` to stay a usable key — once captured as plain text in the comment
  at file-time, the value is permanent regardless of whether the brief later stops being queryable as
  "active"; the earlier "the `briefs` row goes stale" reasoning does not actually favor the decision
  id, since a plain-text UUID copied into a comment doesn't need the row to stay queryable at all.
  This is the same id that lets the design-gate self-heal (`harmony-design-decide/SKILL.md` §2b)
  recognize the SAME record under the SAME key even though it resolves a different brief (its own
  product-design brief) entirely — see that section for how it recovers this clarification brief's
  id without ever holding the brief object itself. Check first:
  ```
  mcp__harmony__list_comments({ task_id })
  ```
  Match a line `AC-FILING-PASS brief_id=<brief.id> filed=<N>` — an exact `brief_id`
  match, never fuzzy text matching against rendered brief prose.
  - **Found → skip the filing** (the legitimate same-accept-reapplied case — a web accept raced by
    a running session's self-heal, or a re-conducted accept). No new write.
  - **Not found → file the brief's full proposed happy-path set unconditionally** — regardless of
    what other unrelated ACs already exist on the ticket — from the brief's structured proposed-ACs
    data (step 3's derived set, not re-parsed from rendered markdown), onto the ticket unchecked:
    ```
    mcp__harmony__manage_acceptance_criteria({ task_id, add: [{ content: "..." }, ...] })
    ```
    then write the filing-pass record — **a zero-count pass still writes it** (a silent zero is
    exactly the original bug's failure mode, so zero must be exactly as loud as N):
    ```
    mcp__harmony__add_comment({ task_id, content: `AC-FILING-PASS brief_id=${brief.id} filed=${N}` })
    ```
  This one comment IS the idempotency marker — no second mechanism, and never `brief_resolved` (it
  fires the instant the human accepts, before filing runs, so a web-accepted-no-session clarification
  reads as "already filed" while filing is still outstanding — the same bug under a new name).

  **B. This brief's `doc.payload` DOES carry a `label_add` item (B-688 — clarify proposed decision-only
  at step 4).** The ONLY thing that can safely apply a `label_add` write is `consume_label_add_write`
  (guard-checked, ledgered, idempotent) — reached exclusively through the generic
  `consume_pending_acceptance_event` apply path (`acceptance-events.ts`). So branch A's shortcut is
  **mutually exclusive** with this branch: **do NOT ALSO run `manage_acceptance_criteria` here** — that
  would double-file the ACs (once directly, once via `consume_ac_add_write`'s own ledgered insert). Skip
  straight to `resolve_brief` below; the ledgered apply call that follows it files the ACs itself.

  Then, if the brief carries a
  **"De-scope — re-ticketed on accept:"** block (branches A and B both reach this step), re-ticket each
  listed later phase:
  ```
  mcp__harmony__create_task({ title: "<product-visible outcome>", description: "<intent>\n\nDe-scoped from <ticket> at clarify (phase-split probe, B-518)." })
  ```
  — product register per `create_task`'s description; the new ticket lands **Captured** (the normal
  inbox). **Idempotent — skip any item whose ticket already exists** (`search_tasks` by the working
  title). The human's brief accept authorizes exactly the de-scopes listed on the brief — never
  re-ticket anything not in the block. Then
  `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })` → promotes
  the specification
  Asserted→Accepted, and (when an exchange ran) promotes the coupled
  human-grounded claims — force-quit claims stay Asserted, quarantined (the DB disposal skips them). The
  response carries `pending_acceptance_event_id` — capture it as `event_id` for what follows in both
  branches.

  **A (continued) — finalize the deferred advance NOW, same session (B-797).** Since you just filed the
  ACs (and any de-scope) yourself above, there is nothing left to APPLY — only the deferred
  Proposed→Clarified advance to COMMIT. Call
  `mcp__harmony__consume_acceptance_event({ event_id })` right away, in this same turn.
  **Decision-only fast-forward (B-681):** if the ticket ALREADY carried the `decision-only` label before
  this accept (the brief carried the completion line for that reason — branch A never proposes the label
  itself), run the trailing mechanical completion the accept just authorized:
  ```
  mcp__harmony__advance_workflow({ task_id, activity: "fast-forwarding" })   // Clarified -> Verified
  ```
  — one human accept, two writes; report the ticket as **Verified (decision-only fast-forward,
  realization stays 'agreed')**. Idempotent guard: skip if the ticket is already Verified.

  **B (continued) — apply the FULL payload (ACs + the label proposal) through the ledgered path, then
  branch on the result:**
  ```
  mcp__harmony__consume_pending_acceptance_event({ task_id })
  ```
  - **`{ status: "consumed", applied, by_write_kind, workflow_state }`** — every write landed (both the
    `acceptance_criterion` items via `consume_ac_add_write` and the `label_add` item via
    `consume_label_add_write`, each through its own idempotent ledger) and the deferred
    Proposed→Clarified advance committed. Write the filing-pass marker using the EXACT newly-applied AC
    count this call itself reports — `by_write_kind.acceptance_criterion ?? 0` — never re-derive it:
    ```
    mcp__harmony__add_comment({ task_id, content: `AC-FILING-PASS brief_id=${brief.id} filed=${by_write_kind.acceptance_criterion ?? 0}` })
    ```
    The ticket now carries the `decision-only` label (this call just applied it) — run the SAME
    decision-only fast-forward step as branch A: `mcp__harmony__advance_workflow({ task_id, activity:
    "fast-forwarding" })`, report **Verified (decision-only fast-forward, realization stays 'agreed')**.
  - **Throws an error whose message contains `"decision-only guard blocked"`** — the DB-side guard
    (`can_mark_decision_only`) blocked the label (message names the reason: `terminal` or `build-shape`).
    **The `acceptance_criterion` items are NOT lost** — the apply path orders `acceptance_criterion`
    writes strictly BEFORE `label_add` (`acceptance-events.ts`'s `order` array), and each write_kind's RPC
    commits independently, so by the time `label_add` raises, every AC this brief proposed has already
    landed via its own ledgered insert. Catch this specific error (never let it surface as a bare tool
    failure to the human):
    1. Write the filing-pass marker. The thrown call carries no structured `by_write_kind` breakdown, so
       use the count of `acceptance_criterion` items THIS brief's payload proposed as `N` (a documented
       approximation — safe because the ordering guarantee above means all of them are landed by this
       point; the design-gate self-heal keys only on the marker's PRESENCE, never its exact `N`, so this
       approximation is not load-bearing):
       ```
       mcp__harmony__add_comment({ task_id, content: `AC-FILING-PASS brief_id=${brief.id} filed=${payload.filter(i => i.write_kind === "acceptance_criterion").length}` })
       ```
    2. Commit the deferred advance directly (the AC materialization this brief owed is done; only the
       separate label proposal was blocked): `mcp__harmony__consume_acceptance_event({ event_id })`.
       Report **Clarified** (never Verified — the label never landed, so no fast-forward).
    3. File a `worker-question` round (`skills/harmony-shared/elicitation-engine.md` §The worker-question
       trigger) naming what happened — the ticket was judged decision-only-shaped and proposed, but the
       guard blocked it (name the `block_reason`) — and asking the human how to proceed (e.g. drop the
       proposal, or something else):
       ```
       mcp__harmony__start_elicitation({ task_id, trigger: "worker-question", gate: "clarifying" })
       mcp__harmony__file_elicitation_round({ task_id, context_line: "...", questions: [...] })
       ```
  - **`{ status: "payload-unrecognized", event_id, reason, items }`** — this brief's payload is fully
    structured (every item is a known `write_kind`), so this status can only mean the B-383 hazard: the
    `consume_label_add_write` RPC itself is not deployed to this DB yet (a pre-migration window). Handle
    it like the guard-blocked case above, NOT like the generic `payload-unrecognized` self-heal route
    (`skills/harmony-shared/gate-routing.md` / `harmony-conduct` §1c) — that route re-files ACs via
    `manage_acceptance_criteria`, which would DOUBLE-FILE them here (the same ordering guarantee means
    they already landed via the ledger before `label_add` was ever reached):
    1. Write the filing-pass marker using the same `N` approximation as the guard-blocked branch.
    2. Commit the deferred advance directly: `mcp__harmony__consume_acceptance_event({ event_id })`.
       Report **Clarified**.
    3. File a `worker-question` round noting the decision-only proposal could not be applied yet because
       its DB function is not deployed to this environment, and that a human who still wants the ticket
       marked decision-only can add the label manually via the ticket's label editor (guard-checked, same
       authority) once it's deployed.
  - **Any other thrown error** — propagates untouched, exactly like every other tool error in this skill;
    never swallowed.

  Report the new state, including any re-ticketed later phase's visual id. A WEB accept with no
  session running defers the AC filing to the design gate's self-heal (branch A shape) and the de-scope
  execution to the DECOMPOSE gate's self-heal — the next gate to read the clarification (the documented
  v1 asymmetry, same shape as decompose's children); a decision-only ticket's web accept likewise leaves
  the trailing fast-forward to the next running session (re-run the conductor to apply it) — and, for a
  branch-B payload, leaves the FULL ledgered apply (ACs + label) to `harmony-conduct` §1c's leg-start
  consume. That generic route already handles a `payload-unrecognized` result correctly (routes to the
  owning gate's self-heal, no double-file hazard since branch A's shortcut never ran for a web accept).
  **Known gap, out of this ticket's scope:** §1c's documented handling only branches on `status` — it does
  not currently catch a THROWN `"decision-only guard blocked"` error the way branch B above does, so a web
  accept of a decision-only-proposing brief that the guard would block, picked up later by an unattended
  conductor leg via §1c, would surface as an unhandled tool error there rather than the clean
  worker-question this skill's own same-session accept produces. Flagging for a human to route (fold into
  `harmony-conduct/SKILL.md` §1c, or a follow-up ticket) rather than silently leaving it undocumented.
  **When that design-gate self-heal
  (`harmony-design-decide/SKILL.md` §2b) can't locate this clarification's content through its normal
  lookup (no Accepted `specification` decision / `brief_resolved` event to key on), it does NOT ask the
  human to re-state the proposed ACs from scratch — it presents the `consume_pending_acceptance_event`
  result's echoed `items` (this brief's own `doc.payload`, B-810) for confirm instead (B-816); see that
  section's fallback for the exact branch.**
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
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })   // → Parked; coupled Asserted claims archive (DB-side)
  ```
  **Fallback (B-352):** a defer with no rationale still parks — prompt once for the rationale, but if the
  human declines, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
  "defer", provenance: "human-in-session" })`. (The web `defer`, P5, is mechanical-only and never authors
  this entry — the documented v1 asymmetry.)
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise the `doc` per the human's input and re-call `compose_brief`, passing `iterate_feedback` = the human's words VERBATIM. B-843: the re-compose no longer edits the brief in place — it retains the previous revision and stores the feedback that caused this one, so a paraphrase (or an omission) loses the human's actual words permanently. B-903: pass it ONLY when a send-back CAUSED this revision — the recompose that CONSUMES a `pending_resolution` marker supplies that marker's `detail`, and every OTHER recompose OMITS it: a self-redraft, a rebase, an answer to an accept-with-remark, and the single recompose that follows a concluded `discuss` exchange (a brief that was talked over has no send-back words to attribute). `compose_brief` never reads `pending_resolution` for you, so re-stamping the last feedback you happen to know about marks a revision nobody sent back. The call is also a PARTIAL: fields you omit CARRY FORWARD from the previous revision, so never re-state `decision_ref` merely to keep it, and pass an explicit null only when you mean to clear it.
  Pass `underwriting_claim_ids` when claims are coupled — see step 4.
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).
- **A staged `pending_resolution` you can only partially apply** → apply what you structurally can, then file a `worker-question` round scoped to the blocked residue per `skills/harmony-shared/elicitation-engine.md` §Resuming onto a staged pending_resolution you can only partially apply (file the round before recomposing — crash-safety ordering, never wholesale-discard an actionable resolution).

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
