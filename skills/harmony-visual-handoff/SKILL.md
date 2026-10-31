---
name: harmony-visual-handoff
description: Run a UX/UI design decision through a generated, manipulable surface + an iterate loop (B-328). Triggers on "visual hand-off", "generate a mockup for this decision", "show me the UX options", and is delegated to by harmony-design-decide's --track ux-ui. Routes glanceable decisions to a parametric preview and flows to a walk-through + storyboard; reserves a design tool (Figma) for the irreducibly-generative visual residue. Files the framed decision back as a knowledge entry.
capabilities: harmony-mcp figma-mcp read web write shell:open shell:mkdir shell:node
allowed-tools: mcp__harmony__* mcp__figma__* Read Grep Glob WebSearch WebFetch Write Bash(open *) Bash(mkdir *) Bash(node *)
---

**Knowledge claims:** Author `claim` as one quotable sentence (at most 50 words) on every `record_decision` / `create_knowledge_entry` write, and on `update_knowledge_entry` when confirming or replacing a claim. A successor uses `claim` in `supersede_decision` or `new_claim` in `supersede_knowledge_entry`; retire-only calls have no successor claim. On every entry-producing `compose_brief`, author the exact approved sentence as `doc.claim`, separately from the recommendation. Use a sentence-shaped title; compatibility-derived proposals are unconfirmed, not authored statements.

