# Bounded knowledge search (B-1223)

`query_knowledge` and `harmony knowledge list --search` accept free text together with `type`,
`status`, `domain` (any) and `tags` (all). Status defaults to Accepted. Tags are trimmed,
lowercased, deduplicated, and empty tags removed. Search compares normalized existing tags;
the write trigger normalizes future writes without rewriting history. B-1141 vocabulary enforcement remains active and compares registered spellings after the same lowercase/trim normalization, so a registered mixed-case name survives normalized writes; genuinely unknown tags still fail. Filter-only queries keep
their existing array/table shape. Historical filters, include_superseded and offset remain list-only.

Free-text responses are an envelope:

- `matches`: compact hits with `source_kind`, genuine RRF `score`, optional claim/snippet and
  page-local supersession links. Search order is substantive first, descending score inside each
  class, then stable kind/id. Supersession metadata does not rewrite score order.
- `score_cutoff`: 0.0125. Applied before the final caller limit on the scored path only.
- `below_cutoff_count`: candidates below cutoff in the **deduplicated scored union considered**.
  This is never a count of unseen corpus rows. `count_coverage` is `considered-scored-union`,
  `partial-scored-union` or `unavailable`.
- `incomplete` / `truncated`: true for missing/failed/timed-out routes, missing source embeddings,
  optional-work failures or candidate overflow. `routes_tried` records outcomes; failed requests
  use bounded generic diagnostics rather than reflecting server text or credentials.
- `normalized_query` / `normalized_filters`: effective query and filters. Query case is retained;
  surrounding/repeated whitespace is normalized.
- `tag_suggestions`: up to eight actual tags from entries overlapping supplied `context_tags`
  in this project. No supplied context means no suggestions. CLI: repeat `--context-tag`.

The six-second target begins at handler entry and includes scope lookup, embedding, capability
requests, search, projection and optional work. Network work shares a 5.9-second absolute deadline,
reserving 100 ms for assembly. Lexical retrieval starts without waiting for embedding; embedding
has at most 1.2 seconds. Every operation is cancellation-aware and raced against remaining time,
so even a transport ignoring abort cannot block the result. Late completions cannot mutate it.
Observed authentication/authorization failures remain errors. A deadline can yield zero hits when
no route completed; it cannot fabricate a ranking for unfinished work.

## Genuine scores and the shared source boundary

`knowledge_search_candidate_source` is the `SearchCandidateSource` relation. It runs with caller
RLS (`security_invoker`) and supplies `source_kind`, UUID `id`, workspace/project, title/body,
type/status/domain/tags, update time, nullable embedding and explicit bookkeeping class.
Claims are optional and can be decoded from the portable content envelope; the relation does not
require the newer claim columns. Missing bookkeeping metadata is substantive.

B-1240 extends this relation with authorized document/skill rows **before scoring**. It must not
supply independently capped, pre-scored or post-fusion pages. `(source_kind,id)` is identity;
the same UUID in two kinds remains two candidates. Duplicate identities inside one kind are invalid.
Sources without any embeddings report semantic unavailability and still contribute lexical hits.
Document/skill ingestion is owned by B-1240 and is not implemented by B-1223.

`knowledge_search_scored` applies workspace/project/RLS and all requested filters before ranking.
Each signal ranks the full filtered cross-source pool with stable kind/id ties. It then selects
up to 200 substantive and 200 bookkeeping candidates, with an overflow sentinel per class.
Original global ranks are preserved, never renumbered after class selection. Two signals produce
at most 800 deduplicated scored candidates; adding sources does not multiply that budget. This
reserves class capacity, not exhaustive recall. Excluding bookkeeping removes that class.

The shared handler sums `1 / (60 + original_rank)` for each available contribution. A single-signal
rank 20 meets the initial cutoff, rank 21 does not. The cutoff is an interpretable rank threshold,
not a truth probability or a claim of calibrated production relevance. SQL tests cover ties,
source collisions, shared caps and rare filters; the local handler probe measures deadline behavior
and representative lexical relevance. Production latency still depends on corpus and service health.

## Deployment skew

The migration is additive; `knowledge_search_rrf`, task search and ticket-intent RPC call shapes
are unchanged. Intent response projection remains bounded by B-837.

