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

## Build capture and evidence

For each changed user-facing component, resolve the exact owner from this ticket's
Accepted scope/design, read it with `read_feature_accounts`, then read its existing
capture with `read_surface_records`. Similar names or directory proximity do not
authorize an owner mapping.

If the owner read returns `not-found`, a build may call `create_feature_account`
**only for an exact `owner_surface` explicitly ratified in this ticket's Accepted
scope/design**. Record the authorizing decision/scope and exact component mapping in
the ticket evidence. Probe the create capability first, create only the empty
identity, then read it back to confirm the stable account id and owner before
capturing. Leave all existing clauses/accounts untouched. Do not insert clauses,
propose amendments, or publish `current_text` to enable a capture. If ownership is
ambiguous or creation is not authorized, report the component's missing-owner gap;
never invent an identity. `unavailable` and permission/network errors are separate
outcomes, not `not-found` and not permission to try another write path.

Extract wording from the actual committed component source or screenshot alt text
and follow **Capture and refresh** above. Include static accessible labels, button
names and headings; do not invent values for runtime data or error interpolation.
Read the capture back and compare wording, component, owner and source metadata
before claiming success. This creates an observed record, not account text or a
historical decision. Read the account again to confirm live text and clauses were
left untouched; identity-only creation does not authorize publication.

Every build evidence comment must include a literal `SURFACE-CAPTURE:` outcome,
including builds that changed no user-facing components. Report each changed
component separately, including gaps alongside successful captures. Use these
forms with real values (the angle-bracket fields are placeholders):

- `SURFACE-CAPTURE: captured <n> record(s) for <owner_surface>/<component_ref>; record=<id>; source=<locator>; fingerprint=<sha256>; readback verified`
- `SURFACE-CAPTURE: no owner identity for <component_ref> — gap; <missing authorization or ambiguous mapping>`
- `SURFACE-CAPTURE: unavailable (<capability and reason>) for <component_ref>`
- `SURFACE-CAPTURE: error (<actual error>) for <component_ref>`
- `SURFACE-CAPTURE: no user-facing component changed`

If capture succeeded but readback did not, report an error and the uncertain
record/write result, not `captured`. Preserve actual errors and refuse unsupported
writes explicitly. Before release, disposition each unresolved gap/blocker through
the owning ticket's tracked scope/acceptance criteria or the normal follow-up drain;
a comment alone does not complete it. Tests of handlers cannot replace an owed live
capture/readback. This outcome requirement applies to both agent runtimes.

## Rollout and errors

Merge the web schema and reader to staging, then the plugin handlers and build instructions. Production promotion applies the web migration before promoting the plugin. No plugin version or generated bundle changes belong in the PR.

The handlers probe the optional RPC on each call. A confirmed missing surface-record capability returns `availability: unavailable` on reads and explicitly refuses captures. An existing owner with no captures returns `available` plus an empty `records` array; an unknown owner returns `not-found`. Authorization and network errors remain errors. Never fall back to account text or decision entries.

`read_surface_records` includes the owner's live `current_text` as read-only context. Capturing observations changes neither that text nor account revisions, amendments or knowledge events. Project-scoped authorization and row security also protect direct table reads; mutations use only the guarded RPC.

Validation: web `scripts/test-b1236-surface-records-db.sh`, plugin handler/CLI unit tests, opt-in `HARMONY_TEST_LOCAL_SURFACES=1 npx vitest run src/tools/surface-records.local.test.ts`, and web `e2e/tests/surface-records.spec.ts`. The opt-in smoke targets only localhost and temporarily renames the optional RPCs to test older-schema behaviour.
