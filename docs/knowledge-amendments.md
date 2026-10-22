# Preserving knowledge amendments

`update_knowledge_entry` accepts `content_mode: "prepend_section"` or
`"append_section"`. Send only the new section as `content`; the database locks
the entry and combines it with the full stored content, separated by a blank line.
The default mode is `replace`.

```sh
harmony knowledge update <entry-id> --content '### Amended 2026-10-22
New information.' --content-mode prepend_section
```

A replacement is refused when it is shorter and removes an existing dated
amendment marker. The error names the lost markers. For a deliberate rewrite,
pass `allow_shrink: true` (CLI: `--allow-shrink`). This is explicit authorization
to drop history. It is not required for normal metadata edits.

The detector recognizes ISO-dated Markdown headings containing `Amended` or
`REVISED`, and ISO-dated bold banners containing `REVISED`. It counts repeated
markers and ignores fenced code examples. This is a structural guard, not a
semantic comparison: a longer replacement or one retaining all markers can
still change prose. No recovery-history store is introduced.

Database enforcement also covers old RPC, direct-table and compatibility-view
writes. Concurrent section amendments serialize on the entry lock. Missing
database support causes content updates to fail with migration guidance, never
fall back to unsafe replacement. Metadata updates retain the old RPC.

Deployment: merge the web prerequisite and promote its migration to production
through the workspace promotion path before merging the plugin PR. Staging
workers use ahead-of-prod plugin code against the production board, so merely
deploying the migration to staging is insufficient.