> **No `disallowed-tools` here (B-1117, 2026-10-13).** This skill never edits code or runs git — that is
> its role, stated in prose — but it no longer *revokes* Write/Edit/git: Claude Code applies an invoked
> skill's `disallowed-tools` to the rest of the session, subagents included, so in an auto-approved run
> (several gates in one worker leg) the revocation reached the build gate and denied its commit
> (B-1115). Same class as B-1114 (the conduct skill's Edit revocation).

# Harmony Visual Hand-off

Owns the **UX/UI sub-track** of the `designing` activity: hand a UX/UI *structural* decision to a human as a
**generated, manipulable surface + an iterate loop** — the B-328-validated default — then file the **framed
decision** through the same gate machinery the other sub-tracks use.

> Follow `skills/harmony-shared/visual-handoff.md` (the B-328 D1/D2/D3 disciplines) throughout.
> Before deciding, also follow `skills/harmony-shared/knowledge-discipline.md` (query domain knowledge first).

**Role.** Discovery + surface generation. `Write` is permitted **only** to author the throwaway surface to a
tmp path; **never write repo source** — implementing the ticket is the build role's job. The retained
`git commit`/`push`/`merge` disallows are the backstop.

## Flow

### 1. Load + ground

`mcp__harmony__get_task({ task_id })`; confirm the ticket is in `designing` (or `Decomposed`). Query the
sub-track's domains — `mcp__harmony__query_knowledge({ domain: ["product","customer"], search: "<topic>" })`
— to ground the decision in existing patterns and surface gaps. If a **load-bearing** gap blocks the
decision, go research-first per the knowledge discipline and invoke `/harmony-plugin:harmony-research`
before generating anything.

### 2. Route the decision (D1)

Ask the diagnostic: **is the decision-relevant property glanceable in a rendered frame, or only knowable by
traversing/experiencing it?**

- **Glanceable** (layout, component, dashboard, density, copy-on-a-screen) → a **parametric preview**.
- **Sequence / flow** (onboarding, multi-step setup) → a **walk-through + storyboard**.
- **Irreducibly-generative visual residue** (visual identity, motion-feel, novel visual language) → **route
  to a design tool (Figma)** — *not whole flows*. See step 3b. Try the generated surface first; escalate only
  for the generative-visual remainder.

### 3a. Generate the surface (default path)

Clone the template and fill it for THIS decision — **throwaway, tmp only:**

```
mkdir -p /tmp/harmony-visual
# copy skills/harmony-visual-handoff/templates/visual-surface.html to
# /tmp/harmony-visual/<task>-<slug>.html, then Write the filled copy there (never repo source):
#   - OPTIONS / PRESETS for the real controls (keep a "Recommended" preset = your recommendation)
#   - the preview render fn(s) for the routed shape (parametric, or walk + storyboard)
#   - tag every decision-bearing element data-prov="real|invented|illustrative" (D3 tier 2):
#       real        = the human's configured values / a product rule (e.g. the agreed instrument categories)
#       invented    = a placeholder the human must DECIDE (e.g. a 5th category) — never present as decided
#       illustrative= sample numbers/copy
#   - realistic, internally-consistent placeholder data; do NOT fabricate a plausible category/threshold/
#     policy without marking it invented (deference-laundering hazard)
```

Then `open /tmp/harmony-visual/<task>-<slug>.html` and tell the human: start from **Recommended**, explore,
and the banner (`g` key) frames it as a generated sketch.

### 3b. Design-tool residue (escalation path)

For the irreducibly-generative residue only: hand off to **Figma** (the existing `iterate`-with-no-feedback
hand-off, gate-ui-conduct loop §4.2/§4.6) with the design-system context, and capture the returned link. (B-328
did not validate this side — keep it a thin pass-through.)

### 3c. Figma path (B-1203) — selected by the connection preflight

Run the preflight (`src/tools/figma-connection.ts`, `resolveFigmaRoute`) before step 3a:

B-1201: run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma context` for the live connection. Missing schema means unconnected;
other read errors stop. For a connected worker, the launcher has already run `figma install-worker`
during provisioning with the exact generation and version refs and mounted access-token/PAT files.
The worker must not run `figma install-worker` again; if setup is missing or stale, request a relaunch. Look components up with
`node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma component "<variant name>" --in "<set name>"`
and discover sets with `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma component --sets`
(one call, no Figma search). The saved map's set variants are keyed "<set> :: <variant>", so identically
named variants of different sets never collide. An `ambiguous` answer is the answer: pick from the
returned candidates and do not spend a Figma call searching. `component_map` maps names to repository paths for build. Never call
get_libraries/search_design_system per leg. Show “Figma edits are made as @handle” on every
Figma-composed brief. Only an unconnected workspace uses HTML automatically.

Before EVERY actual MCP attempt (including retries), run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma budget --reserve`.
Call only if `allowed:true`; preserve its durable per-conduction/per-leg file across resumes.
On 429 run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma budget --throttled --retry-after '<header>'` (omit absent header).
Wait until retry_at; never retry immediately. A long Retry-After is honored in full, using waits
of at most 60 seconds. `operator-question` means file a worker-question elicitation round asking
the operator when safe to resume; resume only from their answer via `--resume-at <ISO>`.
The used-call counter survives that answer; six-call-cap stops further composition for this leg.
Report used count from the budget on the brief. No shared usage ledger exists: parallel legs
share Pro Full 200/day 10/min, Organization Full 200/day 15/min, Enterprise Full 600/day 20/min.
View/Collab or Starter is about 20/month. These are published limits, not aggregate usage telemetry.
The active logical-leg pointer lives with persisted transcripts, so a throttle-answer worker inherits
the same count even if its physical leg number changes. Include source_leg/retry_at in the elicitation;
do not close that budget while awaiting the answer. After composition is complete and its count is
recorded, run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma budget --close`; it retains counters but lets the next design leg start.

- **unconnected → `html`:** step 3a, today's generated-HTML path, unchanged.
- **connected → `figma`:** this step.
- **failing → `stop`:** stop with the reconnect instruction. **Never silently fall back** to HTML.

Dependencies, not assumptions: the connection reader, the **saved component map** and the shared rate limiter
are **B-1201's**; the stored record, `design_artefact` (schema_version 1), is **B-1202's**. Until B-1201 lands the preflight resolves to
`html`, so this step does not run.

**Adopt first (B-1320).** When the ticket already links a designer's Figma frames, adopt them before composing
anything. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" design adopt-check --task <ticket>` (read-only, REST
only, zero MCP calls; add `--url <figma-link>`, repeatable, to check given links instead of the ticket's). The check
reads the workspace's saved library map and its ambiguous-name candidates, never a Figma component lookup: an
instance is library-built when its component key is in the saved map, or is one of the candidates stored for its
bare name (nested icons). A name-only match is off-library ("drawn from another copy of the library"): the name
matches the workspace library but the component key does not. A missing, empty, out-of-date or errored map leaves
every frame `not-checked`; the output says which, and refreshing the map is the fix. The output gives a verdict
per frame and per instance. For each frame with verdict `adopted` (every instance comes from the workspace library),
compose **no options**: attach live REST previews, build the artefact with `assembleAdoptedArtefact`
(`src/tools/figma-adopt.ts`; every node `human-in-tool`, `mcp_call_count` 0, no `version_id`), and ask **"Adopt these
frames as drawn?"** as the brief decision; the accept records them as the ticket's design, and the content
fingerprint is taken at accept as for composed designs. For EVERY frame given a verdict, adopted or not, attach its
live REST preview to the ticket and list it in `frame.designer_frames` (`id`, `name`, `file_key`, `verdict`,
`reason`, `preview_attachment_id`, `preview_filename`), so the reviewer sees each frame inline above the decision.
State every frame's verdict on the brief with its reason:
adopted / off-library / not covering the decision (your judgment, from the frame against the decision) / unreadable /
not checked. A `not-checked` frame is never adopted. Compose only the uncovered part, from library instances, in the
working file: on a page for the ticket, or, when the ticket's page already holds the designer's frames, on a
separate page named for the ticket and marked agent-composed. Ask nothing and warn of nothing when the designer's
file is the working file. Never modify the designer's frames or pages.

#### Working file (B-1325)

Each Harmony project has its own Figma **working file**. A design leg (a clarify flow sketch, and every design
track, on Claude Code and Codex) composes **only** in that file, on a page named for the ticket,
`<visual id> · <short title>` (e.g. `B-1319 · Design tool`). A later round of the same ticket reuses that page,
found by the `<visual id> · ` prefix. The workspace's library file (the connection's `library_file_key`) is the
component source only: write to the working file, never the library; never compose in the library file.

