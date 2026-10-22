**Knowledge claims:** Author `claim` as one quotable sentence (at most 50 words) on every `record_decision` / `create_knowledge_entry` write, and on `update_knowledge_entry` when confirming or replacing a claim. A successor uses `claim` in `supersede_decision` or `new_claim` in `supersede_knowledge_entry`; retire-only calls have no successor claim. On every entry-producing `compose_brief`, author the exact approved sentence as `doc.claim`, separately from the recommendation. Use a sentence-shaped title; compatibility-derived proposals are unconfirmed, not authored statements.

# Knowledge-query discipline (agent-model §7)

Every Harmony discovery/build skill rests on this. Follow it before proposing any action.

## The rule

**Before proposing any action in a domain, query workspace knowledge filtered by `domain`. If no
relevant entry exists, surface the gap explicitly — do not silently guess.**

Use `mcp__harmony__query_knowledge({ domain: [...] , search: "..." })`. Pick the domain subset from
what you're deciding about:

| Deciding about… | Query `domain` | Why |
|---|---|---|
| CI / deploy / branches / infra | `operations` | The B-60 deploy-flow failure: acting on a wrong belief. |
| Data / analytics / what-lives-where | `data` | Wrong data knowledge fails *silently* — wrong numbers get acted on. |
| Code architecture / patterns | `engineering` | Keeps code consistent with the codebase. |
| User behaviour / business rules / feature semantics | `product` | Don't infer product behaviour from code. |
| Customer-specific facts | `customer` | Can't be derived from artifacts. |
| How-we-work conventions | `process` | Review style, comms norms. |

The six domains: `engineering`, `operations`, `data`, `product`, `customer`, `process`.

## Retrieval practice — fetch full bodies, sweep before concluding absence (B-741)

The 2026-07-22 KB evaluation's single highest-yield finding: the biggest gap between what the
knowledge base *has* and what an agent *retrieves* was never missing content — it was retrieval
practice. `query_knowledge`'s `search` path returns titles ranked by relevance; a title surfacing is
not the same as its content grounding your answer. Two habits close most of that gap for zero content
cost:

1. **Fetch the full body of every decision hit before synthesizing from it.** A result with
   `kind: "definition"` already carries its full quotable `content`, source, history and refinements.
   Cite its stable `concept_id`; do not send its definition id to the decision-only
   `get_knowledge_entry` tool. Ordinary `query_knowledge` decision results are
   summaries (title, type, status, tags) — never rely on a title alone to decide what an entry says or
   whether it applies. Call `get_knowledge_entry` on each candidate you intend to cite or rule out. A
   title that *sounds* relevant can turn out to be about something adjacent; a title that sounds
   generic can carry the exact fact you need. This one habit converts several "partial" answers to
   "correct" with zero new content — B-741's own re-baseline reproduced it directly: a search for
   "brief contract" surfaced the B-660/B-865/B-874 family but never the term "B-876" or "frame", so the
   entire `doc.frame` requirement (added to five skill files, never folded into the declared
   single-source-of-truth doc) went uncited — not because it was absent, but because the search terms
   used didn't happen to match it. **When a decision has evolved across multiple tickets, search using
   the CONCEPT you need, not just the ticket/section name you already know** — and if your first
   answer feels complete, try one more search using different vocabulary before concluding it is.

