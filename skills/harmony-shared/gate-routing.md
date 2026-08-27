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
| design | Decomposed | `design-decision-draft` | `harmony-design-decide --track <sub-track>` | **side-effecting** (per sub-track; serialized. The product track's accept WRITES acceptance criteria — the B-744 filing-pass self-heal plus its own refine/extend edits — so it must be routed to the gate skill's accept path, never resolved inline; B-747) | no |
| plan | Designed | `plan-draft` | `start-work` | **pure** (accept = `resolve_brief`; the "go" to build) | no |
| build | Planned | (files `release-decision-pending`) | `start-work` | build work, then files the release brief | no |
| **release** | Built | `release-decision-pending` | `finish-work` | **side-effecting** (accept → merge + deploy) | **YES — always human** |
| **verify** | Deployed | `verification-ack-pending` | `finish-work` (verify step) | **side-effecting** (observe prod); also the PR-less umbrella path | **YES — always human** |

Terminal states (`Verified`, `Parked`, `Cancelled`) have no gate — they end the lifecycle.

**B-797 — accept is now a CONSUMED EVENT for the four agent-owned-payload gates, not a synchronous write.**
For `clarification-draft`, `decomposition-proposal`, `plan-draft`, and `design-decision-draft` **on the
product track only** (discriminated by `decision_ref->>'type' = 'product-design'` at the DB, never by the
reason string — the technical/ux-ui sub-tracks stay synchronous), `resolve_brief`'s accept no longer
applies the state advance immediately: it snapshots the brief's payload into a `pending_acceptance_events`
row and DEFERS the advance to `consume_acceptance_event`. Every OTHER gate (release, verify, deny/park,
promote, milestone moves, human AC ticks, comments, manual mode) is completely unchanged — direct/
synchronous writes, no event. Two consume paths close the loop:
- **Same session** (the common case): the owning skill does its own materialization exactly as before
  (clarify files ACs, decompose mints children, design writes its AC refinements, start-work materializes
  the plan checklist), then calls `consume_acceptance_event({ event_id })` directly using the id
  `resolve_brief` returned — see each skill's accept step.
- **Cross session** (a web accept with no session running — the specimen class this ticket exists to
  close): `harmony-conduct`'s leg-start-consume step (§1c) calls `consume_pending_acceptance_event`
  BEFORE any gate routing/floor runs. It feature-detects the substrate (never by plugin version) and
  degrades silently to today's behavior when absent.

**Pure vs side-effecting (the inline-vs-delegate fact).** `resolve_brief` does exactly three things on
accept — promote the referenced decision, advance state via `pending_activity`, clear the flag. For the
**pure** gate (`plan-draft`) that is the whole accept, so a
caller may resolve inline. For the **side-effecting** gates the real work lives **outside** `resolve_brief`
(`clarification-draft` files the happy-path ACs — B-648, `decomposition-proposal` creates children,
`design-decision-draft` writes acceptance criteria on the product sub-track — B-744's filing-pass
self-heal plus refine/extend, B-747, `release-decision-pending` merges + deploys,
`verification-ack-pending` observes production), so accept must be **delegated** to the owning skill, which
performs the work in the correct order.

> **See also `ac-pickup-points.md`** — the enumeration of every point at which a clarified ticket can be
> picked up with its acceptance criteria still unfiled, and which mechanism covers each. Keep it current
> when adding a gate or a consume path.

> **`design-decision-draft` was listed as pure until B-747, and that was the bug.** B-648 moved the
> product track's acceptance-criteria writes into its accept but left this row saying *pure*, so a caller
> that resolved inline — the conductor's browser-accept consume path did exactly that — advanced the
> sub-track and dropped the criteria. A row that says "pure" is a licence to resolve inline; keep this
> column honest or the licence is wrong.

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

## Resolution provenance — every accept declares how it arrived (B-734)

Every `resolve_brief` call declares **`provenance`** — how this resolution arrived. It is **required**: the
`brief_resolved` entry the resolution records is attributed from it, and an absent or unrecognised
declaration is stored unattributed and is **never read as a human decision**. Consumers read the entry,
never the absence of one — "there is no brief, so a human must have accepted" is exactly the inference
B-734 removes (`finish-work` O1 is the first consumer re-keyed onto the entry; a B-697 worker was right to
refuse an irreversible merge justified only by that absence).

| how the resolution arrived | `provenance` |
|---|---|
| the human's accept/defer given in the **running session** — every gate skill's normal accept path | `human-in-session` |
| **`harmony-conduct` §4b** synthesized the accept under a delegation mode | `agent-synthesized:<mode>` — `<mode>` is the run's effective mode: `unattended`, `escalate`, or `pause-at` — **or `override`** (B-773) when the per-gate `auto_approve_gates` selection (`harmony-conduct`'s delegation-test step 2a), not the ambient mode, is what made THIS gate auto-advance-eligible — declared even when the ambient mode is `controlled` (see `harmony-conduct` §4b's own "`<mode>` is `override`" paragraph) |
| the human clicked Accept/Deny in the **web** | `human-in-browser` — **the web's alone**; the plugin is never the browser, so its `resolve_brief` REJECTS this value |

**One call site, two provenances.** §4b routes a delegated gate through the owning gate skill's *own* accept
path — that is what preserves the side effects and the Accepted knowledge — so the same `resolve_brief` call
serves both: it declares `human-in-session` when the human decided, and carries `agent-synthesized:<mode>`
through when the conductor did. The conductor synthesizes the accept using the founder's token, so an
undeclared auto-advance would be recorded as a decision the founder personally made.

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
- **Marker consumed, not governed — but now RATIFIED (B-688).** Three producers may stamp `decision-only`:
  **inception's own S1/S2 stamping** (direct, at mint time), **clarify-proposed** (a `label_add` payload
  item clarify authors when it judges a ticket capture-only, applied on the human's brief accept — see
  `skills/harmony-clarify/SKILL.md` step 4/5), and **manual** (the label editor). Every producer is gated
  by the SAME DB authority, `can_mark_decision_only`: `terminal` (Verified/Cancelled/Parked) hard-blocks;
  `build-shape` (Planned-or-later, or a linked build PR) redirects to revise-scope. This table still only
  keys on the label's presence, regardless of which producer stamped it.

