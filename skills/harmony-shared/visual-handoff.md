# Visual hand-off discipline (B-328)

How to run a UX/UI design decision through a **generated, manipulable surface + an iterate loop** —
the v1 default for UX/UI structural decisions, *including flows*. Source: the B-328 spike retro
(`docs/next-gen-harmony/2026-05-29-visual-handoff-spike-retro.md`, decisions D1–D3). Any skill that
hands a visual decision to a human follows this; `harmony-visual-handoff` is its first user.

## D1 — Routing: which surface, and when a design tool instead

The axis is **not** "bounded vs. open-ended". The diagnostic the agent asks is:

> **Is the decision-relevant property glanceable in a rendered frame, or only knowable by
> traversing/experiencing it?**

Scale the surface to the answer:

| Decision shape | Surface |
|---|---|
| **Glanceable in one frame** (layout, component, dashboard, density, copy-on-a-screen) | A **live parametric preview** — controls on one side, the consequence rendered instantly on the other. |
| **Sequence / flow** (onboarding, multi-step setup, a wizard's arc) | A **walk-through** (clickable, conveys the experience) **and** a **storyboard** (a glanceable filmstrip), plus the iterate loop. |

**Try the generated surface + iterate *first*, even for a flow** — B-328's onboarding flow stayed on the
generated path; the designer did not need Figma. Route to a **design tool (Figma/Pencil) only for the
irreducibly-generative visual residue**: visual **identity**, brand, **motion**/transition feel, **novel
visual language**, high-fidelity craft (the part a design system fills). **Not whole flows.**

## D2 — The iterate loop: elicit, don't guess

The iterate loop is **first-class** — it is what makes a generated surface sufficient for harder decisions,
not a fallback.

- **Elicit, don't guess.** When the reviewer says "show me alternatives", **ask them to describe the
  alternative**, then regenerate the surface with it. **Never auto-generate a guessed variant** — in B-328 a
  guessed alternative was useless *and backwards* (it encoded the opposite product intent). The information
  the loop needs — comparability strategy, product intent — is exactly what the agent cannot infer.
- **`accept` binds to the *framed decision*, not the whole artefact.** Record "flow structure = X" /
  "layout = Y" — **not** "approved this surface and every datum/state it depicts". This stops scope-bounded
  silence and correct-but-misplaced deference from laundering into approval.
- **Success is a *considered decision*, not a snap one.** A substantive UX/UI gate legitimately means "decide
  deliberately"; a snap-accept is the worrying rubber-stamp signal, not a win. Judge the hand-off on whether
  it gave the reviewer enough to take the decision **seriously** — not on how fast they clicked accept.

## D3 — Fidelity / trust guard-rails (two tiers)

1. **Blanket framing (tier 1).** Every surface shows a togglable banner: *"Generated sketch — numbers and
   content are illustrative placeholders, not real data; review the structure and substance, not the
   figures."* It lowers the reviewer's fidelity tax (visual jank **and** placeholder data).
2. **Element-level provenance (tier 2).** Mark every decision-bearing element **real vs. invented vs.
   illustrative**: *these categories = your configured instrument* (**real**); *this 5th category =
   placeholder, decide it* (**invented**); *these numbers = sample* (**illustrative**). The banner cannot
   carry this — the surface must. This is the specific mitigation for *deference-laundering*: a plausible
   fabrication that a good reviewer correctly defers to as "a decision made elsewhere".
   - **Carry the provenance into the *captured* decision — enumerate, don't generalise.** The copy-out spec
     and `record_decision.content` must **enumerate the specific invented/illustrative decision-bearing
     elements** (e.g. *invented: 5th category "Recognition" — not decided*), not merely restate the legend. A
     generic "some elements are placeholders" satisfies "has provenance" but a *specific* fabrication is what
     rides downstream — naming it is the only thing that stops it (B-328 §Test-2 #2: the invented "Recognition"
     category a good reviewer correctly deferred to).
   - **Keep tier-2 marks always visible** — *not* gated behind the sketch banner. Deference-laundering
     survives **normal** review, so the marks must show in normal review; the `g`/`#sketch` toggle controls
     only the tier-1 banner. (Mild fidelity cost — accepted: a well-authored surface marks few elements.)

**Generation hygiene.** Use **realistic, internally-consistent** placeholder data (self-contradictory data
*impedes* judgment — the reviewer would rather see realistic figures). **Do not fabricate** plausible
decision-bearing content — a category, a threshold, a policy — **without labelling** it `invented`. That is
the one thing that survives a careful review and propagates a hallucination downstream.

## What B-328 did *not* validate (carry these as caveats)

- The **design-tool side** of D1 (identity / motion / novel visual language → a tool) was asserted from the
  construction probe, **not** run with a reviewer. Keep the Figma path minimal (pass-through + capture link).
- **Element-level provenance** (tier 2) was proposed from the failure, not yet built or tested — `harmony-
  visual-handoff` builds it; its efficacy is validated by the acceptance walk, not assumed.
- **Programmatic capture-back** was not exercised — only copy-paste of the framed-decision spec. v1 uses the
  copy-out `<pre>`; programmatic ingestion is deferred.
- **n = 1** designer / one product. The disciplines are encoded; behavioural validation is the acceptance walk.

## References

- B-328 spike retro · gate-ui-conductor §5–§6 · stocktake §9.1 · brief disciplines gate-ui-conductor §3.2.
