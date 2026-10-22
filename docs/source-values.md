# Publish source-backed operator values

A surface can declare a trusted publisher that extracts exact defaults, errors, file shapes,
measurements and explanations from source comments or build recipes. Publication writes deployment
facts with `source_type: generated` and `status: Asserted`. It never ratifies a design decision or
changes a term definition. Current values appear in ordinary knowledge lookup with their provenance;
explicit status/type/tag/history filters continue to select ordinary entries. Product scope excludes
these deployment facts. The CLI inventory and coverage operations fail explicitly before their schema
and metadata capabilities are deployed.

## Declare and run

Commit `.harmony/source-publishers.json` in the repository:

```json
{"version":1,"repository":"owner/repo","publishers":[{"surface":"config","publisher_version":"1","inputs":["src/config.ts","scripts/extract-config.mjs"],"command":["node","scripts/extract-config.mjs"]}]}
```

Commands are trusted repository code, executed with the job's privileges. Never load declarations
from untrusted documents or pull requests in a privileged publishing job. Inputs are git pathspecs,
not shell expansions. Include the extractor and its dependencies as well as the extracted sources.
Publishers emit a complete JSON array; each value has a stable `key`, `kind`, `title`, `content`,
nonempty `spellings` and `source.path`. Optional tags must already exist in the project's vocabulary.
Ticket/surface/bookkeeping namespaces cannot be authored here: they require verified release evidence.
No new reserved namespace is introduced.

`source.line_start` and `line_end` can identify a source span. Measurements additionally supply
`source.measurement` with `command`, `parameters`, `tool_versions` and the captured `result`.
The runner supplies the immutable source SHA, publisher/version and CI run URL. Missing sources,
changed input bytes, undeclared evidence, failed commands, malformed values and duplicate keys fail
before publication. A publisher must extract from its actual schemas/constants or executed measurement,
not repeat copied values. See `examples/source-values/` for an executable five-kind specimen.

```sh
harmony knowledge publish-values --surface config --run-id "$CI_RUN_ID" --run-url "$CI_RUN_URL" --output /tmp/config-inventory.json
harmony knowledge source-inventory --repository owner/repo --surface config
harmony knowledge compare-coverage docs/config.md --previous /tmp/config-before.md --repository owner/repo --surface config
```

The coverage report names mentioned, missing and previously-mentioned/now-missing keys, includes
source pointers and matched aliases, and identifies the inventory revision. Matching is literal,
case-sensitive and bounded by identifier characters, with punctuation escaped. This is explicit-mention
coverage, not proof of semantic completeness. Comparison never executes document contents.

## CI regeneration

Run the same `publish-values` command in the project's trusted post-checkout CI publishing step after
relevant inputs change, or on every successful main build. Use a project-scoped Harmony API token
through the normal CLI auth configuration. Fetch enough git history for the previous published SHA
(`fetch-depth: 0` with GitHub checkout). Do not publish from a PR job with elevated credentials.
A manual full regeneration uses exactly the same declaration and command. Nonzero exit fails the job;
never swallow unavailable-schema or tag-validation errors. Store `--output` as a CI artifact for audit.

The runner reads the current inventory revision *before* extraction, rejects an older/divergent checkout,
then publishes with compare-and-swap protection. Concurrent jobs based on the same revision cannot
both replace it; the loser must update the checkout and regenerate. A replay with the same run ID and
identical batch returns the original revision; reusing the run ID with changed values fails. The direct
`source-publish <json>` and MCP `publish_source_inventory` APIs accept a fully extracted inventory;
callers must capture `expected_revision` before extraction and enforce source ancestry as the runner
does. Revision hashes alone cannot establish git ancestry inside PostgreSQL.

Replacement is atomic and owned by project + repository + surface. Stable keys retain entry IDs,
removed keys become Archived and disappear from current reads, and unrelated entries survive.
Metadata validation and typed publication events share the transaction. The database locks that ownership
row and refuses stale revision snapshots. The publication/read APIs enforce existing project access.

## Rollout and verification

Merge the additive web schema before plugin callers. Main deploys to staging. Plugin staging workers
against production refuse explicit publication until the final deliberate production promotion.
The database test wrapper is discovered by web CI; plugin CI runs the extraction and coverage tests.
The runner test commits a real source change and regenerates a new value and revision without a fixture
clock. Run an actual `publish-values` twice against the local/staging board, changing a committed source
between runs, and verify the new value in `knowledge list --search` and the coverage report. Production
credentials are not needed for the local smoke. No web screen or complete guide generation is included.

For the repository's local real-database smoke, with the local web Supabase stack running:

```sh
./node_modules/.bin/esbuild scripts/test-source-values-local.ts --bundle --platform=node --format=esm --outfile=/tmp/source-values-smoke.mjs
node /tmp/source-values-smoke.mjs
```

This smoke is pinned to localhost and the seeded local development user. It creates and removes its own
workspace and exercises two concurrent HTTP publishers as well as regeneration and retrieval.
