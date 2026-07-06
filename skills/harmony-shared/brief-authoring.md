# Brief authoring — what every brief owes the human

The single source of truth (B-660) for what each gate's brief must contain and how it must
read. Gate skills point here from their compose steps; `compose_brief`'s tool description
carries only the essence. Never copy this contract into a skill — pointers only, so the
contract cannot drift.

Vocabulary: states run Proposed → Clarified → Decomposed → Designed → Planned → Built →
Deployed → Verified; gate names stay clarify / decompose / design / plan / release / verify.

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

**The question.** Is this the right approach for this sub-track?

**The must-haves.**
- The choices, and why.
- The **spillover**: which choices reach beyond this ticket into the app, and how far. For a
  reviewer who isn't in the code, this is the highest-signal element of the brief.
- The real alternatives, and why each lost.
- De-risk-by-running evidence for the load-bearing bets, presented as a confidence signal
  under the recommendation.

**The engagement.** High.

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
