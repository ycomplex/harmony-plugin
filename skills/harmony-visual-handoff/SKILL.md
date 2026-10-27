---
name: harmony-visual-handoff
description: Run a UX/UI design decision through a generated, manipulable surface + an iterate loop (B-328). Triggers on "visual hand-off", "generate a mockup for this decision", "show me the UX options", and is delegated to by harmony-design-decide's --track ux-ui. Routes glanceable decisions to a parametric preview and flows to a walk-through + storyboard; reserves a design tool (Figma) for the irreducibly-generative visual residue. Files the framed decision back as a knowledge entry.
capabilities: harmony-mcp read web write shell:open shell:mkdir
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch Write Bash(open *) Bash(mkdir *)
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

- **unconnected → `html`:** step 3a, today's generated-HTML path, unchanged.
- **connected → `figma`:** this step.
- **failing → `stop`:** stop with the reconnect instruction. **Never silently fall back** to HTML.

Dependencies, not assumptions: the connection reader, the **saved component map** and the shared rate limiter
are **B-1201's**; the stored record, `design_artefact` (schema_version 1), is **B-1202's**. Until B-1201 lands the preflight resolves to
`html`, so this step does not run.

Figma path (planner: `src/tools/figma-composition.ts`):

1. Keep the glanceable-vs-flow routing (step 2) unchanged.
2. Read the **saved component map**; do no per-leg library search.
3. Call `use_figma` **once** to build all option frames from **library instances** (not imported layers),
   named `<ticket> · <option>`, the recommendation marked on exactly one frame, and provenance
   (`real` / `invented` / `illustrative`) as frame notes. A second `use_figma` call only to fix.
4. A flow is N frames in order with a caption each; the order is kept in the planned `nodes` list.
5. MCP is used only for writing (`use_figma`). Render previews over REST `GET /v1/images`, **pinned to the
   file version**, with the workspace token (not `get_screenshot`), download, and attach them. Do not
   render straight after composing. The newest version then is still the pre-compose one: Figma's
   autosave created the next version **79 s** after a compose in the 2026-10-27 live proof, and a render
   pinned to the earlier version returns HTTP 200 with `err: null` and **no image**, not an error. So:
   wait for a version created after the compose (`waitForVersionAfter` with `FRESHNESS_WAIT`, 15 s × 12),
   confirm every composed frame is present in `GET /v1/files/:key/nodes?ids=…&version=<id>` and every
   image URL is non-null, then pin that version. If no version appears within the wait, or a frame is
   missing, say so on the brief and attach no preview. Never attach a render you have not checked.
6. Every MCP call passes through the shared limiter when present. Count MCP calls: **hard cap 6 per leg**
   (typical 2-3). At the cap, stop composing options and say so on the brief. Record the call count
   (`mcp_call_count`) on the brief.
7. **The stored record is B-1202's `design_artefact` (schema_version 1), not yet persisted here.** Its fields
   are `tool`, `composed_at`, `provenance_notes`, `mcp_call_count`, and an ordered `nodes` list of
   `{ id, name, caption, preview_attachment_id, preview_filename }`; for Figma only, also `file_key`,
   `file_url` and `version_id`. It holds **no signed URLs**. Until B-1202's capability exists, this path
   attaches the checked previews and lists them on the brief, and does **not** persist a `design_artefact`.
   Do not invent a frame field or a slot schema.
8. A Claude Design scaffold or any inception sketch is **reference only**: the recorded artefact is always
   re-composed from library instances.

Then continue at step 4.

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
  { write_kind: "entity_link", ref: slugRef("entity", name), entity_name: name, decision_id: decision.id }
  ```
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
      { write_kind: "entity_link", ref: "entity-team-barometer", entity_name: "Team Barometer", decision_id: decision.id }
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