2. **Sweep the structured path — `status: "Asserted"`, `include_superseded: true` — before concluding
   a fact is absent from the KB.** `query_knowledge`'s default (`status: "Accepted"`, semantic search)
   only ever shows what's been ratified and what the ranker judged relevant. A fact can be genuinely
   present but Asserted-not-yet-Accepted, or superseded-with-context-you-need (the superseding entry
   references the superseded one's content). Before declaring "content-absent," run the structured
   path: `query_knowledge({ status: "Asserted" })` and `query_knowledge({ include_superseded: true })`,
   scoped by `domain`/`type`/`tags` rather than `search`, and check `query_entities`/`query_facts` too
   — a fact modeled as a typed fact rather than a decision entry won't surface from a decision-only
   search. Absence is a claim about the WHOLE store, not just the top-ranked semantic hits.

Both habits are cheap relative to a wrong or incomplete answer, and both are things a closed-book
agent can always do — neither requires new content in the KB.

## Contradiction discipline — read the FLOOR set before compose (B-838)

A decision the system has since moved away from can sit at `Accepted` indefinitely — nothing fires
supersession on its own when later work quietly contradicts what it records. The five FORWARD gates
(clarify, decompose, design, plan, release) carry the mechanical floor against this: **before
composing that gate's brief, read the ticket's FLOOR set — its `ticket_references_knowledge`-linked
Accepted entries, via `list_ticket_knowledge`, filtered to `status: 'Accepted'`** — and for any entry
this gate's work touches or contradicts, **explicitly supersede or amend it before the brief is
accepted**:

- A **dated amendment banner** (`update_knowledge_entry`) is the DEFAULT verb for a partial
  contradiction — the entry mostly still holds, one recorded fact does not.
- `supersede_decision` is reserved for a **wholesale replacement** — the entry's whole claim no longer
  holds.

Record what you reviewed on `doc.frame.floor_reviewed` — the ids of the FLOOR-set entries you
confirmed (an empty FLOOR set needs nothing here). `compose_brief`'s lint warns — never refuses —
when the ticket has a non-empty FLOOR set and `floor_reviewed` is absent or empty; treat the warning
as a prompt to go back and do the read, not as noise to suppress.

**At the release gate specifically**, `compose_brief` ALSO computes `frame.contradiction_signal` from
the build's diff (`diff_content`) — a second, TIER-widened check (bounded, content-matched against the
diff, not restricted to FLOOR) that a fires-and-contradicted entry surfaces on the release brief even
if it was never linked to this ticket. That diff-derived signal is compose-authoritative and
complements, not replaces, the FLOOR read every forward gate owes above.

## Surface gaps — and calibrate by impact × ignorance

When you find no entry you *should* be answering from knowledge, flag it. A **thin or tangential** result —
a hit that doesn't actually answer what you're deciding — counts the same as an empty one: it is itself a
knowledge-gap finding worth surfacing, not grounding. Then calibrate:

- **Mild gap** → recommend with explicit low confidence:
  `**Recommend (low confidence — no \`operations\` knowledge for X yet):** …` and put it in the brief
  `recommend` field with `confidence: 'low'`.
