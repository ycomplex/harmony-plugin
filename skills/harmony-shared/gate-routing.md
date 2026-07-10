# Gate routing — the canonical gate→owning-skill map (single source of truth)

The one place that records **which skill owns each lifecycle gate, whether its accept is pure or
side-effecting, and where the hard floor sits**. Both `harmony-next` and `harmony-conduct` consume this
table — `harmony-next` keyed by `awaiting_human_reason` (it is resolving an existing brief),
`harmony-conduct` keyed by `workflow_state` (it is walking the forward path). They are two **projections of
one model**; the model lives here, never hand-copied into either skill (that copy is exactly the B-526
drift hazard this file removes).

> Edit routing **here**. Each consuming skill keeps only its own *handling* (how it acts on this table);
> the routing *facts* are not restated in the skills.

## The canonical gate table

| gate | from `workflow_state` | brief `awaiting_human_reason` | owning skill | accept is… | hard floor |
|---|---|---|---|---|---|
| clarify | Proposed | `clarification-draft` | `harmony-clarify` | **side-effecting** (accept files the clarify-authored happy-path ACs first — `manage_acceptance_criteria`, idempotent — then `resolve_brief`; B-648) | no |
| decompose | Clarified | `decomposition-proposal` | `harmony-decompose` | **side-effecting** (accept creates children first) | no |
| design | Decomposed | `design-decision-draft` | `harmony-design-decide --track <sub-track>` | **pure** (per sub-track; serialized) | no |
| plan | Designed | `plan-draft` | `start-work` | **pure** (accept = `resolve_brief`; the "go" to build) | no |
| build | Planned | (files `release-decision-pending`) | `start-work` | build work, then files the release brief | no |
| **release** | Built | `release-decision-pending` | `finish-work` | **side-effecting** (accept → merge + deploy) | **YES — always human** |
| **verify** | Deployed | `verification-ack-pending` | `finish-work` (verify step) | **side-effecting** (observe prod); also the PR-less umbrella path | **YES — always human** |

Terminal states (`Verified`, `Parked`, `Cancelled`) have no gate — they end the lifecycle.

**Pure vs side-effecting (the inline-vs-delegate fact).** `resolve_brief` does exactly three things on
accept — promote the referenced decision, advance state via `pending_activity`, clear the flag. For the
**pure** gates (`design-decision-draft`, `plan-draft`) that is the whole accept, so a
caller may resolve inline. For the **side-effecting** gates the real work lives **outside** `resolve_brief`
(`clarification-draft` files the happy-path ACs — B-648, `decomposition-proposal` creates children,
`release-decision-pending` merges + deploys,
`verification-ack-pending` observes production), so accept must be **delegated** to the owning skill, which
performs the work in the correct order.

**The hard floor.** The **release** and **verify** gates are one-way / irreversible and **always require a
human** — never auto-resolved, under any flag or dial.

**Evidence-landing side-effect (B-560).** The **build**, **release**, and **verify** gates each LAND build
evidence on the ticket as part of their accept side-effects, so a conducted ticket reaches Verified with a
legible build trail (gates otherwise only advance `workflow_state`): **build** records test cases + checks
the satisfied ACs (`start-work` O3), **release** comments the PR→merge→deploy trail, and **verify** comments
the verify result AND its brief always carries a mechanical evidence-status line from
`get_build_evidence_status` (`finish-work` O2/O3). A split-umbrella roll-up is **exempt** — its evidence is
carried by its children. A **decision-only ticket is likewise exempt** (B-681) — its evidence IS the
Accepted decision knowledge (`exempt_reason: 'decision-only'`).

## The decision-only fast-forward (B-681)

A ticket carrying the **`decision-only` label** finishes its deliverable at an early gate and has nothing
to plan/build/deploy — so it completes at that **deliverable gate** instead of walking the build gates
empty or stalling:

| ticket kind | deliverable gate | fast-forward edge |
|---|---|---|
| capture-only (e.g. an inception proposition-root) | **clarify** | Clarified → Verified |
| decision ticket (decision Accepted at design) | **design** (last required sub-track) | Designed → Verified |

- **One accept, two writes.** The deliverable-gate brief of a marker-carrying ticket **must carry an
  explicit completion line** — *"accepting this completes the ticket to Verified; nothing is built, the
  decision's realization stays `agreed`"* — and the human's single accept authorizes both. On accept the
  owning gate skill resolves the brief normally, then runs the trailing
  `advance_workflow({ activity: 'fast-forwarding' })` as the mechanical completion. Never silent, never a
  second ceremony.
- **Hard floor.** The deliverable gate of a decision-only ticket is its release+verify **collapsed into
  one**, so it inherits the hard floor: **never auto-advanced under any delegation flag** (`--pause-at` /
  `--unattended` / `--escalate`). No ticket reaches Verified without a human decision in the loop.
- **Until the deliverable gate the marker changes nothing** — a decision ticket still clarifies and
  decomposes normally; only the gates PAST the deliverable are skipped.
- **Realization stays `agreed`.** The fast-forward never touches realization; the produced decision reads
  agreed-not-built until its build work flips it live (B-677).
- **Marker consumed, not governed.** Who/what stamps `decision-only` (and its guardrails) is B-688's
  scope; this table only keys on the label's presence.

Both consumers inherit this branch from here: `harmony-conduct` at the deliverable gate of its forward
walk, `harmony-next` when resolving the deliverable gate's brief.

## Human-facing vocabulary (B-446)

When pointing a human forward, name the **release gate** and the **verify gate** by those gate names;
`finish-work` is the *skill that implements* them. Prefer "run the release gate
(`/harmony-plugin:finish-work`)" over naming the bare skill, so the human-facing vocabulary matches the
lifecycle rather than the implementation.

## Off-forward-path rows

| condition | owning step / skill | note |
|---|---|---|
| `Captured` → proposing | (none — `advance_workflow`) | brief-less plumbing (Captured→Proposed). **Handling differs by skill:** `harmony-conduct` auto-advances it; `harmony-next` surfaces it as a human triage decision. |
| `stale` ticket | `harmony-stale-patch` | a superseded decision put the ticket out of sync — drafts a `stale-patch-review` brief; never on the forward path, never auto-advanced. |

The **proposing** row is the canonical example of *"same routing, opposite handling, by design"* (B-490):
the owning step is shared, but each skill's *handling* of it is deliberately different — and that handling
lives in the skill, not here.

## Split ownership — which gate may split a ticket, on what axis (B-518)

Two gates can spin work out of a ticket. They split on **different axes**, and the axis is the
contract (Accepted: B-550 `5d33aba5`, delivered by B-518):

- **Clarify splits only on complexity of PRODUCT INTENT** — a now-vs-later bundle. The phase-split
  probe (a question type within clarify's elicitation rounds) asks the human which part is in
  immediate scope; the human's explicit **"later"** answer (or an explicit choice on the clarification
  brief) **de-scopes** that phase — re-ticketed out of immediate scope at the brief's accept. Clarify
  NEVER splits because work is big or technically composite, and a de-scope is **never initiated from
  agent inference alone** — it executes only downstream of the human's explicit answer.
- **Decompose owns complexity/STRUCTURE splitting** — breaking in-scope work into manageable,
  independently-shippable children (the manageability rule). Whether in-scope work becomes one ticket
  or several is decompose's call, not clarify's.

Why this line: children inherit the parent's clarification (state-machine §8.1) and each
decompose-created child re-clarifies narrowly from its own Proposed state — so the intended flow is one
broad parent clarification → decompose splits → children re-clarify. A clarify-side complexity split
pre-empts that design and produces premature splits before the design is understood.