Both consumers inherit this branch from here: `harmony-conduct` at the deliverable gate of its forward
walk, `harmony-next` when resolving the deliverable gate's brief.

## Human-facing vocabulary (B-446)

When pointing a human forward, name the **release gate** and the **verify gate** by those gate names;
`finish-work` is the *skill that implements* them. Prefer "run the release gate
(`/harmony-plugin:finish-work`)" over naming the bare skill, so the human-facing vocabulary matches the
lifecycle rather than the implementation.

## Reopen to a target gate (B-762)

**Vocabulary: every reopen instruction names a target GATE, never a raw `revising-*` activity.** A human or
agent that wants to send a ticket back to an earlier gate says "reopen to build" / "back up to design" —
gate names, not `revising-building` / `revising-decomposing`. B-744 and B-733 are two real incidents where
the same ambiguous `revising-building` instruction produced opposite worker behavior (one worker stopped
one hop short and then improvised a code edit from outside the build gate; the other correctly walked two
hops). Naming a step instead of a destination is the ambiguity; naming the destination and asserting
arrival mechanically (below) removes it.

| target gate | `revising-*` activity | lands at (INPUT) |
|---|---|---|
| clarify | `revising-promoting` | `Proposed` |
| decompose | `revising-clarifying` | `Clarified` |
| design | `revising-decomposing` | `Decomposed` |
| build | `revising-building` | `Planned` |

(This table is the single canonical home for this mapping — `harmony-revise-scope/SKILL.md` and any other
caller reference it here rather than restating it.)

**`reopenToGate(task_id, targetGate)` — the shared bounded one-hop-then-recheck procedure.** Every caller
(harmony-revise-scope, finish-work, …) reopens a gate by following this same prose recipe with its own
already-available `mcp__harmony__get_task` / `mcp__harmony__advance_workflow` calls — this is plumbing (an
AGENT/SYSTEM `advance_workflow` call with no human decision attached, the same class as the conductor's
`Captured`→`proposing` auto-advance), not a new `src/` helper:

1. **Read** `mcp__harmony__get_task({ task_id, view: 'meta' })` and take its `workflow_state`.
2. **Derive** `nextGate` from `workflow_state` via the state→gate map in "## The canonical gate table"
   above.
3. **Arrived?** If `nextGate === targetGate`, stop — return **`arrived`**.
4. **Undershot — apply the next hop.** Call `mcp__harmony__advance_workflow({ task_id, activity:
   REOPEN_VERB[targetGate] })`, where `REOPEN_VERB` is the "`revising-*` activity" column of the table
   above, keyed by `targetGate`. If the DB guard REJECTS the transition (no edge from the current state
   toward the target), stop — return **`stuck`**.
5. **Loop, bounded at 4 iterations.** Go back to step 1. Four is the ceiling because the longest real
   reopen (`--to build` from `Deployed`) is exactly two hops (`revising-building` Deployed→Built, then
   `revising-building` again Built→Planned) — 4 iterations is generous headroom, not a tuned bound. Hitting
   the bound without arriving or going stuck is itself a `stuck`-class outcome — stop and report it exactly
   like a rejected transition; never keep looping past it.

**`stuck` → file a `worker-question`, never guess.** This is the ONE place product-design rule 3 ("an agent
may never perform a gate's work from outside that gate, and must never improvise a path forward when no
edge exists toward the target") is implemented — every caller inherits it for free instead of re-deriving
it locally. On `stuck` (a rejected transition, or bound-exhaustion), the caller:

1. `mcp__harmony__start_elicitation({ task_id, trigger: 'worker-question' })`
2. `mcp__harmony__file_elicitation_round(...)` naming the **current `workflow_state`**, the **target
   gate**, and the **missing edge** (which `revising-*` activity was rejected, or that the 4-iteration
   bound was hit without arriving) — per `skills/harmony-shared/elicitation-engine.md` §The worker-question
   trigger.
3. **End the turn.** Never guess a path forward, never fall back to performing the target gate's work from
   outside it.

**Rule 3, generalized.** The same standing rule applies even when `reopenToGate` is not in play: an agent
that lands with no gate to run, or is asked to perform a gate's work while not inside that gate, must stop
and report via the same `worker-question` mechanism — never improvise. A release-gate merge conflict is the
named instance this ticket (B-762) fixes: resolving a merge conflict is a code change, so it belongs to the
build gate. The release gate calls `reopenToGate(task_id, 'build')` (reopening `Built --revising-building-->
Planned`) and STOPS — it never resolves the conflict in place, regardless of `git`/`Bash` reachability
(disallowed-tools bounds tools, not effects — B-746). No extra round-trip mechanism is needed: once
rebuilt, the ticket naturally re-enters release's normal brief-drafting flow, which already requires a
fresh human approval against the new head.

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
