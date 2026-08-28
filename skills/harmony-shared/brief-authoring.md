# Brief authoring — what every brief owes the human

The single source of truth (B-660) for what each gate's brief must contain and how it must
read. Gate skills point here from their compose steps; `compose_brief`'s tool description
carries only the essence. Never copy this contract into a skill — pointers only, so the
contract cannot drift.

Vocabulary: states run Proposed → Clarified → Decomposed → Designed → Planned → Built →
Deployed → Verified; gate names stay clarify / decompose / design / plan / release / verify.

## Ticket identity — never assume the letter B

When a brief's prose names the ticket it's about, use that ticket's own visual id
verbatim — the string this run was invoked with, or
`${get_project().key}-${task.task_number}` if reconstructing. Third-party deployments
key their tickets on a project-specific letter (e.g. `TH-10`, not `B-10`) — never assume
the letter `B`.

This applies to every rendered worked example, template, or status line a gate skill
teaches, not just the live `compose_brief`/`record_decision` call: an agent
pattern-matching a literal `B-123`-style worked example keeps the literal letter `B`
even when the real ticket is `TH-10`. Gate skills teach the pattern with a generic
`<ticket>` placeholder for exactly this reason — never another concrete-looking numbered
example.

## Shared core (every brief)

Every brief, at every gate:

- **Opens with DECIDE** — the one question this brief asks the human.
- **Carries a recommendation with explicit confidence.** When the call is genuinely the
  human's — a values call — cede it explicitly rather than fake a recommendation.
- **Says why** — the reasoning that lets the human judge the recommendation instead of merely
  trusting it.
- **Sorts its items** into exactly one kind: a *decision* (always recommended), a
  *content-input* (only the human can supply it), or a *derived-constraint* (already fixed
  elsewhere — it belongs in Context, never as an ask).
- **Is the summary — depth lives in the linked decision entry.** The render emits this pointer
  automatically whenever the brief carries a `decision_ref` (B-674), so do not hand-write it; a
  brief with no `decision_ref` correctly shows no pointer. The clickable brief→entry navigation
  is still deferred (that surface is B-669).

## Legibility contract

Write for the human who wasn't in the room. Optimize for the one-scan read.

1. **One idea per sentence.** Short sentences. Five clauses means five sentences.
2. **No stacked or nested parentheticals** — never an aside inside an aside.
3. **Spell out jargon and internal IDs** unless the reader introduced them. "The B-482
   reconciliation guard" means nothing to someone who never saw B-482 — say what it does.
4. **The recommendation is a prose paragraph**, not a clause-chain.
5. **Spend the word budget on clarity, never density.**
6. **The brief is the summary**; depth lives in the linked decision entry. The render emits
   this pointer automatically whenever the brief carries a `decision_ref` (B-674) — do not
   hand-write it.

## Engagement model

Two axes set how much prose a brief owes the human, and they diverge:

- **Cost-if-wrong** — how reversible the decision is.
- **Review-value** — whether the human's judgment is the point of the gate.

**High-engagement** (rich, human-facing): **Clarify** (cheap to redo but foundational —
engage hard), **Design**, **Release**, **Verify**.

**Lead-by-system** (terse; the system runs it and the human trusts it): **Plan** — the
only one.

"Not reviewed" cuts the prose the human reads. It must never cut the guards enforced
underneath — de-risk-by-running and verify-the-base stay system requirements whether or not
a human reads the brief.

## The altitude contract

Each gate's brief is written at the **altitude of the decision it ratifies**, not at the altitude of
the work that produced it. A build-shaped brief at a product gate asks the human to ratify something
they were never asked to judge.

- **Clarify** — product altitude: what becomes true for the user.
- **Design** — per track: product altitude on the product track, architect altitude on the technical
  track, the generated surface itself on UX/UI.
- **Plan** — legitimately low. It is the one lead-by-system gate; concrete and terse is correct here.
- **Release** — operational altitude: environments, ordering, and what is irreversible.
- **Verify** — product altitude: observed behaviour, walked by the human.

**The operative test: the reader must be able to judge the brief without the repo open.** A brief
that needs file names, function names, or knowledge of the current code structure to evaluate has
FAILED the test — whatever vocabulary it used. Passing is not a matter of avoiding technical words.
It is a matter of the human being able to say yes or no from what the brief itself tells them.

**Guard against vagueness-laundering.** Altitude governs the OUTCOME prose — the decision, the
recommendation, the reasoning. It never licenses vagueness anywhere else. Scope lists, the items, and
what is in and out stay concrete, and may be technical. "Raise the altitude" never means "say less".

## Two authoring rules

**Solving-as-outcome.** The problem statement says what BECOMES TRUE when this ticket is done. It is
never a restatement of the ticket title, and never a mechanism. "Triage restarts from scratch because
a filter set is lost on every reload" is an outcome; "Implement saved filters" is the title handed
back; "Add a saved_filters table" is a mechanism wearing the problem's clothes.

**No implementation details at design.** A design brief names the approach and its consequences —
what changes about how the system behaves, what that reaches into, what it forecloses. It does not
name files, functions, or line numbers. Those belong to plan and to the code review; at design they
are noise the human cannot judge.

## Per-gate contracts

### Clarify (Proposed → Clarified — high-engagement)

**The question.** Did we capture what you actually want — the right problem, the right
boundaries?

**The must-haves.**
- The problem this ticket will solve, as a sharp standalone statement. This intent statement
  is the centerpiece of the brief.