Before the first `use_figma` call of the leg, run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma working-file resolve` (one JSON line):

- **`ready`** → compose in that file (`working_file_key`) on the ticket page. The compose script finds the page
  by its `<visual id> · ` prefix or creates it (`buildComposeCall`, which refuses a library target), then
  switches with `figma.setCurrentPageAsync(page)` once.
- **`refuse`** (`working-file-is-library`) → stop and say so. Do not compose.
- **`ask`** (`no-working-file`) → stop composing and ask the operator for a Figma file link: file a
  worker-question elicitation round (`mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question', gate: 'designing' })`
  then `mcp__harmony__file_elicitation_round`) asking for a link to the Figma file **for this project**, which
  **must not be the library** file. Never create a file, never choose one yourself, never fall back to the library
  or to any configured or remembered key.
  On the **answered** round: run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma working-file validate <answer>`. Only if it prints `ok:true`,
  run `node "${CLAUDE_PLUGIN_ROOT}/dist/bin/harmony.js" figma working-file save --file <key> --task <ticket> --exchange <exchange id>`. The save is called
  **only after an answered round** and **always records the exchange id** (`--exchange` is required; the command
  refuses without it, and without `--task`). On `saved:true`, add ONE ticket comment with the marker line,
  `FIGMA-WORKING-FILE-SET project=<key> file=<file key> by=<who> via=leg exchange=<exchange id> task=<ticket id>`
  (`formatWorkingFileSetComment`), then compose in that file.
  - `rpc-absent` → use the answered file for **THIS LEG ONLY** and say plainly it could not be saved because the
    board has not been promoted yet.
  - `not-owner` → use it for this leg only, say it could not be saved because this token is not a workspace owner,
    and ask the owner to set it in the Design tool panel.
  - `validate` not ok (`is-library`, `not-found`, `forbidden`, `bad-key`) → tell the operator why and ask again;
    never use that file.
- **`unconnected`** → the HTML path, as above.

Reads of **earlier** designs keep using the `file_key` stored on that design record; the working-file setting
governs **writes** only.

Figma path (planner: `src/tools/figma-composition.ts`):

1. Keep the glanceable-vs-flow routing (step 2) unchanged.
2. Read the **saved component map**; do no per-leg library search. Resolve the working file first (see "Working file (B-1325)" above); compose only there.
3. Call `use_figma` **once**, in the project's working file on the ticket page, to build all option frames from **library instances** (not imported layers),
   named `<ticket> · <option>`, the recommendation marked on exactly one frame, and provenance
   (`real` / `invented` / `illustrative`) as frame notes. A second `use_figma` call only to fix.
4. A flow is N frames in order with a caption each; the order is kept in the planned `nodes` list.
5. MCP is used only for writing (`use_figma`). **Previews render from the LIVE file (B-1203).** The compose
   script returns `{ frameIds }` (the created frame node ids) and **saves no version**: Figma's `use_figma`
   refuses `figma.saveVersionHistoryAsync` and no REST endpoint creates a version, so the compose script has no
   save tail and composition never waits on autosave (`waitForVersionAfter` / `FRESHNESS_WAIT` are not used
   here; on 2026-10-27 autosave took 79 s, and on B-1312 no version appeared in 3.5 minutes). Render previews
   over REST `GET /v1/images?ids=…&format=png` with **no `version` parameter** and the workspace token (not
   `get_screenshot`), download, and attach them. Check with `checkPreviewSet`: every planned frame is in the
   compose call's returned `frameIds` and every image URL is non-null. If a frame is missing or an image is
   null, say so on the brief with the honest note (`NO_PREVIEW_NOTE`), attach **no** preview (never a
   partial set, never a render you have not checked) and do **not** fail the gate. A clarify sketch
   composes the same way; no version exists, so its `frame.sketch.pinned_version` (still a required string)
   records the literal `live`.
6. Every MCP call passes through the shared limiter when present. Count MCP calls: **hard cap 6 per leg**
   (typical 2-3). At the cap, stop composing options and say so on the brief. Record the call count
   (`mcp_call_count`) on the brief.
7. **The stored record is B-1202's `design_artefact` (schema_version 1).** Its fields
   are `tool`, `composed_at`, `provenance_notes`, `mcp_call_count`, and an ordered `nodes` list of
   `{ id, name, caption, preview_attachment_id, preview_filename }`; for Figma only, also `file_key` and
   `file_url`, and `version_id` **only when you hold a real saved version id** (it is optional since B-1203; a
   live-file composition has none). It holds **no signed URLs**. Attach the checked previews, build it with
   `assemblePendingArtefact` (omit `versionId`) and recompose the design brief with it as `frame.design_artefact`
   (see [Durable design record](#durable-design-record-b-1202) and `docs/design-artefact-contract.md`).
   **A versionless record is written ONLY when the board reports `version_optional: true`** from
   `design_artefact_capability`; `compose_brief` refuses otherwise (`VersionOptionalUnsupportedError`, "web has
   not been promoted with the version-optional capability"). When it refuses, do not work around it and do not
   fail the gate: attach the live-file previews to the ticket and **say plainly on the brief that no design
   record was stored** because the board's web lacks the capability (never a silent miss). Tell the operator who
   wants to edit in Figma to save a version first, under the exact name `suggestedVersionName(<ticket>, <brief iteration>)`,
   `Before · <ticket> · round <brief iteration>` (U+00B7 middle dots). Do not invent a frame field or a slot schema.
8. **Throttled (HTTP 429): back off, never retry straight away** (`nextThrottleDelay`, `THROTTLE_BACKOFF`).
   Wait the `Retry-After` the response names (capped), else bounded exponential backoff (2 s doubling,
   at most 60 s, 5 attempts), then retry; a retry is never immediate. Each request actually issued counts
   once against the step 6 cap; the waiting does not. When the backoff is used up and the call is still
   throttled, do **not** fail the gate and do **not** fall back to the HTML path silently (a configured
   connection that cannot be used stops, per the `stop` route). Instead file an elicitation round asking
   the operator when it is safe to proceed, and resume on the answer:
   `mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question', gate: 'designing' })` then
   `mcp__harmony__file_elicitation_round({ task_id, context_line: "Figma is throttling (429)...", questions: [...] })`.
