# docs/

`notify-outbox-contract.md` (B-973) is the **first first-party document** under `docs/` — everything
else here is the vendored `superpowers` subtree, not authored by this repo.

`agent-adapter-contract.md` (B-1075) is the ten-seam agent-adapter contract: the seams, the B-934
credential and cost-regime rules, how to run the conformance suite, and where B-1076, B-1077 and B-1078
plug in.

`codex-phase0-findings.md` (B-1076) records the Codex Phase-0 spikes: the resolved CLI version, what was run
(for real, and against a mock model provider), and which spikes are BLOCKED on a live plan login.

`conductor-config.md` (B-1170) is the reference for the two-file conductor config (`.harmony/conductor.json`
plus the host file): every key, precedence, how the project file is read from `main`, hot vs restart-needed
keys, the three `harmony conductor config` commands, the adoption runbook and the deprecated list.

`conductor-lifecycle.md` (B-1171, B-808) covers `harmony conductor start | stop | restart | status` and the
`--remote` forms: what each verb does, the shared pre-flight, adopting running legs, and the operator machine (the
CLI on PATH, the minimal laptop host file, gcloud and `gke-gcloud-auth-plugin`).

`recorded-walk-contract.md` (B-1062) is the contract for recording a ticket's gates instead of conducting them: the
`recorded_walk_requests` table the web's Record action writes and the plugin's walk reads.

`remote-conductor-runbook.md` (B-1173, B-1186) is the operator's runbook for running the conductor as one pod on a
project's own GKE cluster, written generic (placeholders for project, cluster, account and region): prerequisites
for an operator machine with only the plugin installed, sizing the system pool, choosing the parallelism ceiling
and requesting the GCP quotas it needs (§3a, B-1194), the PriorityClass, applying the manifests, the ordered cut-over
steps, and the fallback.

The knowledge contracts (v1.10 Knowledge):

- `knowledge-search-contract.md` (B-1223) and `knowledge-search-admission.md` (B-1253, B-1254): bounded hybrid
  search for `query_knowledge` / `harmony knowledge list --search`, its filters, the per-route relevance admission
  and score cutoff, and the `routes_tried` / `relevance_admission` envelope.
- `knowledge-amendments.md` (B-1111): `update_knowledge_entry`'s `prepend_section` / `append_section` modes.
- `knowledge-questions.md` (B-1242): unresolved questions as specification entries (open, parked, decided).
- `current-definitions.md` (B-1226): current term definitions per concept and `publish_definition`.
- `feature-accounts.md` (B-1234): live feature accounts and their pending amendments.
- `rendered-surface-records.md` (B-1236): observed labels, buttons and headings per component, and the build leg's
  `SURFACE-CAPTURE:` outcome.
- `prose-indexing.md` (B-1240): opting a repository's skills and docs into search with `.harmony/prose-sources.json`
  and `harmony knowledge sync-prose`.
- `source-values.md` (B-1241): publishing source-backed operator values, the source inventory and document coverage.

The Figma design-tool adapter (v1.11 Design in the loop):

- `figma-connection-rollout.md` (B-1201, B-1314, B-1337): the founder's rollout for workspace Figma connections,
  with Harmony's own values: the default-off switch and its enable gate, the connect and refresh identities, the
  per-workspace secret slots, the refresh image's build and CronJobs, and the proof ledger. A living document
  (Tier 2, project; harmony-workspace `docs/README.md`).
- `design-artefact-contract.md` (B-1202): a design brief's `design_artefact` manifest, how acceptance projects it
  into the design gate slot, and the drift record (version pin or content fingerprint).
- `figma-connection-build-proofs.md` (B-1201): the live build prerequisites the accepted plan required (native
  runtime authentication, the refresh proof, slot permissions); an operator handoff, not evidence that a proof passed.
