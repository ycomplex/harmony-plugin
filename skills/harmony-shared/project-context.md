# Source-linked project context (B-1388)

Harmony is authoritative. Project CLAUDE.md is a bounded cold-start summary, not a second decision record.
One shared projection powers `read_project_context` (read-only MCP), `harmony project context check
--root <repo> --json`, and `harmony project context refresh --root <repo> --json` (explicit local write).
The CLI uses the active project's credentials: check `harmony project info --json` before any refresh.
Never switch projects or invent a summary to make a refresh pass.

## Author the source before its human decision

For a founding proposition's clarify brief, include three short, exact entries in `doc.context`:
`Project context purpose: <purpose>`, `Project context personas: <personas>`, and
`Project context features: <features>`. Each is one line, at most 160 words / 1,200 characters.
These are part of what the human ratifies; the Accepted entry's mechanical projection preserves them.
For an S2 decision, use one `Project context summary: <short outcome>` entry in its completing
brief's context, or its authored claim. Explicit N/A must say `N/A for this project` and why.
Never infer N/A from an unfinished ticket. Legacy sources lacking adequate bounded material need
confirmation in Harmony; never truncate rationale into a replacement claim or edit Accepted decisions
silently. Explicit `madr.project_context` fields (purpose/personas/features, or summary) are also read.

## Consume a completing human accept

After its pending payload and the B-1384-authorized fast-forward have landed, the session consuming
a founding-proposition or S2 completing accept runs:

```
harmony project context after-accept --task <completed ticket> --root <project checkout> --json
```

This applies equally to an in-session accept and a fresh conductor leg after browser acceptance.
It uses B-1384's shared deliverable-marker resolver, requires Verified plus the matching completing
brief and recorded human provenance, and never resolves a brief or advances a ticket itself.
An inaccessible checkout or unresolved source leaves acceptance complete and records one pending-context
comment per completing brief/source set, with source entry ids and recovery ownership. A failure to
write that comment remains visible; do not describe it as successful reporting. No repo is required at
inception time: call against the intended root and report pending rather than blocking acceptance.

## Bootstrap and later repair

Stamp Bootstrap the stack with this obligation: regenerate project CLAUDE.md from current Accepted
knowledge before its first commit, preserve unrelated stage semantics/instructions, and include it
in the first commit. Call the same `refresh` command; missing/ambiguous authoritative sources must be
confirmed before claiming a regenerated first-commit file. The founder does not hand-maintain a separate
context commit.

Start-work calls `check` before planning and again in its build checkout. For an inception-scaffolded
project, read `outcome` before scheduling any work:
- `stale`: sources resolve and the section differs; plan repair in the ticket's PR using `refresh`.
- `current`: no repair.
- `unresolved`: refresh refuses; use the owning gate's elicitation for the named source/ticket.
- `not_applicable`: no live inception scaffold exists; check returns `stale:false`, no diagnostics,
  and refresh is a no-op, including when an old managed section exists. Partial scaffolds remain unresolved.

For applicable projects, the existing `stale` field still means the file differs from the rendered
projection, even when diagnostics make that projection unwritable. It is not a repair instruction.
Older JSON without `outcome` requires checking diagnostics before `stale`.
Key source clarification to the sorted source-id/diagnostic set: inspect the ticket's existing exchange
and recorded answers, consume an answered round and re-read authority before asking again. Reuse an
open round for the same set; a repeated check alone never justifies another question. Every check
resolves the current category sources and supersession chains anew, so both a Superseded source and a
newer Accepted source change the managed section. If the project has no inception scaffold, context
refresh is not applicable. Missing or duplicate scaffold identities within an inception project,
competing sources, unreadable lineage or inadequate summaries are unresolved, not N/A: surface the
specific source/ticket for confirmation through the owning gate's normal elicitation path.

Only the span between `<!-- harmony:project-context:begin -->` and
`<!-- harmony:project-context:end -->` is replaced. With neither marker, append once. Malformed or
multiple markers and concurrent edits are refused. Repeating refresh is byte-idempotent and preserves
unrelated instructions. There is no background sync or supersede-event writer.

## Decision authority

Use the recorded human completing brief's `decision_ref`, or its payload's
`knowledge_entry_content.entry_id` / `rule_bundle.decision_id` when no reference exists.
Follow project-local Accepted supersession; a qualifying but unreadable/conflicting reference is
unresolved, never a reason to choose another entry. Modern completion uses its explicit frame.
A legacy design brief qualifies only with the decision-only marker, human acceptance and the
recorded following Designed→Verified edge without an intervening accept/state change. Duplicate
accept audit rows do not multiply authority. The after-accept consumer uses this same evidence.
An agent accept or missing marker does not authorize consumption and leaves the reader on fallback.
Fallback for S2 is the scaffold's single Accepted `source_activity:design-decide` entry with populated
`madr`, independent of decision type. Rule-tagged entries and clarify/decompose companions are not
competitors. Two genuine candidates remain unresolved. Proposition specification selection stays separate.
Read failures remain errors; they never imply absence of inception. No fingerprint cache is stored.
