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
