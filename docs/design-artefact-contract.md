# Design artefact v1 (B-1202)

A design brief's `doc.frame.design_artefact` is its pending review manifest.
Acceptance projects exactly that manifest to
`tasks.field_values.gate_slots.design.content.design_artefact`; a brief with no
artefact does not clear or replace a previous accepted design. The slot also
records `source_brief_id`, `accepted_at` and `drift`.

The wire shape is documented with a complete example in
[the visual hand-off skill](../skills/harmony-visual-handoff/SKILL.md#durable-design-record-b-1202).
The authoritative runtime validator is `DesignArtefactSchema` in
`src/tools/design-artefact.ts`. Common fields are `schema_version: 1`, `tool`,
`composed_at`, `provenance_notes` and measured integer `mcp_call_count` (zero is
valid). Figma records require `file_key`, `file_url` and ordered
`nodes[{id,name,caption,preview_attachment_id,preview_filename}]`; `version_id` is optional (B-1203): a live-file
composition has none, and the plugin writes a versionless record only when `design_artefact_capability` reports
`version_optional: true`, otherwise `validateDesignAttachments` throws `VersionOptionalUnsupportedError`. HTML records
use `surface_attachment_id` and `surface_filename`; no Figma version is invented.
There are no persisted signed URLs or credential fields.

Composition renders previews from the LIVE file (`GET /v1/images`, no version) and never saves a version; the
versioned protocol below serves only the reconcile read-back of a record that carries a `version_id`. Compose validates finalized same-ticket attachment IDs, filenames and media types.
The producer must check that all requested frames exist at explicit version X,
render at X, verify non-null image results and download their PNG bytes. A valid
version can predate the new frame and return 200/null. The source preparation
helper tests this protocol with a bounded autosave wait; callers integrating it
must upload the returned bytes through the existing attachment substrate.

At acceptance the consuming worker reads latest version Y through REST when an
optional injected `HARMONY_FIGMA_TOKEN` is present. Credentials are not stored or
fetched here. A versionless record has no version to compare: its drift is the content fingerprint
(`src/tools/design-fingerprint.ts`) taken by the leg that consumes the design accept (`harmony design fingerprint take`),
stored at `field_values.design_fingerprint` and compared by the plan and build gates (`... compare --by plan|build`). The observation is `changed`, `unchanged`, or `unchecked`, with a
`checked_at` timestamp and `latest_version_id` when known. The slot RPC freezes
the first observation on the accepted event before writing. Retries reuse the
ledger; an older event cannot overwrite a newer accepted design. X is always the
pin, even when latest-version lookup fails. Browser accepts use the same event
consumer and never require the browser to hold a Figma token.

Reconciling a designer's edits (B-1204) writes a pending revision the same way as any
other: `reconcileDesign` (`src/tools/figma-reconcile.ts`) reads the baseline artefact and
the fresh version over REST and renders previews through `prepareVersionedPreviews`; the
skill uploads the bytes, `assemblePendingArtefact` builds a record that passes
`DesignArtefactSchema` (`provenance_notes` serialized one line per note, designer edits
marked `human-in-tool`), and recomposing the active design brief with it as
`frame.design_artefact` is the write. The capability probe and attachment checks above run
there; the reconcile module has no capability argument of its own.

Both accepted and pending views resolve ordinary attachment access at read time.
A removed preview keeps its filename and unavailable state. HTML is a forced
attachment download, never an iframe. Brief history retains earlier manifests.

## Deployment boundary

Merge the B-1202 web PR first. Its additive migration extends the existing slot
writer without changing its owner, SECURITY DEFINER mode, `search_path` or caller
roles, and adds the read-only `design_artefact_capability()` probe. That web merge
must be promoted to production by the founder before a staging worker can compose
artefacts against the production board. The plugin probes for exactly
`schema_version: 1`; absent/error/unsupported capability refuses artefact-bearing
composition with a promote prerequisite. Ordinary briefs make no probe and keep
working. The web readers tolerate absent records and unknown future slot fields.