9. A Claude Design scaffold or an inception sketch is **reference only** (re-composed from library instances);
   a designer's own library-built Figma frames are **adopted** as drawn, per the block above.

Then continue at step 4.

### 3d. Reconcile a designer's edits (B-1204)

**Trigger:** the poll trigger / marker `edited-in-tool` on an **active design brief** whose frame carries a Figma
`design_artefact`: `pending_resolution = { command: 'edited-in-tool', detail: "I've made edits in Figma. <optional note>" }`,
staged by the web's fourth verb (or `reshape_brief` with `kind: 'edited-in-tool'`). It is **not** a worded
reshape: do not run the iterate path. Reconcile instead (`src/tools/figma-reconcile.ts`). Read-back is **REST only
(`X-Figma-Token`), at explicit versions, with zero MCP reads**, and the file is never edited.

1. **Baseline.** Read it from the active brief's `frame.design_artefact`: `file_key`, `version_id` and the ordered
   `nodes[].id`. A pinned version is the "before". **A record without a `version_id` (B-1203)** has no pinned
   "before": its baseline is the version the operator saved by hand under the exact name
   `suggestedVersionName(ticket, brief iteration)` (`Before · <ticket> · round <brief iteration>`); pass `ticket` and
   `briefIteration` to `reconcileDesign`, which lists versions over REST, finds the one whose `label` **exactly**
   equals that name (`findVersionByLabel`; newest wins) and diffs it against the **live** file. Anything but a
   Figma artefact is a typed refusal (`baseline-not-figma`): say so on the brief.
