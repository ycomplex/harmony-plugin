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
