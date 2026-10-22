# Current term definitions

Definitions reuse a workspace `concept` entity UUID and own their current wording per project. Their result kind is `definition`; ordinary decisions retain their existing shape. `knowledge list --definitions-only` (MCP: `query_knowledge` with `definitions_only: true`) returns current accepted definitions. A term search leads with definitions, then linked refinements, then ordinary matches. Explicit decision type/status/history filters remain decision-only.

`publish_definition` / `knowledge publish-definition` publishes full wording from an Accepted decision in the same project. Supply the concept UUID, source decision UUID and expected current revision UUID (`null` only for first publication). Publication atomically appends an immutable revision and switches the stable definition's current pointer. A stale expected revision fails; read the winner and review before trying again. Metadata can carry source ticket, PR and commit references. Refinement UUIDs add project-scoped links and never detach earlier links. No generic decision acceptance automatically changes wording.

The definition read RPC is an independent capability. Specifically missing definition storage leaves ordinary retrieval available, and definitions-only requests report unavailable. Permission, network, malformed payload and unrelated missing-function errors remain errors. Missing capability is probed again on every request, so plugin readers can land before the additive schema reaches production.

The web migration also contains Harmony's 82-row vocabulary seed, authorized by its Accepted scope. It skips environments without that source; it never seeds Harmony terminology into unrelated projects or overwrites newer accepted wording. Citations name stable concept UUIDs. Rename aliases and contextual claims consume these UUIDs in their own tickets.

Local verification uses `scripts/test-definition-lookup-local.ts` against the localhost E2E fixtures. It exercises the real shared handler before and after hiding/restoring the definition RPC; it must never run against a hosted board.
