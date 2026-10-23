# Configured prose indexing

A project's repositories opt in with a versioned `.harmony/prose-sources.json`.
Run `harmony knowledge sync-prose --root <checkout> --commit <merge-sha>` after merging.
The command reads committed Git blobs, never executes prose or follows symlinks.
It requires the selected commit to equal the declaration's tracked ref and verifies
origin identity. In CI, fetch the configured ref and pass its immutable SHA.
Use a branch ref such as `refs/remotes/origin/main`; `HEAD` is suitable for CI's
detached merge checkout. The declaration must be read from that same commit.

```json
{"version":1,"repository":"https://github.com/acme/example","ref":"refs/remotes/origin/main",
 "sources":[{"key":"product-guide","selectors":[{"include":["docs/product/**/*.md"],
 "exclude":["docs/product/archive/**"],"kind":"document","scope":"product",
 "domain":["product"],"tags":[],"bookkeeping":false}]}]}
```

Source keys are stable within the project. Selectors must not overlap. Kind is
`document` or `skill`; scope is explicitly `product`, `deployment`, or `null` for
unresolved/mixed prose. Product-only queries exclude unresolved and deployment
sources. Split mixed material into explicit selectors instead of inferring scope
from paths. Tags must belong to the project's vocabulary. Indexing never ratifies
prose. Harmony's initial broad plugin selectors deliberately have unresolved scope;
its web product documents have explicit product scope.

Use `harmony knowledge prose-sources` to inspect coverage and current revisions.
MCP offers `read_prose_sources`, `configure_prose_source`, and `set_defined_in`.
Use `harmony knowledge defined-in <entry-uuid> --pointer '<JSON>'` to attach a source
pointer with `source_id`, `path`, `anchor`, and current `commit`; `null` removes it.
The existing web knowledge drawer also reads and edits these pointers. A renamed
or deleted heading becomes unresolved until explicitly updated. Entry edits preserve
the separate pointer. Source status is `Source-backed`, not Accepted; generated
inventory values remain Asserted. Explicit decision type/status filters exclude both.
Default search includes them in the single candidate relation before global scoring.
No source-local score, cutoff or cap exists. Missing embeddings are reported.

Refresh uses a complete immutable snapshot and a fenced publication token. A later
refresh invalidates an older publisher. Readers see one active generation; successful
replacement removes old text and links. Failed refresh preserves the previous
snapshot and reports stale coverage. Files above 1 MiB, sections above 24000
characters, binary files, symlinks and ambiguous selectors produce explicit coverage
diagnostics. There is a 10000-chunk publication bound; narrow sources if exceeded.
Preamble is a root section; Markdown headings use GitHub-compatible Unicode anchors
and duplicate occurrence suffixes. Fenced examples do not become headings.

Removing a source from a still-present declaration disables it on the next sync.
To remove all sources, keep one explicitly disabled source declaration. Do not delete
the declaration itself: CI must report that configuration failure, not silently retain
an apparently current index. An explicit configure operation can also disable a source.
Configuration changes invalidate its previous snapshot until refresh completes.

`.github/workflows/prose-index.yml` is the generic merge-refresh recipe, installed in
both Harmony repositories. Provision a project-scoped `HARMONY_PROSE_INDEX_TOKEN`
repository secret before enabling publication. Missing credentials and missing schema
fail that refresh visibly; ordinary entry search remains usable. The CI job targets
the board selected by that token; never use a service-role key. Schema and plugin
release ordering follows the capability-tolerant search contract. After the additive
schema reaches the board, dispatch the workflow to backfill merged sources.

Source coverage, defined-in reads, claim-context questions and historical-wording scans
share search's original absolute six-second deadline. Missing or failed optional work
marks the envelope incomplete. Authentication errors remain errors. List/get generated
value pagination remains unchanged. No claim-context result changes a claim's authority.