- The proposed happy-path acceptance criteria (accept files them).
- Explicit out-of-scope.
- Any real ambiguity that survived elicitation, surfaced as an open call.

**The engagement.** High. Clarify is cheap to redo, but everything downstream builds on it —
engage hard.

### Decompose (Clarified → Decomposed — medium)

**The question.** Split or keep whole? If split, is the breakdown complete?

**The must-haves.**
- The split/no-split call, and why this cut and not another.
- The elements.
- A coverage check: the pieces cover the whole, with no gaps and no overlaps.
- If atomic: why.

**AC discipline at a split.** Integration-level acceptance criteria stay on the umbrella;
child slices are flagged for each child's own clarify to pick up. Nothing auto-migrates —
each child's clarify originates its own ACs, and the umbrella keeps its ACs by construction.

**The engagement.** Medium.

### Design (Decomposed → Designed, per sub-track — high-engagement)

Design runs **per sub-track**, and the three tracks do not owe the same brief.

**What all three owe.** The shared core; the choices and why; the real alternatives and why each
lost; and the **spillover** — which choices reach beyond this ticket into the app, and how far. For a
reviewer who isn't in the code, spillover is the highest-signal element of any design brief. What
differs per track is the question it answers and the altitude it answers at.

#### Design — product sub-track

**The question.** Is this the right BEHAVIOUR?

**The must-haves.**
- The behaviour spec: what the user can now do, and what the system does in response.
- The acceptance criteria this design **adds or sharpens** over clarify's happy-path set — edge
  cases, error paths, and non-functional criteria are design's to add.
- The alternatives as behaviours, and why each lost.
- The spillover in product terms: which other surfaces this behaviour changes.

**The engagement.** High, at **product altitude** — judgeable with no repo open.

#### Design — technical sub-track

**The question.** Is this the right APPROACH?

**The must-haves.**
- The approach, named, with its consequences — never file names, function names, or line numbers
  (see "No implementation details at design" above).
- The **spillover**: which choices reach beyond this ticket into the app, and how far.
- The real alternatives, and why each lost.
- De-risk-by-running evidence for the load-bearing bets, presented as a confidence signal
  under the recommendation.

**The engagement.** High, at **architect altitude** — the shape of the system, not the diff.

#### Design — UX/UI sub-track

**The question.** Is this the right SURFACE?

**The must-haves.**
- **The generated surface itself.** This track routes through `harmony-visual-handoff`, so its brief
  is never prose-only: the human judges the artefact, and the prose says what to look at and what to
  judge it against.
- What the surface commits to: the interaction, the states it must cover, the patterns it reuses or
  breaks.
- The alternatives as surfaces, and why each lost.
- The spillover: which existing screens inherit this pattern once it lands.

**The engagement.** High, judged **against the surface** — never against a description of it.

### Plan (Designed → Planned — lead-by-system, terse)

**The question.** Is the plan sound and safe to build from?

**The must-haves.**
- The plan in brief.
- A one-line attestation: de-risked by running / base verified.

**The engagement.** Lead-by-system — the only terse brief. The disciplines behind the
attestation stay enforced underneath as system requirements; terse prose never waives them.

### Release (Built → Deployed — HARD FLOOR, high-engagement)

**The question.** Ship it? Merge + deploy is one-way — this decision is irreversible.

**The headline must-haves.**
- The deployment's **risk** — the path-based signal computed from the changed paths, never
  prose-detector output.
- **Why to trust it** — what tests were added, what was run.
- **The executed act** — what merging actually DOES: which repo(s), which pull request, that it
  lands on **staging**, and that production is a separate, deliberate `promote-prod` step this
  accept does not perform. Say "to staging", never "to production".
- **The unproven residue** — what the build did NOT prove, named honestly. Silence reads as "all
  covered", which is a claim the build did not make.
- **The mechanical evidence line** — from `get_build_evidence_status`, carried verbatim. It is the
  machine's account of the ACs checked, the test cases recorded, and the pushed PR; never a prose
  paraphrase of it, and never a stand-in for the residue above.

**The footer** (hygiene, demoted below the headline):
- The drained follow-ups rollup, for the human to veto.
- Any other ticket this run also closed.
- Staging-vs-prod.

The footer is kept because dropping it lets deferred work rot; it is demoted because it is
not what the human scans for at the ship decision.

**The engagement.** High — the hard floor.

### Verify (Deployed → Verified — HARD FLOOR, high-engagement)

**The question.** Does real-world behavior match what we intended?

**The must-haves.** The brief is the human's **verification runbook**, built from the
ticket's acceptance criteria:
- Hand-checkable ACs become do-X → expect-Y steps the human walks to confirm reality.
- Non-hand-checkable ACs are stated honestly ("this can't be hand-verified"), backed by what
  the agent ran and a query or command the human can run themselves.
- The build-evidence line sits underneath as supporting confidence — it is NOT the thing
  being acked.

The runbook is memory-free: the human confirms reality, not the agent's claim.

**An umbrella is not a different mode.** Its ACs are integration-level — do the assembled
pieces work together — so its runbook is that integration check. The mechanical roll-up (all
children Verified) is the precondition, never the verify itself.

**Guard.** Verify-convenience must never restrict which ACs clarify authors.

**The engagement.** High — the hard floor.

## Auxiliary briefs

The stale-patch-review, revise-scope-review, and umbrella verification-ack briefs inherit the
shared core and the legibility contract above. Their gate-specific question and must-haves
stay in their owning skills (`harmony-stale-patch`, `harmony-revise-scope`, `finish-work`).