Missing scored RPC (`PGRST202` or `42883`) returns `matches: []`, bounded `unscored_matches` in
exactly the legacy API's order, `capability: scores-unavailable`, `incomplete: true` and an explicit
not-deployed reason. No ranks, scores or cutoff counts are invented. `below_cutoff_count` is null,
coverage unavailable, and the displayed configured cutoff is informational, not applied to legacy hits.
Legacy requests disable the inner limit, apply supported server filters, then the transport limit.
The legacy route is Accepted-only and cannot promise normalized historical tag matching; an explicit
other status or any normalized-tag request is reported unsupported rather than silently substituted.
Readers stay usable before promotion; they do not wait for a schema rollout.

Contradiction-search consumers inspect both result channels and disclose incomplete TIER coverage.
CLI human search output renders the same envelope as JSON; filter-only human output remains a table.

## Local validation

From the web worktree: `bash scripts/test-b1223-scored-search-db.sh` (also discovered by DB CI).
From the plugin worktree, with the web local stack running:

```sh
npx esbuild src/tools/knowledge.ts --bundle --platform=node --format=esm --outfile=/tmp/knowledge.mjs
node scripts/test-knowledge-search-local.mjs /absolute/web/worktree /tmp/knowledge.mjs
```

The probe refuses remote databases, restores renamed capabilities/columns in `finally`, removes
its fixtures and uses a persistent deterministic embedding stub. It exercises actual SQL/PostgREST,
not mocked query builders. Unit tests separately exercise authorization failures, unavailable routes,
ignored aborts, source identity, cutoff/count semantics and CLI rendering.

## Scope, questions and current definitions

`scope` (product/deployment), `question_state` (open/parked/decided), and `question_scope`
(product/deployment) compose with free text before global ranks and candidate caps. CLI controls are
`--scope`, `--question-state`, `--question-scope`. A question must have source_activity
`knowledge-question`, numeric `madr.question.version: 1`, a valid state and a valid scope.
Invalid metadata is inert. Effective scope uses valid question scope, otherwise the optional entry
scope; missing scope never matches an explicit filter. Ordinary entry scope is read through row JSON,
so this capability works both before and after B-1141's optional column exists.

Question hits expose `question_state`, `question_scope`, `answer` and `resulting_decision_id`.
The answer is `not yet decided`, or `decided; see resulting decision` with authoritative
`superseded_by`. Default status stays Accepted; callers must request Superseded to find decided
questions. Fusion preserves semantic distance regardless of lexical/semantic completion order.
No second question scorer exists.

Search envelopes also include `definitions`, `refinements` and `definitions_available`.
Default and product-scoped lookup reserve the caller's shared limit for current full quotable definitions, then linked
Accepted refinements, then ordinary scored matches. These are distinct result classes; definitions
and linked refinements never receive invented scores. Identities already shown there are removed
from ordinary results. `definitions_only` launches no ordinary decision ranking. All definition and
refinement work shares the original absolute deadline, and storage absence/timeout is explicit.
Explicit decision filters select decisions only; combining them with definitions_only is rejected.
Structured definitions-only lists retain their existing array shape.

Scored queries never call `knowledge_search_rrf_metadata`. That transitional B-1141 function must
remain for older clients and the supported legacy path during rollout: dropping it while the plugin
runs staging source against the production board would break those callers. The new scored RPC
supplies scope filtering itself. When that capability is absent, this reader uses the existing metadata RPC for supported legacy scope filtering and reports question
filters unsupported instead of silently discarding them; the ordered unscored fallback is unchanged.
The legacy function can be retired only after its supported consumers have migrated.

The candidate relation extension contract now also includes source_activity, guarded question state/
scope, authoritative successor, optional entry_scope and read_metadata. New sources provide null
question metadata unless they implement that exact versioned contract. They share the same class
budgets; no source-local or question-local score/cap is introduced.

## Integration boundary after the B-1241/B-1228 wave

Filter-only list/get retain B-1241 generated source values (including prefixCount/pagePrefixCount
pagination) and B-1228 claim_context enrichment. The scored envelope does not yet admit generated
source values or hydrate claim_context. Those are B-1240 extensions, not proven by this release.
Generated values must enter SearchCandidateSource before global ranks and shared class caps rather
than being prepended as if scored. Claim-context reads must be abortable and share the original
absolute deadline, with explicit capability/timeout diagnostics; the current unbounded list/get helper
cannot simply be awaited on the scored path. No score or completeness claim covers those omitted
sources/enrichments. Search still projects guarded question metadata and authoritative lineage.
Current definitions resolve retired aliases through the definition RPC, and an unscored concepts class
reports aliases with no current definition within the shared result limit. Historical wording scans
on decision search hits remain part of the deadline-aware enrichment extension.
