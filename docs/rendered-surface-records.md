# Rendered surface records

Rendered surface records hold observed labels, button names and headings for a component. They live separately from current feature accounts and ticket decisions. A capture describes its cited component source or screenshot alt text; it does not assert production rollout.

Use an existing project-scoped owner surface from `read_feature_accounts`. `capture_surface_record` never creates that identity or publishes account text. The stable record key is the owner account plus a repository-relative component reference. Multiple components may share an owner.

## Capture and refresh

Read the actual component source or screenshot alt text, extract exact wording into `labels`, `buttons` and `headings`, and provide empty arrays for groups with no observed wording. Cite the evidence in `source_locator` and use its SHA-256 as `source_fingerprint`. Keep the locator stable when the fingerprint is unchanged.

```json
{
  "owner_surface": "project views",
  "component_ref": "web/src/features/projects/components/ProjectViews.tsx",
  "labels": ["View"],
  "buttons": ["Board", "List"],
  "headings": [],
  "source_kind": "component-source",
  "source_locator": "web/src/features/projects/components/ProjectViews.tsx@commit-sha",
  "source_fingerprint": "sha256:source-evidence-hash"
}
```

Call `capture_surface_record` with this object, or save it as `capture.json` and run:

```sh
harmony knowledge surfaces capture --file capture.json
harmony knowledge surfaces read --surface 'project views'
harmony knowledge surfaces read --surface 'project views' --component web/src/features/projects/components/ProjectViews.tsx
```

An identical fingerprint and payload preserve the record ID and capture time (`changed: false`). A changed fingerprint replaces the current observation and source metadata under the same record ID. Reusing a fingerprint with different wording or source metadata is refused without a write. Read back the record after capture.

The Knowledge owner drawer shows a separate **Rendered surface** section after live production text, with wording grouped by kind, source and capture time. **Refresh captures** reloads the observations without editing them.

## Rollout and errors

Merge the web schema and reader to staging, then the plugin handlers and build instructions. Production promotion applies the web migration before promoting the plugin. No plugin version or generated bundle changes belong in the PR.

The handlers probe the optional RPC on each call. A confirmed missing surface-record capability returns `availability: unavailable` on reads and explicitly refuses captures. An existing owner with no captures returns `available` plus an empty `records` array; an unknown owner returns `not-found`. Authorization and network errors remain errors. Never fall back to account text or decision entries.

`read_surface_records` includes the owner's live `current_text` as read-only context. Capturing observations changes neither that text nor account revisions, amendments or knowledge events. Project-scoped authorization and row security also protect direct table reads; mutations use only the guarded RPC.

Validation: web `scripts/test-b1236-surface-records-db.sh`, plugin handler/CLI unit tests, opt-in `HARMONY_TEST_LOCAL_SURFACES=1 npx vitest run src/tools/surface-records.local.test.ts`, and web `e2e/tests/surface-records.spec.ts`. The opt-in smoke targets only localhost and temporarily renames the optional RPCs to test older-schema behaviour.