2. **Call `reconcileDesign`** with that baseline, the `containerId` (the page or section whose children are the
   frames; the artefact stores frame ids, not their parent) and the Figma token. It chooses the fresh version
   (`chooseFreshVersion`: anchored on the file's **last-modified** time, not the press time, since an autosave
   taken before the press already holds the edit; bounded by `FRESHNESS_WAIT`), reads both snapshots over REST,
   diffs, interprets, and renders previews pinned to one explicit version with B-1202's
   `prepareVersionedPreviews`; if that settles on a different version it re-diffs there, so the change lines
   match the previews. If no saved version appears (`save-a-version`), **do not guess**: the result becomes a
   **question item** telling the designer to save a version (File > Save to version history) and press the action again.
   **Versionless record, no such version (`named-version-missing`):** say on the brief, exactly,
   `I can't see a version named "<name>".` plus the instruction to save one under that name (File > Save to version
   history) and press the action again. The result also carries a `fallback`: each live frame rendered over REST
   and compared by bytes with its stored preview. Report a difference only as **"possible change — please
   confirm"**, never as a verified edit, and **never as "no changes"** when the baseline is unknown (a matching
   render does not verify the baseline either). A versionless success has `versionId: null`; assemble without it.
3. **Failures are typed, never "no change".** `version-not-found` is a 404, never "no change"; `rate-limited` carries
   the retry-after and stops the read-back (no retry loop, no MCP fallback); `frames-missing` means the autosave
   never captured every frame. Say which on the brief and attach nothing.
4. **Use the result.** `lines` are the plain change lines (geometry, style and order are lines only); `questions`
   are decision items: text changes, added or removed frames and swapped instances are a line **and** a question
   (method change, or illustrative only?), repeats collapse into **one** question
   (seven rows edited the same way is one), and anything unclassified is a question, never dropped.
5. **Attach and assemble.** Upload each returned preview with `mcp__harmony__attach_file`, then call
   `assemblePendingArtefact` with the result's `versionId`, `frames`, the uploaded attachment ids and
   `provenanceNotes = markHumanInTool(<your own notes>, changedElementIds)` (your lines stay as they were; the
   designer's per-element marks are `human-in-tool`). It refuses on any compose-rule gap (never fall back to latest).
6. **Recompose the design brief in place** with `compose_brief`, `frame.design_artefact` = the assembled record
   (`compose_brief` probes `design_artefact_capability` and validates the attachments; on a board without the
   capability it refuses with the promote prerequisite, so report that rather than working around it):
   `revision_cause: { source: 'refreshed-inputs', lines: [the reconciled changes] }`;
   `iterate_feedback` = the designer's note **verbatim, only if one was given** (when both are passed `revision_cause`
   wins and the note rides in its `lines`, per `skills/harmony-shared/brief-authoring.md` §Stating the cause of a
   redraft rather than restating it); a **"What changed in Figma"** block; the question items among the decision
   items. That recompose consumes the marker.
