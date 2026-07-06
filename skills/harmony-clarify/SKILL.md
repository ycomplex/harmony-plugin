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
> `skills/harmony-shared/elicitation-engine.md` and its four tools (`start_elicitation`,
> `file_elicitation_round`, `get_elicitation`, `conclude_elicitation`). A behaviour gap found here is
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
  legitimate elicitation material — "this overlaps B-123 — how is your intent different?"), and the
  full card renders with the draft brief at step 3c. The disposition surface is unchanged.

### 2. KB-inference attempt — infer first, interrogate only the residual (rule 1)

Query the relevant domains. For most clarifications that's `product` (feature semantics, business
rules) plus `customer` where relevant:

```
mcp__harmony__query_knowledge({ domain: ["product", "customer"], search: "<the ticket's subject>" })
```

Also pull similar past tickets/decisions (`query_knowledge` by `type: 'specification'`). **Inference
grounds on Accepted knowledge only** (the tool's default). An Asserted entry never silently steers
inference — it may enter the dialogue only as an explicit validation candidate ("I hold an unratified
claim that X — confirm?"), which is precisely its ratification route.

Then form the **residual assessment** over the mining targets (rule 2 — beliefs and intent, not
slots): the ticket's **drivers** (motivations), the **behaviour** to be performed, any
**solution-shape** already in the human's head, and the **scope boundaries** (in/out). Classify each
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
  statement to confirm/correct; a load-bearing question is asked openly), and the force-quit phrase
  ("Enough — draft with what you have") — then take the answers in-conversation.
- **Echo terminal-given answers into the record (B-462):** answers that arrive in the terminal are
  echoed via the NEXT engine write's `prior_answers` — on `file_elicitation_round` when filing the
  following round, or on `conclude_elicitation` at convergence. The exchange history stays complete
  regardless of which surface the human answered on; the engine stamps each echo `via:'terminal'`.
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
  content: "<the clarified spec — what this is, in/out of scope>",
  domain: ["product"],
  source_type: "manual",
  source_activity: "clarify",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

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
   failure mode. The proposed set rides the brief (the brief item below) as a clearly-delimited
   context block headed exactly **"Proposed acceptance criteria (happy path) — filed on accept:"**
   with one line per AC. The ACs are NOT written to the ticket at emission time — they land at the
   brief's ACCEPT (see step 5); filing-at-compose would persist unratified proposals on defer/iterate.

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

Author the brief per `skills/harmony-shared/brief-authoring.md` §Clarify — the question, must-haves,
and engagement it owes the human, plus the legibility contract. Consult it; do not restate it.

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
    context: [
      "What I learned from you: (You said) saved filters exist to speed up triage, not reporting; (You confirmed) per-user scope"
    ],
    items: [
      { kind: "decision", text: "Scope of a saved filter", recommendation: "Per-user, project-scoped" },
      { kind: "content-input", text: "Confirm whether sort/grouping is part of the saved state" }
    ]
  }
})
```

If `compose_brief` throws a lint error (naked fork, mislabelled derived constraint, or a load-bearing
gap without research), fix the `doc` and recompose — what's linted is exactly what's rendered.

**On an iterate of a brief with coupled claims**, compute the kept-set (which claims still underwrite
the revised doc) and pass it as `underwriting_claim_ids` to `compose_brief` — coupled Asserted claims
NOT in the list are archived in the same write. Never let a dropped claim ride into promotion on a
brief it no longer underwrites (the engine contract's iterate-prune).

### 5. Display + resolve

Show the rendered `content` verbatim. On the human's command:
- **accept** → **first file the proposed ACs (B-648), then execute the de-scope block (B-518), then
  resolve.** File the brief's proposed happy-path set onto the ticket, unchecked:
  ```
  mcp__harmony__manage_acceptance_criteria({ task_id, add: [{ content: "..." }, ...] })
  ```
  **Idempotent — skip the filing if the ticket already carries acceptance criteria** (a web accept
  consumed by a running session may have already filed them). Then, if the brief carries a
  **"De-scope — re-ticketed on accept:"** block, re-ticket each listed later phase:
  ```
  mcp__harmony__create_task({ title: "<product-visible outcome>", description: "<intent>\n\nDe-scoped from <ticket> at clarify (phase-split probe, B-518)." })
  ```
  — product register per `create_task`'s description; the new ticket lands **Captured** (the normal
  inbox). **Idempotent — skip any item whose ticket already exists** (`search_tasks` by the working
  title). The human's brief accept authorizes exactly the de-scopes listed on the brief — never
  re-ticket anything not in the block. Then
  `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → promotes the specification
  Asserted→Accepted, advances Proposed→Clarified, and (when an exchange ran) promotes the coupled
  human-grounded claims — force-quit claims stay Asserted, quarantined (the DB disposal skips them).
  Report the new state, including any re-ticketed later phase's visual id. A WEB accept with no
  session running defers the AC filing to the design gate's self-heal and the de-scope execution to
  the DECOMPOSE gate's self-heal — the next gate to read the clarification (the documented v1
  asymmetry, same shape as decompose's children).
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
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })   // → Parked; coupled Asserted claims archive (DB-side)
  ```
  **Fallback (B-352):** a defer with no rationale still parks — prompt once for the rationale, but if the
  human declines, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
  "defer" })`. (The web `defer`, P5, is mechanical-only and never authors this entry — the documented v1
  asymmetry.)
- **expand** / **related** → show the pre-generated sections from `get_brief`.
- **edit** / **iterate** → revise the `doc` per the human's input and re-call `compose_brief` (updates
  in place, bumps `iteration`; pass `underwriting_claim_ids` when claims are coupled — see step 4).
- **discuss <remark>** → open a discussion on this brief per `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (resolution suspends until it concludes).

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
