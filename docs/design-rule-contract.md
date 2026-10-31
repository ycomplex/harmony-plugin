# Canonical rules in design acceptance

A rule is an Accepted `convention` knowledge entry carrying the registered `rule`
tag. Its claim is the current exact obligation; domains, scope and surface tags
describe applicability. Designs cite canonical entries rather than copying rules
into their projected content. Full entry reads expose `rule_fingerprint` and
`rule_citations` with both approved and current fingerprints.

Design frames declare `decision_reach` (`this_ticket_only`, `this_surface`,
`this_product`) and `rules`. Each rule declares `ref`, `operation`, `wording`,
`reach`, `scope`, `domains`, `surfaces`. `reference` and `amend` require an explicit
`entry_id` and `expected_fingerprint`. Amendment also requires `before` wording.
The brief previews this complete declaration; its acceptance snapshot retains it.
Legacy frames without a structured declaration remain usable.

Composition derives one `rule_bundle` payload. Its database writer validates the
accepted snapshot, project scope, membership, target status and fingerprints.
Registry identity normalizes whitespace in the exact claim and sorts distinct
domains and surfaces; it does not perform semantic matching. A project lock
serializes identical creation and amendment. Identical creates reuse one entry;
amendment keeps its UUID and history, and identity collisions refuse.

Rules, structured decision citations, ordinary ticket references and the bundle
ledger result commit together. A failed bundle rolls back. The event/ref key has
an immutable request digest. A retry checks that committed result before checking
the now-stale amendment fingerprint. Projection follows the bundle; final event
consumption refuses missing bundle results, even on non-last design tracks.
Mixed product criterion edits retain the same bundle writer; only the criterion
edits use the owning gate's existing fallback.

## Deployment

Land the additive web schema and completion guard first. Promote the database
before enabling rule promises on the production board. Plugin composition probes
`knowledge_rule_bundle_capable`; unsupported promises are refused visibly and
never stripped. The old consumer cannot finalize a promised bundle without a
ledger result. Update the conductor before relying on the new consumer. Source
PRs do not bump the plugin version or track generated bundles. Both merges and
production promotion remain operator decisions.

The design gate account amendment is pending-only; this build never publishes
live feature-account text. Historical convention reclassification, procedures,
retrieval ranking and rule discipline on other authoring paths remain excluded.