- **Load-bearing gap** (high-impact / Type-1 decision you're genuinely out of depth on) →
  **research-first**: set `load_bearing_gap: true` on the brief doc, put the concrete research prompts
  in `research[]`, mark the decision items `deferred: true`, and **lead with the research ask** — never
  bury it behind `expand`. Then invoke `/harmony-research` to run the relay. (The gate-ui-conduct loop §3.2
  lint enforces this: a load-bearing brief with no research, or still asking a substantive decision, fails to compose.)

"I don't know" is never the end state: fill the gap (write knowledge), accept the guess as precedent,
or trigger research.

## Calibrate confidence honestly — the level carries information (B-445)

A recommendation's `confidence` is a SIGNAL, not boilerplate. Set an explicit level on every (non-ceded)
recommendation, chosen from the strength of your grounding — never reflexively `low`, never left unmarked:

- **`high`** — strong Accepted + fresh knowledge backs it and the answer is obvious; a human would very
  likely agree without changes.
- **`medium`** — reasonable grounding but a real judgement call, or one load-bearing assumption you're
  comfortable with; worth a glance.
- **`low`** — thin / conflicting knowledge, a genuine hedge, or a values-heavy call. (For a pure
  values-call, prefer `cede: true`, which already renders its own low-confidence values line.)

If everything you produce is `low`, the signal carries no information and trains the human to ignore it —
the exact failure B-445 fixed. The brief lint emits a soft warning when a recommendation has no level, to
nudge an honest choice. (The dial's auto-advance thresholds that consume this level are a separate,
deferred decision — ad59f7d5; do not invent numbers.)

## Deferral is knowledge (§5a — "parked with an alarm clock")

When the human **defers** a brief (the `defer` command), a "not now" is itself a decision worth keeping —
knowledge-model-v1 §5a is locked: a deferral **writes a `knowledge_decisions` deferral entry** (the
rationale + a `review_by`/watch date), so it outlives the ticket and resurfaces. So in **every** skill's
`defer` path, BEFORE calling `resolve_brief({ command: 'defer', … })`, author the deferral:

```
const deferral = mcp__harmony__record_decision({
  claim: "<one sentence stating what this entry establishes>",
  type: "deferral",
  title: "<ticket>: deferred — <one-line why>",
  content: "<the rationale: what we're NOT doing now, and the condition/date to revisit>",
  review_by: "<watch/revisit date, ISO>",     // the alarm clock; added to record_decision by Task A4
  domain: [ /* the domain(s) the deferral touches */ ],
  source_type: "manual",
  source_activity: "defer",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })   // parks the ticket
```

(A defer is the human's own "not now", so it is always `human-in-session` from the plugin — the conduct loop
synthesizes only accepts, never defers. `provenance` itself is covered in
`skills/harmony-shared/gate-routing.md` §Resolution provenance — B-734.)

**Graceful fallback (B-352).** A defer with **no rationale still parks** — never hard-block the human's
"not now." If the human gives no rationale, **prompt once** ("what should we revisit, and when?") but if
they decline, skip the `record_decision`/`reference_knowledge` and just `resolve_brief({ command:
'defer', provenance: 'human-in-session' })`. The authoring is best-effort; the park is guaranteed.

**Documented asymmetry (reconciliation contract §4.3 / F4).** The **web** `defer` (P5) is
**mechanical-only** — it parks via `resolve_brief` but does **NOT** author the deferral entry (authoring
needs LLM judgment, which the web doesn't run). So a deferral made from the web queue is lossy in exactly
the §5a sense; only a skill-side `defer` writes the deferral knowledge. This is the known v1 consequence of
"web = mechanical, skill = LLM."


## Record behaviour settled during build (B-1143)

Before filing the release brief, compare each resolved acceptance criterion with the ticket's
Accepted design. If implementation settled behaviour the design does not state, record a concrete
claim on a ticket-linked design entry, or amend the affected surface's current-state entry. Read the
full existing entry first and preserve it; use amend mode when available, otherwise submit the full
preserved content plus a dated build-settled section through `update_knowledge_entry`. Include the
criterion, observed behaviour and evidence, with `provenance: 'agent-synthesized'`. This records what
the build observed; it does not turn an agent's additional design choice into a human decision.
A change to the Accepted design itself still follows revise-scope, rather than being smuggled in as
a build claim. Do not create a new decision entry merely to repeat the design.

After the write succeeds, read the entry back and retain its id for the release report. Do not claim
an intended or failed write as recorded knowledge. If recording fails, preserve the build and file a
worker-question for that blocked write before composing release. The release frame carries
`settled_beyond_design: [{ behaviour, ac, knowledge_entry_id }]`; `ac` identifies the criterion and
`knowledge_entry_id` identifies the entry actually updated. Explicit `[]` means the comparison found
no behaviour beyond design. It is a legitimate answer, including for refactors.

The compose warning matches changed repo-relative paths to Accepted entries' exact `surface:<path>`
tags, the existing current-state convention. It is a conservative clue, not an exhaustive inventory:
untagged entries and aliases are outside this check. An empty report on a matching surface produces
an advisory warning and composition still succeeds. A failed lookup produces a diagnostic, never a
false assurance that no matching entry exists.


## Explicit bookkeeping metadata (B-1224)

Gate records that only attest procedure carry the exact reserved tag `harmony:bookkeeping`, set by
the writer. Recorded-walk plans and no-new-decision design records are examples. Pass it alongside
existing tags to `record_decision`; when a brief derives the accepted entry, also put it in `doc.tags`
so acceptance preserves the classification. Code writers use `bookkeepingTags(existingTags)`.
Never infer this class from titles, ticket ids, or the presence of a gate. Substantive decisions and
B-849's reusable shared no-split convention remain substantive; do not revive per-ticket no-split
emissions or reclassify the historical corpus.

`query_knowledge` returns substantive matches first and preserves relevance within each class.
`include_bookkeeping:false` excludes marked records before the page limit; the CLI equivalent is
`harmony knowledge list --no-bookkeeping`. Missing/null tags are substantive. The reserved marker
uses existing tag storage and works without a schema promotion. The query adapter must filter server
partitions before pagination, including on older RPC deployments; sorting a limited page is insufficient.


## Scope, vocabulary and surface identity (B-1141)

Every new authored entry declares `scope: product | deployment`: product describes behaviour for users;
deployment describes a particular installation's hosts, jobs, scripts, logins or operational values.
Separate mixed claims. Null scope on history means unresolved, never product. Type is an advisory
authoring classification, not verified semantic content. Retrieval may request `scope: product`;
unsupported scope filtering fails explicitly rather than returning unfiltered results.

Use `list_knowledge_tags` for the project's checked vocabulary. Unknown authored tags are refused
atomically with up to five known suggestions. Explicitly call `register_knowledge_tag` with a description
before using a new authored name; entry writes never extend vocabulary. Existing knowledge writers
hold that action. Ticket-shaped names, `surface:` and `harmony:bookkeeping` are generated namespaces,
exempt from authored checks for legacy-writer compatibility; never manually register them.

For composed gate entries, set `doc.knowledge_scope` to the entry's applicability, alongside the scope
on the initial `record_decision`. Compose carries it in the snapshotted `knowledge_entry_content`
payload; accepted metadata lands through its ledgered transaction, not a second unledgered write.
Before schema promotion ordinary legacy operations remain usable; explicit unsupported metadata
requests fail visibly. A missing function probe is the only reason to take a legacy operation route.

Surface identity is `surface:<repo>/<immediate changed source directory>`, for example
`surface:web/src/features/queue`. Use the canonical `surfaceTags` mapping in
`src/tools/knowledge-metadata.ts` for release, historical repair and settlement overlap. No ancestor
tags, hand-typed paths, or prose-derived surface guesses. Supply repository-prefixed `changed_paths`
when composing release briefs so settlement warnings match these exact tags.

Historical repair: `harmony knowledge preview-metadata-repair <file>` produces a project-scoped
manifest with fingerprints, scope evidence, mixed/uncertain/missing-PR cases and counts. Review each
proposal, adjust scope and set `reviewed: true` only for approved rows; then run
`harmony knowledge apply-metadata-repair <file>`. Apply independently re-fetches merged PR paths,
refuses stale entry fingerprints, preserves tags and is repeatable. No schema migration classifies
production knowledge.

During schema skew, probe `list_knowledge_tags` before selecting the new authoring contract. A
confirmed unavailable capability means use the still-supported legacy operation WITHOUT `scope`
and omit `doc.knowledge_scope`; state that the saved applicability remains unresolved until reviewed
repair. This selects a legacy contract up front. It is never a retry that drops an explicit metadata
request after refusal, and it never reports that scope was saved. Once capable, new entries always
require scope and authored vocabulary validation.
## Maintaining current term definitions

When a decision explicitly changes a product term's meaning, show the full proposed replacement wording in that gate's brief. Do not publish proposed or unaccepted wording. An unrelated accept never rewrites definitions.

After the owning gate's accept and pending acceptance-event consume finish, use the actual Accepted decision UUID as the publication source. Look up the current term with `query_knowledge({ definitions_only: true, search: "<term>" })`, retaining its `concept_id` and `current_revision`. Publish the approved full wording with `publish_definition`: existing concept UUID, expected current revision UUID, Accepted source decision UUID, source ticket/PR/commit metadata where known, and explicit refinement UUIDs. Declare the same knowledge-write provenance as the work being executed. Publication preserves the stable definition and concept references, appends immutable history and keeps existing refinement links.

For a new term, follow the existing entity-birth discipline after ratification; reuse an existing concept only when the meaning matches. Ambiguous homonyms require explicit disambiguation. Pass `expected_revision: null` only for a genuinely new definition. Never create a new concept or definition merely to avoid a stale-revision refusal.

A stale publication requires reading the winning wording and reviewing the conflict before another attempt. Missing definition storage leaves ordinary retrieval usable, but does not count as a completed publication. Surface the specific blocked wording and Accepted source through the owning gate's normal tracked-residue or worker-question path; never silently drop it or claim the current definition changed.