7. **Accept pins the version whose previews are on the accepted brief** (`design_artefact.version_id`), never the latest
   at accept time. B-1202's accept path records drift; do not reimplement it. A versionless record has no pin: its
   drift is the content fingerprint taken by the leg that consumes the design accept
   (`harmony design fingerprint take`, stored at `field_values.design_fingerprint`; see the design-decide skill),
   compared later by the plan and build gates (`harmony design fingerprint compare`).

### 4. Iterate — elicit, don't guess (D2)

When the human asks for **alternatives**, **ask them to describe the alternative**, then regenerate the
surface with it (add the option/preset they specified). **Never auto-generate a guessed variant** — the
product intent that distinguishes alternatives (e.g. a comparability strategy) is exactly what cannot be
inferred. Success is a **considered decision**, not a snap accept; give them enough to take it seriously.

### 5. Capture the framed decision (binds to the decision, not the surface)

When the human pastes the copy-out spec, file it through the gate machinery. Record the **framed structural
choice** — not "approved this whole surface" — and **enumerate** the decision-bearing elements by provenance:
**name the invented ones** (e.g. *invented: 5th category "Recognition" — not decided*) so a fabrication can't
ride downstream as if decided (D3 — never just restate the legend). Worked example:

```
const decision = mcp__harmony__record_decision({
  claim: "<one sentence stating what this entry establishes>",
  type: "ux-ui-design",
  title: "<ticket>: UX/UI — onboarding setup-depth = fixed/standard instrument",
  content:
    "Manager first-run onboarding uses a single fixed setup step ('runs every 2 weeks across these 4 "
    + "categories') with a deliberately high-friction 'request a custom setup' path — keeps teams comparable. "
    + "Provenance — real: the 4 instrument categories (configured instrument) + the >=3 anonymity threshold "
    + "(a product rule); invented (NOT decided): none; illustrative: the sample scores. "
    + "Surface: /tmp/harmony-visual/<ticket>-onboarding-setup.html.",
  madr: {
    context: "Manager first-run; cross-team comparability is the driver.",
    decision_drivers: ["Comparable measures across teams/org", "Low first-run friction"],
    considered_options: ["Explicit steps", "Smart defaults (editable)", "Fixed/standard (high-friction change)"],
    decision_outcome: "Fixed/standard instrument; change gated behind friction.",
    consequences: ["Teams stay comparable", "Power users must request a custom setup"],
  },
  domain: ["product", "customer"],
  source_type: "manual",
  source_activity: "design-decide",
  source_task_id: "<task uuid>",
  // B-1000: an agent-authored draft, same reasoning as harmony-clarify's own spec-draft note — append
  // ':<mode>' under harmony-conduct; this is not the accept's own provenance.
  provenance: "agent-synthesized",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

> **B-866 — the entry's prose is DERIVED, not authored here.** `content` above is a **placeholder seat**,
> not the entry's text. The brief's accept promotes `renderEntry(doc)` — a mechanical projection of the
> very `doc` you compose below — so anything you would have written into the entry belongs in the doc
> (`recommend` / `why` / `alternatives` / `context` / `frame`). Do not write the decision out twice, and
> do not hand-author a `knowledge_entry_content` payload item: `compose_brief` derives it, sets its `ref`
> and `entry_id`, and REPLACES anything you author there. See
> `skills/harmony-shared/brief-authoring.md` §"The brief is the only authored copy".

Then compose the brief. Author it per `skills/harmony-shared/brief-authoring.md` §Design — the question,
must-haves, and engagement it owes the human, plus the legibility contract. Consult it; do not restate it. Ticket ids named in the brief's prose follow `skills/harmony-shared/brief-authoring.md` §Ticket identity — never assume the letter `B`.
Set `pending_activity: "designing"` **only if this is the last required sub-track**
(derive exactly as `harmony-design-decide` does — `mcp__harmony__list_ticket_knowledge({ task_id })`, the
Accepted `*-design` types vs the required set); otherwise `null`.

> **One active brief per task (P3 substrate constraint).** The `designing` sub-tracks share a single
> active-brief slot (P3's partial unique index): a second `compose_brief` *updates the active brief in
> place*. So the sub-tracks are **serialized** — only compose the ux-ui brief when no product/technical brief
> is still active, and get it accepted (freeing the slot) before the next. Never compose ux-ui while a
> sibling sub-track's brief is open; you would silently overwrite it. (Same constraint `harmony-design-decide`
> spells out for the Product/Technical tracks — it holds across the delegated ux-ui track too.)

**Also author `doc.payload` with an `entity_link` item (B-997).** Read `field_values.implements_entities`
off `get_task` (it may already be in context from earlier steps) — the array of feature-entity name(s)
clarify's own accept confirmed:
- **Present with one or more names** → one `entity_link` item PER NAME:
  ```
  { write_kind: "entity_link", ref: slugRef("entity", name), entity_name: name, kind: "feature", decision_id: decision.id }
  ```
  Names in `implements_entities` are feature entities, so author `kind: "feature"` (author the kind the
  entity actually is if you link something else). A name-only item for an ambiguous name is refused before any write.
- **Absent entirely** (the PERMANENT state for every ticket already past clarify before B-977 shipped —
  not a transition window that closes) or **present but an empty list** (`names: []` — a legitimate
  "no linkable feature" answer) → author NO `entity_link` item at all. No throw, no warn, no empty-edge write.

```
mcp__harmony__compose_brief({
  task_id,
  reason: "design-decision-draft",
  pending_activity: "designing",   // <- null if a product/technical sub-track is still open (i.e. not the last)
  decision_ref: { type: "ux-ui-design", id: decision.id },
  doc: {
    claim: "<the exact one-sentence claim the human will approve>",
    decide: "Onboarding setup-depth for the team-barometer first-run?",
    recommend: { text: "Fixed/standard instrument with a high-friction custom path", confidence: "medium" },
    why: ["Cross-team comparability needs one shared measure", "Lower first-run friction than explicit steps"],
    alternatives: [{ option: "Smart defaults (editable anytime)", rejection: "Optimises easy change; breaks comparability" }],
    items: [{ kind: "decision", text: "Setup-depth = fixed/standard", recommendation: "fixed/standard" }],
    // one entity_link item per confirmed feature-entity name (B-997, see above) — [] when absent/empty
    payload: [
      { write_kind: "entity_link", ref: "entity-team-barometer", entity_name: "Team Barometer", kind: "feature", decision_id: decision.id }
    ]
  }
})
```

### 6. Resolve

> **Provenance (B-734):** `human-in-session` below is the human deciding *here* — a conduct-loop-synthesized
> accept carries `agent-synthesized:<mode>` through this same path (`skills/harmony-shared/gate-routing.md`
> §Resolution provenance).

- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept", provenance: "human-in-session" })`
  → promotes the decision
  Asserted→Accepted; if it carried `pending_activity: "designing"`, advances Decomposed→Designed. `accept`
  binds to the **framed decision**, not every datum the surface depicted. The response carries
  `pending_acceptance_event_id` — non-null (B-904 extended B-797 to every design sub-track, ux-ui
  included). This is NOT commit-only: the SAME event's payload carries the derived `knowledge_entry_content`
  item (B-866/B-867) plus any `entity_link` item step 5 authored (B-997), neither of which this skill
  materializes on its own. Call `mcp__harmony__consume_pending_acceptance_event({ task_id })` right away,
  in this same turn, so those write kinds actually land.

  **The ticket + decision's implemented-entity edges (B-977) already landed above (B-997).** Step 5's
  `doc.payload` authored one `entity_link` item per confirmed name (three-state handling: present/absent/
  empty — see step 5), and the `consume_pending_acceptance_event` call just above lands them — there is
  nothing further to do here. This replaces what used to be a separate inline `link_ticket_entities` call
  here — that call only ever ran in a same-session accept, so the wiring was measurably inert whenever the
  accept happened over the web with no session running.

  Report whether the ticket is now Designed or still needs other sub-tracks, then return to
  `harmony-design-decide`.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge" — the same
  discipline P4's gate skills follow). Author the deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    claim: "<one sentence stating what this entry establishes>",
    type: "deferral", title: "<ticket>: UX/UI decision deferred — <why>",
    content: "<rationale: what we're not deciding now + when to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["product", "customer"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
    // B-1000: a defer is always human — carries the SAME provenance as the resolve_brief defer below.
    provenance: "human-in-session",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>", provenance: "human-in-session" })
  ```
  **Fallback (F4/B-352):** a defer with no rationale **still parks** — prompt once for the rationale ("what
  should we revisit, and when?"), but if the human declines, skip the `record_decision`/`reference_knowledge`
  and just `resolve_brief({ task_id, command: "defer", provenance: "human-in-session" })`. Never hard-block
  the "not now". (Web `defer` is mechanical-only and never authors this — documented v1 asymmetry.)
- **iterate** → step 4 (regenerate); **expand**/**related** → show the pre-generated sections from `get_brief`.

## Durable design record (B-1202)

Before filing a visual decision, attach its review surface to the ticket. Never file a
container-local path or an expiring screenshot URL as the durable surface. Download and
attach HTML previews as self-contained HTML (download-only, never iframe/embed).

A design frame may carry `design_artefact` with this version-1 contract:

```json
{
  "schema_version": 1,
  "tool": "figma",
  "file_key": "FILEKEY",
  "file_url": "https://www.figma.com/design/FILEKEY",
  "version_id": "VERSION (optional, B-1203: omit for a live-file composition)",
  "nodes": [{"id":"1:2","name":"Screen","caption":"What to review","preview_attachment_id":"UUID","preview_filename":"screen.png"}],
  "composed_at": "2026-10-27T12:00:00Z",
  "provenance_notes": "Rendered with explicit version=VERSION; frames present and downloads checked",
  "mcp_call_count": 0
}
```

For HTML use `tool: "html"`, `surface_attachment_id`, `surface_filename` and the
same schema/composition/provenance/call-count fields; omit Figma fields and nodes.
Use actual same-ticket finalized attachment IDs and filenames. Preserve frame order.
Do not store tokens or signed URLs. The plugin rejects artefact composition until
`design_artefact_capability` on the target board reports `schema_version: 1`.
The B-1202 web migration must be promoted to production first for prod-board workers.

Figma preparation: read the version from REST nodes, check every frame exists at that
explicit version, request PNGs with `version=<id>`, and download/check every result.
`prepareVersionedPreviews` in `src/tools/design-artefact.ts` provides this bounded path
(12 attempts, 10-second intervals, per-request timeouts). A 200 response with null
images is a miss, not proof. That versioned path serves only the reconcile read-back of a record that carries a
`version_id`; **composition renders from the live file** (step 3c.5) and stores no version unless the board
reports `version_optional: true` for a versionless record. Stop with an actionable
failure if frames never appear on the versioned path; never substitute a latest screenshot there.
Upload returned bytes through ordinary `attach_file` and construct the manifest.
REST calls are outside the MCP budget; record the measured MCP call count separately.

The active brief shows a pending revision. Its acceptance payload projects that exact
record into the design gate slot; a no-artefact brief preserves the previous slot.
Acceptance always pins compose-time X. The consuming worker may inject a REST token
through `HARMONY_FIGMA_TOKEN` solely for the latest-version drift read (this module
owns no credential storage). Absent/failed reads explicitly record `unchecked`.
The database freezes the first observation on the event and makes retries no-ops.
A newer version never replaces the attachment manifest or its pin. On the ticket,
both accepted and pending design views link to the file with their pinned version.
