---
name: harmony-visual-handoff
description: Run a UX/UI design decision through a generated, manipulable surface + an iterate loop (B-328). Triggers on "visual hand-off", "generate a mockup for this decision", "show me the UX options", and is delegated to by harmony-design-decide's --track ux-ui. Routes glanceable decisions to a parametric preview and flows to a walk-through + storyboard; reserves a design tool (Figma) for the irreducibly-generative visual residue. Files the framed decision back as a knowledge entry.
allowed-tools: mcp__harmony__* Read Grep Glob WebSearch WebFetch Write Bash(open *) Bash(mkdir *)
disallowed-tools: Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

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
hand-off, gate-ui-conductor §4.2/§4.6) with the design-system context, and capture the returned link. (B-328
did not validate this side — keep it a thin pass-through.)

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
  type: "ux-ui-design",
  title: "B-412: UX/UI — onboarding setup-depth = fixed/standard instrument",
  content:
    "Manager first-run onboarding uses a single fixed setup step ('runs every 2 weeks across these 4 "
    + "categories') with a deliberately high-friction 'request a custom setup' path — keeps teams comparable. "
    + "Provenance — real: the 4 instrument categories (configured instrument) + the >=3 anonymity threshold "
    + "(a product rule); invented (NOT decided): none; illustrative: the sample scores. "
    + "Surface: /tmp/harmony-visual/B-412-onboarding-setup.html.",
  madr: {
    context: "Manager first-run; cross-team comparability is the driver.",
    drivers: ["Comparable measures across teams/org", "Low first-run friction"],
    options: ["Explicit steps", "Smart defaults (editable)", "Fixed/standard (high-friction change)"],
    outcome: "Fixed/standard instrument; change gated behind friction.",
    consequences: ["Teams stay comparable", "Power users must request a custom setup"],
  },
  domain: ["product", "customer"],
  source_type: "manual",
  source_activity: "design-decide",
  source_task_id: "<task uuid>",
})
mcp__harmony__reference_knowledge({ task_id, decision_id: decision.id })
```

Then compose the brief. Set `pending_activity: "designing"` **only if this is the last required sub-track**
(derive exactly as `harmony-design-decide` does — `mcp__harmony__list_ticket_knowledge({ task_id })`, the
Accepted `*-design` types vs the required set); otherwise `null`.

> **One active brief per task (P3 substrate constraint).** The `designing` sub-tracks share a single
> active-brief slot (P3's partial unique index): a second `compose_brief` *updates the active brief in
> place*. So the sub-tracks are **serialized** — only compose the ux-ui brief when no product/technical brief
> is still active, and get it accepted (freeing the slot) before the next. Never compose ux-ui while a
> sibling sub-track's brief is open; you would silently overwrite it. (Same constraint `harmony-design-decide`
> spells out for the Product/Technical tracks — it holds across the delegated ux-ui track too.)

```
mcp__harmony__compose_brief({
  task_id,
  reason: "design-decision-draft",
  pending_activity: "designing",   // <- null if a product/technical sub-track is still open (i.e. not the last)
  decision_ref: { type: "ux-ui-design", id: decision.id },
  doc: {
    decide: "Onboarding setup-depth for the team-barometer first-run?",
    recommend: { text: "Fixed/standard instrument with a high-friction custom path", confidence: "medium" },
    why: ["Cross-team comparability needs one shared measure", "Lower first-run friction than explicit steps"],
    alternatives: [{ option: "Smart defaults (editable anytime)", rejection: "Optimises easy change; breaks comparability" }],
    items: [{ kind: "decision", text: "Setup-depth = fixed/standard", recommendation: "fixed/standard" }],
  }
})
```

### 6. Resolve

- **accept** → `mcp__harmony__resolve_brief({ task_id, command: "accept" })` → promotes the decision
  Asserted→Accepted; if it carried `pending_activity: "designing"`, advances Decomposed→Designed. `accept`
  binds to the **framed decision**, not every datum the surface depicted. Report whether the ticket is now
  Designed or still needs other sub-tracks, then return to `harmony-design-decide`.
- **defer** → **deferral is knowledge** (knowledge-discipline.md §"Deferral is knowledge" — the same
  discipline P4's gate skills follow). Author the deferral, then park:
  ```
  const deferral = mcp__harmony__record_decision({
    type: "deferral", title: "<ticket>: UX/UI decision deferred — <why>",
    content: "<rationale: what we're not deciding now + when to revisit>",
    review_by: "<watch/revisit date, ISO>", domain: ["product", "customer"],
    source_type: "manual", source_activity: "defer", source_task_id: "<task uuid>",
  })
  mcp__harmony__reference_knowledge({ task_id, decision_id: deferral.id })
  mcp__harmony__resolve_brief({ task_id, command: "defer", detail: "<why>" })
  ```
  **Fallback (F4/B-352):** a defer with no rationale **still parks** — prompt once for the rationale ("what
  should we revisit, and when?"), but if the human declines, skip the `record_decision`/`reference_knowledge`
  and just `resolve_brief({ task_id, command: "defer" })`. Never hard-block the "not now". (Web `defer` is
  mechanical-only and never authors this — documented v1 asymmetry.)
- **iterate** → step 4 (regenerate); **expand**/**related** → show pre-generated sections.
