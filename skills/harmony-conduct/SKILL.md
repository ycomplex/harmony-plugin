---
name: harmony-conduct
description: Drive one ticket through the gate sequence end to end. Default = pause at every gate for the human's decision (controlled). Optional per-run delegation — `--pause-at <gate>` (auto-advance up to a gate), `--unattended` (auto-advance to the hard floor), or `--escalate` (auto-advance, but surface any gate genuinely worth a human opinion). A non-discretionary risk-class FLOOR (auth / data-migration / irreversible-destructive / shared-core) surfaces a delegated gate for a human under EVERY delegating mode, regardless of dial or agent judgment. Triggers on "conduct B-123", "harmony conduct", "run B-123 through the flow", "drive this ticket to verified". The conductor orchestrates the plumbing BETWEEN gates; at a controlled gate it hands the decision to the human, and an auto-advanced gate still records the SAME Accepted decision a controlled run would.
allowed-tools: mcp__harmony__* Read Grep Glob
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Conduct (conductor — B-458 phase 2a controlled core + B-489 phase 2b autonomy selector + B-485 browser auto-pickup + B-493 phase 2c risk-class floor & --escalate + B-500 auto-watch by default + B-506 Decomposed split-umbrella branch + B-519 revise-scope / back-up)

The conductor loop. Given a ticket and a "go", it drives the whole gate sequence
(clarify → decompose → design → plan → build → release → verify) by delegating to the existing gate
skills **in lifecycle order**, automating the drudgery of hand-invoking `/harmony-plugin:harmony-next`
at each step into one continuous loop.

`harmony-conduct` is the **generalization of `harmony-next`** (agent-model §5): instead of pulling one
awaiting item and stopping, it loops over the forward path. The **controlled** route (the default, no
flag) is **not** a new decision surface — every gate still drafts and `compose_brief`s exactly as today,
and the human still answers through the existing brief surface (web UI Accept/Defer/feedback, or the gate
skill's accept/edit/iterate). Phase 2b adds an **opt-in per-run delegation selector** that lets the human
hand specific *early* gates to the conductor for the run; it does not change the controlled default and it
never crosses the hard floor (release + verify stay human). Phase 2c (B-493) adds two things on top: a
**non-discretionary risk-class FLOOR** that surfaces *any* delegated gate whose subject touches a
high-consequence class (auth / data-migration / irreversible-destructive / shared-core) regardless of mode,
dial, or agent judgment; and a 4th mode, **`--escalate`**, which auto-advances like `--unattended` but
**surfaces any gate the conductor judges genuinely worth a human opinion**. Neither weakens the controlled
default or the hard floor — the floor only ever *adds* pauses, never removes one.

## The contract this skill obeys (founder-locked — do not relitigate)

1. **The default route NEVER changes itself.** A bare `harmony-conduct B-123` (no flag) is **controlled**:
   it surfaces every gate's brief and **PAUSES**. The system never decides on its own to delegate a gate.
   Delegation only happens when the **human passes an explicit flag** for *this run*. There is no "this
   looks minor, I'll just run it" — auto-advance is the human's conscious per-run choice, never the
   conductor's inference.
2. **It orchestrates only the *plumbing between* gates.** The conductor delegates to a gate skill, lets
   that skill draft + compose the brief. At a **controlled** gate it then **stops and hands the decision to
   the human** (the human's accept/defer/edit lives in the web UI or the gate skill — see §controlled
   pause). At a **delegated (auto-advanced)** gate it **synthesizes the human's "accept"** and routes it to
   the owning gate skill's accept path — the exact same routing the controlled flow uses when a human types
   "accept" — so the gate's decision is *recorded identically*; only the human pause is skipped.
3. **The HARD FLOOR is always human, regardless of any flag or dial.** The workspace safety rails — the
   **release** gate (merge + deploy: one-way, irreversible) and the **verify** gate (Released→Verified) —
   are NEVER auto-resolved by the conductor. Even `--unattended`/`--escalate` pause at release and at
   verify. One-way / irreversible decisions always surface for a human.
3a. **The RISK-CLASS FLOOR is non-discretionary and dial-independent (B-493, phase 2c).** Before
   auto-advancing ANY delegated gate, the conductor reads `risk_classes` from `get_task` (a deterministic,
   conservative detector — auth / data-migration / irreversible-destructive / shared-core — over the ticket
   text + active brief, and over changed paths when known). If it is **non-empty**, the conductor
   **surfaces the gate + pauses + ANNOUNCES which class tripped it** — regardless of the per-run mode
   (`--pause-at`/`--unattended`/`--escalate`), the dial level, or any agent/`--escalate` judgment that the
   gate is "routine". This is part of the hard floor: a risk-class hit floors a gate the same way release
   and verify are floored. It is **additive** — it can only *add* a pause to a delegated run, never remove
   one, and it does not change the controlled default (controlled already pauses everywhere). It applies to
   the **existing** `--pause-at`/`--unattended` runs too, not just `--escalate`.
4. **The workspace Agent-Trust dial is a restrict-only CEILING.** A per-run flag can only delegate what the
   dial permits. A `cautious` dial is a **kill-switch**: it forbids ALL delegation — the run goes fully
   controlled and the conductor **announces** that the workspace dial overrode the flag (never a silent
   no-op). `balanced` and `autonomous` both permit per-run forward delegation. The dial can only *restrict*
   the per-run flag, never *expand* it.

## State-driven and resumable — the loop's memory is the ticket row

The conductor holds **no lifecycle state in the session**. The loop's entire memory is the ticket row
(`workflow_state`, `workflow_activity`, `awaiting_human_input`, `awaiting_human_reason`,
`awaiting_human_ref`, the `stale` flag, and the active brief). Re-running `/harmony-plugin:harmony-conduct
B-123` reconstitutes everything from `get_task` and resumes from the ticket's current state — whether the
previous session was closed, the human answered in the web UI, or the ticket advanced by some other path.
This works for the same reason `resolve_brief` is idempotent: each loop iteration is a pure function of
the ticket row, so it is **idempotent and stateless between pauses**. No new schema, no session file.

**The per-run mode (controlled / `--pause-at <gate>` / `--unattended` / `--escalate`) is the ONE piece of
run-scoped intent the ticket row does NOT carry** — it is supplied by the human's invocation each time. On a
re-run without a flag the conductor is controlled again (the safe default); to resume an
unattended/partial/escalate run the human re-passes the flag. (The risk-class floor needs no persistence
either — it is recomputed from `risk_classes` on every re-read, so it survives a session boundary
automatically.) The conductor never persists a delegation choice — there is nowhere it could,
and persisting it would let the system delegate a future run the human didn't authorize.

## Flow

### 1. Parse the per-run mode, then resolve the dial ceiling + the target ticket

**1a. Parse the invocation flags into a `mode`.** Exactly one of:

- **no flag** → `mode = controlled`. Pause at every gate. (Behaviourally identical to phase 2a.)
- **`--pause-at <gate>`** → `mode = partial`, with a `pauseAt` gate. Auto-advance every gate *before*
  `<gate>`, then revert to controlled *at* `<gate>` and every gate after it. `<gate>` must be one of:
  `clarify`, `decompose`, `design`, `plan`, `build`, `release`, `verify`.
- **`--unattended`** → `mode = unattended`. Auto-advance every forward gate up to the hard floor (pause at
  release and at verify).
- **`--escalate`** → `mode = escalate` (B-493, phase 2c). Auto-advance like `--unattended` (every forward
  gate up to the hard floor), **except** that before auto-advancing a forward gate the conductor forms a
  qualitative *"is this gate genuinely worth a human opinion?"* judgment over the gate's drafted brief
  (see *The escalate judgment* below). Worth it → surface + pause (the gate reverts to controlled for this
  run); not worth it → decide-and-record via the owning gate skill's accept path (the same write
  `--unattended` uses). The risk-class floor (§3a) sits **underneath** the judgment: a risk-class hit
  floors a gate even when the judgment says "routine".

Validation (do this BEFORE touching the ticket):

- `--pause-at`, `--unattended`, and `--escalate` are **mutually exclusive**. If more than one is present →
  **ERROR** and stop.
- An **unknown / misspelled** flag (e.g. `--escalte`, `--unattnded`) → **ERROR** and stop. *Never* treat an
  unrecognized flag as a delegating mode or silently fall back to controlled — print the allowed flags and
  stop.
- An **unknown / misspelled** `<gate>` for `--pause-at` → **ERROR** and stop. *Never* treat an
  unrecognized gate as "delegate everything" or silently fall back to controlled — print the allowed gate
  list and stop. (Silently delegating on a typo is exactly the contract-1 violation this guards.)
- Absence of any flag ⇒ controlled. This is the only default; the conductor never selects delegation on
  its own.

Note that `--pause-at release` and `--pause-at verify` are *expressible* but redundant with the hard floor
(release/verify are never auto-advanced anyway). They are accepted (they correctly auto-advance everything
before the floor); just be aware the floor already enforces the pause there.

**1b. Resolve mode + the dial ceiling.** Call `mcp__harmony__get_project`. If `mode !== 'opinionated'`,
stop — the conductor drives the opinionated-mode lifecycle (manual-mode projects use the normal board, not
clarify→decompose→design→…). `get_project` now also returns `agent_trust` (the owning workspace's dial,
resolved): `agent_trust.level` ∈ `{cautious, balanced, autonomous}` (empty `{}` dial ⇒ `balanced`).

Apply the dial **ceiling** to the parsed per-run `mode`:

- **`agent_trust.level === 'cautious'`** (the kill-switch — `autoAdvances == []`): the dial forbids ALL
  delegation — **including `--escalate`**. **Override the per-run mode to `controlled`** and **ANNOUNCE** it
  plainly, e.g.: *"This workspace's Agent-Trust dial is set to **cautious**, which forbids delegation — I'm
  ignoring `--escalate` and running B-123 fully controlled (pausing at every gate). Raise the dial to
  balanced or autonomous in workspace settings to allow per-run delegation."* Never silently drop the flag.
  (`--escalate` is delegation-with-an-escape-hatch, not a softened controlled run, so the cautious
  kill-switch vetoes it exactly as it vetoes `--unattended`.)
- **`agent_trust.level === 'balanced'` or `'autonomous'`**: the dial permits per-run forward delegation,
  including `--escalate` — honour the parsed `mode` as-is. (In v1 the dial does not further gate *which*
  forward gates may be delegated beyond the cautious kill-switch; the per-run flag governs that.
  release/verify stay human regardless of the level, so the dial's release/verify auto-advance classes are
  moot here. The risk-class floor (§3a) applies under *all* permitted modes and at every level.)

A ticket id is **required** — `/harmony-plugin:harmony-conduct B-123 [--pause-at <gate> | --unattended]`.
(Conducting picks a *specific* ticket to its terminal state; that is different from
`/harmony-plugin:harmony-next`, which pulls whatever is top of the queue.) If no ticket was named, ask for
one and stop.

`mcp__harmony__get_task({ task_id })`. Note the starting `workflow_state` and report the **effective mode**
(after the dial ceiling), e.g.:
- controlled: *"Conducting B-123 from <state>. I'll pause at every gate for your decision."*
- partial: *"Conducting B-123 from <state> — auto-advancing through every gate before **<pauseAt>**, then
  pausing at **<pauseAt>** and every gate after for your decision. (Auto-advanced gates still record their
  decision as Accepted.)"*
- unattended: *"Conducting B-123 from <state> unattended — auto-advancing every forward gate, then pausing
  at **release** (merge + deploy) and **verify** for your decision, which always require a human."*
- escalate: *"Conducting B-123 from <state> with `--escalate` — auto-advancing forward gates, but pausing
  on any gate I judge genuinely worth your opinion, on any gate that trips the risk-class floor (auth /
  data-migration / irreversible-destructive / shared-core), and always at **release** and **verify**.
  (Auto-advanced gates still record their decision as Accepted.)"*

In **every** delegating mode, also note the floor once up front, e.g.: *"I'll also surface — regardless of
mode — any gate whose subject touches auth, a data migration, an irreversible/destructive change, or a
shared-core module."*

### 2. The loop

Repeat the following until a **TERMINAL** or **PAUSE** condition is reached (see *§5. Terminal conditions*):

1. **Re-read the ticket, then render the progress overview.** `mcp__harmony__get_task({ task_id })` at the
   TOP of every iteration — never trust a cached copy. Read `(workflow_state, workflow_activity,
   awaiting_human_input, awaiting_human_reason, awaiting_human_ref, stale)`. **Immediately after the
   re-read, regenerate and render the progress overview from the ticket row** (see *The progress overview*
   below). This happens on **every** iteration so the checklist always reflects the just-read state.

2. **If the ticket is already awaiting a human decision → handle per mode.** If `awaiting_human_input`
   is set, a gate has already drafted a brief. There is one active brief per task, so do **NOT** run
   another gate on top of it. Run *The delegation test* below — which checks, in order, the cautious
   kill-switch, the hard floor (release/verify), the **risk-class floor** (`risk_classes` non-empty), the
   `--escalate` judgment, and finally the mode table — to decide whether this gate is **delegated
   (auto-advanced)** or **controlled (pause)** for this run:
   - **Controlled / floored / escalate-surfaced gate** → go to *§4. Surface the brief + pause*. This covers
     the resume case (a re-run that finds an unresolved brief at a controlled gate), a gate the risk-class
     floor tripped, and a gate the `--escalate` judgment flagged as worth a human opinion.
   - **Delegated (auto-advanced) gate** → go to *§4b. Auto-advance*: synthesize the human's accept and
     route it to the owning gate skill's accept path, then continue the loop. NEVER auto-advance a
     release/verify gate (hard floor) or a gate with non-empty `risk_classes` (risk-class floor) — those
     always fall to *§4. Surface the brief + pause* regardless of mode or dial.

3. **If the ticket is `stale` → PAUSE and route to the patch author.** A superseded knowledge decision
   has put the ticket out of sync (state-machine §6.4). This is a human decision, not a forward gate, and
   it is **never** auto-advanced (not on the forward path, not gated by the per-run flag). Delegate to
   `/harmony-plugin:harmony-stale-patch <ticket>` (it drafts the `stale-patch-review` brief), then surface
   it and pause (*§4. Surface the brief + pause*) — exactly as `harmony-next` does. The loop does not
   advance a Stale ticket past the patch decision, even unattended.

4. **If `workflow_state === 'Captured'` → auto-advance `promoting` (plumbing, NOT a pause), then loop
   again.** A freshly-created ticket lands in `Captured` (the post-B-474 inbox state). `promoting`
   (Captured→Idea) is a **brief-less AGENT/SYSTEM transition** with no human decision attached — and in the
   conductor, *choosing to conduct this ticket IS the promote decision* (the human named it; they've
   already decided it's worth pursuing). So the conductor advances it itself, with **no brief and no
   pause**: `mcp__harmony__advance_workflow({ task_id, activity: 'promoting' })` (Captured→Idea). Then go
   back to step 1 (re-read) — the ticket is now `Idea` and the next iteration runs the clarify gate.
   **Do NOT** try to file a `clarifying` brief from `Captured` — the transition table only allows
   `('Captured','promoting','Idea')` then `('Idea','clarifying','Clarified')`, so `compose_brief` with
   `pending_activity: 'clarifying'` would hard-error from `Captured`. (This is the one self-advance the
   conductor makes regardless of mode; it advances no *human* decision — contrast `harmony-next`, which
   **surfaces** promoting as a human triage decision because it pulls un-triaged queue items, see
   harmony-next's routing.)

5. **If `workflow_state === 'Decomposed'`, branch split-umbrella vs no-split BEFORE routing to design.**
   `mcp__harmony__list_subtasks({ task_id })` (direct children). **≥1 non-archived child ⇒ split umbrella;
   zero ⇒ no-split.** This is the durable fact the B-471 roll-up itself keys on (children-exist), so it is
   the detection signal — not a re-read of the decompose decision's split/no-split outcome.
   - **No-split** (the parent kept the work) → fall through to step 6 and route to `harmony-design-decide`
     as today. The no-split path is **behaviourally unchanged**.
   - **Split umbrella** (decompose created children; the work — design + build — lives in the children) →
     do **NOT** run `harmony-design-decide` on the umbrella. Render the **umbrella report** — list each
     child's visual ID + title + `workflow_state` — and **end the run on the parent** (*report-and-stop*,
     see *§5. Terminal conditions*). The parent completes on its own via the **B-471 umbrella-auto-verify
     roll-up**: once all children reach Verified, the DB trigger forward-advances the parent
     Decomposed→Released, and finish-work's no-PR verify path (the `umbrella-auto-verify` null-brief
     handling, §4) carries Released→Verified with a human ack. Tell the human to **conduct the children** to
     drive it. This branch **advances no state and files no brief** — it is a brief-less, resumable
     end-of-run; it is **never auto-advanced** and **dial-independent** (there is no decision to delegate, so
     no mode / flag / floor applies). *(Forward-compatible seam: a later phase — B-508 — may replace
     report-and-stop with a hand-off that conducts the children; v1 stops and reports.)*

6. **Otherwise, determine the next forward activity and RUN it** by delegating to the owning gate skill
   (state→activity map below). The gate skill queries knowledge, drafts the decision, and `compose_brief`s
   — setting `awaiting_human_input`. Then the loop re-reads at step 1, lands in step 2 (now awaiting), and
   either pauses (controlled gate) or auto-advances (delegated gate). *(Side-effecting note: the gate
   skills' accept paths carry the side effects — `harmony-decompose` creates children on accept,
   `finish-work` does the merge/deploy on accept. In a controlled run those happen at the human's accept;
   in a delegated run the conductor synthesizes the accept and the gate skill performs the same side
   effects — see §4b.)*

### The delegation test — is THIS gate auto-advanced for this run?

Map the just-read `workflow_state` to its **phase** (clarify/decompose/design/plan/build/release/verify;
use the phase map in *The progress overview*). Apply these checks **in order** — the FIRST that forces a
pause wins; only if none force a pause does the gate auto-advance:

1. **Cautious kill-switch (dial, §1b).** If the dial overrode the mode to `controlled`, every gate is
   controlled — pause. (Already handled at §1b; the effective `mode` is `controlled` here.)
2. **Hard floor (release/verify, contract 3).** If the gate's phase is **release** or **verify**, it is
   NEVER auto-advanced, in any mode — surface and pause (§4).
3. **Risk-class FLOOR (contract 3a — NON-DISCRETIONARY, dial-independent, B-493).** Read `risk_classes`
   from the `get_task` of step-1 (the conductor already re-read the ticket). If it is **non-empty**, the
   gate is **floored** — surface and pause (§4), **regardless of the per-run mode, the dial level, and any
   `--escalate` judgment** below. ANNOUNCE which class(es) tripped it (§4 includes the wording). This check
   sits ABOVE the mode-delegation branch and BELOW the hard floor: it floors a forward gate that the mode
   table (step 5) would otherwise auto-advance, and it floors a gate that the `--escalate` judgment (step 4)
   would call routine. It is additive — it can only force a pause, never grant an auto-advance.
4. **`--escalate` judgment (only in `mode = escalate`, B-493).** If the effective mode is `escalate` and the
   gate survived steps 1–3 (not floored), form the qualitative *"is this gate genuinely worth a human
   opinion?"* judgment over the gate's drafted brief (see *The escalate judgment* below). **Worth it →
   surface and pause (§4)** (revert this gate to controlled for the run). **Not worth it → auto-advance**
   (fall through to step 5's decide-and-record). In any other mode this step is skipped.
5. **Mode-delegation branch.** Given the effective `mode`, the gate auto-advances iff:

| effective `mode` | a gate auto-advances iff … |
|---|---|
| `controlled` | never — every gate is controlled (pause) |
| `partial` (`pauseAt = G`) | the gate's phase is **strictly before** `G` in lifecycle order — AND the phase is not release/verify — AND it survived steps 2–3 |
| `unattended` | the gate's phase is a forward gate (clarify/decompose/design/plan/build) — i.e. **not** release/verify — AND it survived steps 2–3 |
| `escalate` | the gate's phase is a forward gate — AND it survived steps 2–4 (not floored AND judged routine in step 4) |

**The hard floor wins over everything:** release and verify are NEVER auto-advanced, in any mode (step 2).
The **risk-class floor (step 3) wins over the mode table and the escalate judgment** — a non-empty
`risk_classes` always pauses a delegated gate. `stale` is likewise never auto-advanced (loop step 3), and a
`Captured` ticket always self-advances `promoting` as plumbing (loop step 4), not via this test.

Lifecycle order for "strictly before": `clarify < decompose < design < plan < build < release < verify`.

### The escalate judgment — is THIS gate genuinely worth a human opinion?

Only runs in `mode = escalate`, and only for a gate that already passed the hard floor (step 2) **and** the
risk-class floor (step 3). It is a **qualitative** call over the gate skill's drafted brief — there is **no
numeric threshold and no score**. Read the active brief (its `doc` + rendered `content`) and ask whether a
human would meaningfully change the outcome. Lean toward surfacing when one or more of these hold; lean
toward auto-advancing (decide-and-record) when none do:

- **Low-confidence recommendation** — the brief hedges, or `doc.recommend` is weakly held / presented as a
  coin-flip.
- **Surfaced knowledge gaps** — the gate skill flagged a load-bearing gap (research-first brief, an
  unresolved open question, an Asserted-not-Accepted dependency it leaned on).
- **Closely-matched alternatives** — `doc.alternatives` are near-ties; the choice is genuinely contestable
  rather than obvious.
- **Novel / precedent-setting decision** — it sets a pattern future tickets will inherit, or there is no
  prior Accepted decision to anchor on.
- **Stale underlying knowledge** — the decision rests on knowledge that looks out-of-date or recently
  churned.
- **Broad blast radius** — the decision reaches well beyond this ticket (many consumers, cross-cutting
  surface) even if it did not trip the deterministic shared-core risk class.

If you surface, say *why* (which signal fired), so the human can calibrate. If you auto-advance, the
decide-and-record path is the **same** owning-gate-skill accept the floor-clean `--unattended` path uses
(§4b) — no new write path, identical Accepted knowledge (parity, AC7). The risk-class floor still sits
under this judgment: a gate judged routine here is **still** surfaced if step 3 floored it.

### 4b. Auto-advance a delegated gate — synthesize the human's accept

When the delegation test selects a gate to **auto-advance** (it survived the hard floor, the risk-class
floor, and — in `--escalate` — was judged routine), the conductor **synthesizes the human's "accept"** for
that brief and routes it to the owning gate skill's accept path — the *same routing* the controlled flow
uses when the human types "accept" in-session (§controlled pause's "If the human answers in this same
session"). It is the SAME write in every delegating mode (`--pause-at`, `--unattended`, `--escalate`'s
decide-and-record) — `--escalate` does **not** introduce a new accept path; it only adds a *pause* decision
in front of this one. It does **not** invent a new write path:

- **Pure gates** — clarify (`brief-review`), design (`*-design-decision` per sub-track), plan
  (`plan-draft`): the accept is the gate skill's `resolve_brief({ decision: 'accept', … })`. Routing to the
  owning gate skill's accept path (NOT a raw conductor `resolve_brief`) ensures the gate skill records its
  Accepted knowledge decision and runs its own completion logic.
- **Side-effecting DECOMPOSE** (`decomposition-proposal`): the accept is `harmony-decompose`'s
  **child-creating accept path**, NOT a bare `resolve_brief` — children must be created first (the gate
  skill owns that). Synthesize the accept by routing to `harmony-decompose`'s accept (the same path a human
  "accept" takes), so the children are created and the parent advances.
- **release / verify**: **NEVER** auto-resolved. (Unreachable here — the delegation test excludes them; the
  hard floor is the backstop.) Likewise, a gate with non-empty `risk_classes` never reaches §4b — the
  risk-class floor (delegation test step 3) sends it to §4 first.

**Parity invariant (AC5):** an auto-advanced gate records the **SAME Accepted knowledge** a controlled run
would. Auto-advance only skips the human *pause* — it does not skip the *decision record*. Because the
conductor reuses the owning gate skill's accept path (the human's exact routing), the Accepted knowledge
entry, state transition, and side effects are identical to a human-accepted controlled run. If a gate skill
would NOT record a decision on a plain human accept, neither does its auto-advance — the contract is
"identical to a human accept, minus the pause", nothing more.

After the synthesized accept, briefly note it for the human's audit trail, e.g.: *"Auto-advanced the
**<gate>** gate (accepted on your behalf per `--unattended`); recorded its decision. Continuing…"* Then
**resume the loop at step 1** (re-read the ticket; the gate skill has advanced the state). Do not pause.

### The state → activity map (the §6.1 forward path)

Branch on `workflow_state` to pick the next gate. This mirrors `harmony-next`'s routing table, walked
forward one state at a time:

| `workflow_state` | Next activity | Delegate to | Gate is… |
|---|---|---|---|
| Captured | promoting | (none — `advance_workflow` directly) | **plumbing, not a human pause** — auto-advance Captured→Idea (see below), then loop |
| Idea | clarifying | `/harmony-plugin:harmony-clarify <ticket>` | pure (accept = `resolve_brief`) |
| Clarified | decomposing | `/harmony-plugin:harmony-decompose <ticket>` | side-effecting (accept creates children) |
| Decomposed **(no-split)** | designing | `/harmony-plugin:harmony-design-decide <ticket> --track <sub-track>` | pure per sub-track; serialized (one brief at a time) |
| Decomposed **(split umbrella)** | — (no gate) | (none — see *loop step 5*) | **report-and-stop** — the children carry design/build; the B-471 roll-up completes the parent. NOT a forward gate |
| Designed | planning | `/harmony-plugin:start-work <ticket>` | pure (accept = `resolve_brief`; the accept is "go" to build) |
| Planned | building | `/harmony-plugin:start-work <ticket>` | build work, then files `release-decision-pending` |
| Built | releasing | `/harmony-plugin:finish-work <ticket>` | side-effecting (accept → merge+deploy) — **HARD FLOOR, always human** |
| Released | verifying | `/harmony-plugin:finish-work <ticket>` (verify step) | side-effecting (observe prod); also the PR-less umbrella path — **HARD FLOOR, always human** |
| Verified | — | (none) | TERMINAL — loop ends |
| Parked / Cancelled | — | (none) | TERMINAL — loop ends |

**Designing is multi-sub-track and serialized** (and applies to a **no-split** parent only — loop step 5
routes a *split umbrella* to report-and-stop instead; you never design an umbrella, its children carry
design/build). `harmony-design-decide` runs ONE sub-track per
invocation and there is one active brief per task, so the design phase is several pause/resume cycles:
file product-design → (pause or auto-advance) → accept → loop re-reads (still Decomposed, no other
sub-track accepted yet) → file technical-design → … The ticket only advances Decomposed→Designed when the
**last required** sub-track is accepted (the gate skill owns that completion check via
`list_ticket_knowledge`). The conductor does not decide which sub-tracks are required — it re-invokes
`harmony-design-decide` and lets the gate skill propose/serialize them. **When the design phase is
delegated** (auto-advanced), each serialized sub-track brief is auto-accepted in turn via §4b until the gate
skill reports Designed; the per-sub-track serialization is unchanged, only the pause is skipped. If the
ticket is still Decomposed after a design sub-track was accepted, that is the normal "more sub-tracks to
go" case — keep looping.

**Designed → Planned → Built both delegate to `start-work`.** In opinionated mode `start-work` drives
*planning* (Designed→Planned, files a `plan-draft` brief) and *building* (Planned→Built, builds in a
worktree then files `release-decision-pending`). Invoke it for both states; it branches internally on
`workflow_state` (its step O1). After the plan is accepted (ticket → Planned), the next loop iteration
re-invokes `start-work`, which proceeds to build.

### The progress overview — an inline derived view, never session state

The human reading the loop sees the *current* gate at each pause, but needs an *overview*: where the baton
is in the whole run. **Render that overview inline, in the chat** — a small Markdown checklist printed in
your message. **Inline is the design, not a fallback** (F1). The overview is a read-only derived view of
the ticket row; it has no interactive/persistence semantics that would need a task-list tool, and the
conduct session does not reliably have `TodoWrite` available. So the spec is: print the checklist inline.
(`TodoWrite` is **not** an allowed tool of this skill and must not be relied on; if a future session has it
and you choose to mirror the checklist there, it must degrade **silently** to the inline render — inline is
authoritative and always rendered.)

**It MUST be a derived view reconstructed from the ticket row, NOT session-held state.** The loop's only
lifecycle memory is the ticket row (§"State-driven and resumable"); a session-held checklist would break
resumability and drift from the truth. So, on **every** iteration, **right after the `get_task` re-read in
step 1**, regenerate the checklist *from scratch* from the current `workflow_state` and print it inline.
Hold nothing between iterations. On a fresh re-run in a new session it must regenerate **identically** from
the ticket row — there is no carried lifecycle state to consult.

**The checklist is the fixed forward path**, one item per phase, in lifecycle order:

```
clarify → decompose → design → plan → build → release → verify
```

Derive each item's status purely from `workflow_state` — map the state to the phase it is *in*, then:

- phases **before** the current phase → `completed`
- the current phase → `in_progress`
- phases **after** → `pending`

Render it inline as a simple Markdown checklist, marking each item with its derived status, e.g.:

```
Progress for B-123 (state: Decomposed):
- [x] clarify        (completed)
- [x] decompose      (completed)
- [ ] design         (in_progress)  ← current gate
- [ ] plan           (pending)
- [ ] build          (pending)
- [ ] release        (pending)
- [ ] verify         (pending)
```

| `workflow_state` | Current phase (→ `in_progress`) |
|---|---|
| Captured / Idea | clarify |
| Clarified | decompose |
| Decomposed | design |
| Designed | plan |
| Planned | build |
| Built | release |
| Released | verify |
| Verified | — all `completed` (terminal) |
| Parked / Cancelled | mark phases through the last-reached one `completed`, leave the rest `pending`; the run is terminal |

(`Captured` and `Idea` both map to the `clarify` phase — a `Captured` ticket auto-advances `promoting` to
`Idea` first, §"The loop" step 4, so the very next overview after the promote shows `clarify` as
`in_progress` exactly as it would from `Idea`.) For **Verified**, mark every item `completed`. For
**Parked**/**Cancelled**, the run is terminal — the list shows progress frozen where it stopped (no
`in_progress` item). Keep it to this high-level phase map; per-design-sub-track granularity is **not**
required (if a `design` sub-track is mid-serialization you may note it in the design item's text, but only
if it stays a cheap, clean read of the ticket row).

**Umbrella-aware rendering (split umbrella at Decomposed).** The phase map above maps `Decomposed → design
in_progress` — correct for a **no-split** parent. For a **split umbrella** (Decomposed *with* children, loop
step 5), the parent does not carry design/plan/build at all — its children do. So render those three phases
as **"— carried by children"** and release/verify as **"via roll-up"** (the parent's only forward motion,
the B-471 auto-advance), and put the current marker on the **umbrella report-and-stop**, not on
"design in_progress". This stays a cheap derived read: it's keyed on the same `list_subtasks` children-check
step 5 already made.

**Annotate the delegation plan (informational).** When the effective mode is `partial`, `unattended`, or
`escalate`, you may annotate each phase item's text with whether it will be **auto-advanced** or **paused**
under the current mode (e.g. "design — auto-advance", "release — pause (you decide)"), derived from the
delegation test + the hard floor. For `escalate`, a forward gate is best annotated **"auto-advance unless I
judge it worth your opinion"** (the judgment is per-brief and not known until the gate drafts), and any
phase is annotated **"pause — risk-class floor"** if you already know it trips the floor. The floor and the
escalate judgment are both decided per-iteration from the just-read ticket (`risk_classes` + the drafted
brief), so the annotation is a forward-looking hint, not a guarantee. This is purely informational — it
never drives a decision and never substitutes for the controlled pause; it just makes the run's plan
legible. Derive it fresh from `mode` each iteration; do not store it.

This checklist is purely informational — it never drives a decision and never substitutes for the
brief-surface pause. It is regenerated, not mutated, so it can never disagree with the ticket row.

### 3. One step per iteration — auto-advance continues, a controlled gate pauses

After delegating to a gate skill, the loop re-reads at step 1 and the delegation test decides:
- a **controlled** gate → the gate has composed a brief and set `awaiting_human_input`; the ball is now in
  the human's court → §4 (pause).
- a **delegated** gate → §4b (synthesize accept, continue looping).

The controlled flow's forward motion is gated on the human resolving each brief; that is contract item 1.
The delegated flow's forward motion is the conductor synthesizing the accept the human authorized via the
per-run flag (contract item 2) — never crossing the hard floor (contract item 3), never auto-advancing a
risk-class-floored gate (contract item 3a), and in `--escalate` pausing on any gate it judges worth a human
opinion.

### 4. Surface the brief + pause for the human's decision (controlled gate, or the hard floor)

This is the **controlled pause** — reached at every gate in controlled mode, at `pauseAt` and after in
partial mode, at any gate the `--escalate` judgment deems worth your opinion, ALWAYS at release + verify
(the hard floor) and at a `stale` patch in every mode, and ALWAYS at any delegated gate the **risk-class
floor** tripped (§3a) in every delegating mode.

Surface the active brief so the human can decide:

- `mcp__harmony__get_brief({ task_id })` and display the rendered `content` blob **verbatim** in a fenced
  block (it is already BLUF-formatted and lint-clean — do not re-summarise it). Note `iteration` if > 1.
- **Null brief on a `verification-ack-pending` umbrella (B-471):** `get_brief` can be **null** when
  `awaiting_human_reason = 'verification-ack-pending'` and `awaiting_human_ref.kind ===
  'umbrella-auto-verify'` — the trigger-surfaced **PR-less umbrella** (a decomposed parent the DB trigger
  auto-advanced Decomposed→Released once all children reached Verified; it set the flag but composed no
  brief). Do **not** choke on the missing brief. The `verifying` gate already routes to
  `/harmony-plugin:finish-work <ticket>` (per the map), which composes the verification brief first and
  then surfaces it. Recognise the umbrella by the `umbrella-auto-verify` marker on `awaiting_human_ref`.

Then **STOP and tell the human the ball is in their court.** State plainly: which gate this is, the
one-line decision (`doc.decide`), and how to answer. For a hard-floor gate reached under a delegation flag,
say so explicitly —

> *"B-123 is at the **release** gate (merge + deploy). This always requires a human even under
> `--unattended` — it's a one-way, irreversible decision. Awaiting your decision: <doc.decide>. Accept /
> defer / give feedback in the web UI, or here."*

For a gate the **risk-class floor** tripped (§3a), say so explicitly and **name the class(es)** that
tripped it (from `risk_classes`) — this is non-discretionary and dial-independent, so the human knows it
was not the conductor's discretion —

> *"B-123 is at the **design** gate. I'd normally auto-advance this under `--unattended`, but its subject
> touches **auth** (risk-class floor), so I'm surfacing it for you — risk-class hits always require a human
> regardless of mode or dial. Awaiting your decision: <doc.decide>. Accept / defer / give feedback."*

For a gate the **`--escalate` judgment** flagged as worth your opinion, say which signal fired —

> *"B-123 is at the **design** gate. Running `--escalate`, I judged this one worth your eyes: the
> recommendation is low-confidence and the two alternatives are near-ties. Awaiting your decision:
> <doc.decide>. Accept / defer / give feedback. (Re-run with `--escalate` to resume.)"*

For an ordinary controlled gate —

> *"B-123 is at the **<gate>** gate, awaiting your decision: <doc.decide>. Accept / defer / give feedback
> in the web UI, or here. Re-run `/harmony-plugin:harmony-conduct B-123 [your flag]` after you've decided
> and I'll drive the next gate."*

**The conductor does not resolve a controlled brief on its own.** Accept/defer/edit/iterate at a controlled
gate is the human's decision, made through the existing surface (the web UI's Accept/Defer, or the owning
gate skill's accept/edit/iterate path — `harmony-clarify`/`harmony-decompose`/`harmony-design-decide`/
`start-work`/`finish-work` each own their resolve, including the side effects: children-creation,
merge+deploy, prod-observation). At a controlled gate the conductor *never* synthesizes the resolution —
doing so would be the system making the human's decision, which is exactly what the controlled route exists
to prevent. (The *delegated* path in §4b is different: there the human has explicitly authorized the
accept for this run via the flag, and the conductor synthesizes exactly that accept — never a defer, never
an edit, only the accept the flag authorized, and never past the floor.)

**If the human answers in this same session** (e.g. "accept", "looks good", or substantive feedback),
hand the resolution to the owning gate skill for that `awaiting_human_reason` (the gate skill performs the
accept/defer/edit and any side effects — same routing as `harmony-next`'s table). Once it reports the new
state, **resume the loop at step 2** (re-read the ticket, run the next gate). After a
risk-class-floored or escalate-surfaced pause is resolved, re-running with the same flag continues
auto-advancing the *rest* of the run — the floor/judgment is re-evaluated fresh per gate from the ticket
row, so it neither sticks nor leaks to the next gate.

**If the human asks to `revise-scope` / "back up" at this pause (B-519).** Alongside accept / edit / iterate /
defer, the human may decide the *upstream* spec was scoped too narrowly and the honest move is to back the run
up to an earlier discovery gate (clarify/decompose/design) and re-run it against the real scope — rather than
resolve the current gate. On that verb, **delegate to `/harmony-plugin:harmony-revise-scope <ticket>`** (pass
`--to <gate>` if the human named a target). That skill drafts the reconciliation (target gate + broadened
scope + supersede-list vs keep-list) and files a `revise-scope-review` brief; **the human accepts or rejects
there** — only a human accept executes the back-up (it reverts state via a `revising-*` back-edge; the
conductor never reverts state itself). After delegating, **resume the loop at step 1** (re-read): on accept
the ticket is now at the target discovery milestone and the loop drives it forward from there; on reject the
run is untouched and still paused at this gate.

**The human may answer in the BROWSER — and the conductor watches for it automatically (B-485 + B-500, §4c).**
After surfacing the brief, **do not ask** whether to watch and **do not require a re-run** — auto-watch is the
**default** (B-500: *don't ask, don't make me re-run*). The conductor automatically enters the §4c watch loop
and keeps watching the ticket row for the human's resolution (Accept / Reshape / Deny submitted from the
TaskDetailPanel on any device), continuing the instant it lands. State it plainly, e.g.: *"I'll keep watching
for your decision — resolve it here in the terminal or from the browser (Accept / Reshape / Deny) and I'll
continue automatically."* The watch is **bounded (~90 min, idle backoff)** and ends on **any** of three
co-equal exits: a browser resolution, an in-session/terminal answer, or the ~90-min timeout. On timeout the
loop is paused with **graceful degradation**: a later `/harmony-plugin:harmony-conduct B-123` resumes from the
ticket row (re-pass the flag to resume a partial/unattended/escalate run; absent a flag the resumed run is
controlled) — this is the **no-session degradation**: a browser resolution submitted while no session is
running simply **persists on the ticket row** and the next run applies it. Go to **§4c (Auto-pickup)**.

### 4c. Auto-pickup — consume a browser resolution in the live session (B-485 + B-500)

This is **session-held polling-with-backoff** (locked param **D4: session-held v1; NO background daemon**).
Auto-pickup is the *live running session* watching for the human's out-of-band browser resolution and
consuming it — it is **NOT** a daemon and **NOT** a new write path. It changes only *where* the human
answers (the browser, on any device) versus requiring a session re-run; **it is orthogonal to delegation**
(§4b) — the human still resolves **every** controlled gate. Auto-pickup never makes a decision the human
didn't make; it routes the human's **actual** browser command to the owning gate skill, exactly as a
same-session answer would. **Auto-watch is the default (B-500):** after every controlled pause the conductor
enters this loop automatically — it does **not** ask the human to opt in and does **not** require a manual
re-run.

**The poll loop (bounded, idle-backoff, default-on).** After surfacing the brief at a controlled pause, the
conductor **automatically** re-reads `mcp__harmony__get_task({ task_id })` on a bounded schedule with **idle
backoff** (e.g. every ~10s for the first minute, then ~30s, settling to a coarse ~60s tail) up to a **total
watch window of ~90 minutes** — a tunable default, long enough for the human to step away and resolve from
the browser later, bounded so an abandoned session doesn't spin forever. Between re-reads, simply wait — do
not spin. The watch ends on **any** of three co-equal exits — a browser resolution, an in-session/terminal
answer, or the ~90-min timeout, whichever lands first. On each re-read, compare against the brief you
surfaced and detect which of these the human did in the browser:

1. **State advanced — a browser accept/defer was applied** (`resolve_brief` ran from the web). The
   `workflow_state` moved forward (accept) or is now `Parked` (defer/deny), and `awaiting_human_input` is
   `false`. The web's accept/defer is the **mechanical** half (`resolve_brief` + the B-482 reconciliation
   guard). What remains is any **side effect** that only runs where the agent runs:
   - **Pure gate** (clarify `brief-review`, design sub-tracks, plan `plan-draft`): nothing further — the
     accept fully resolved mechanically. **Continue the loop at step 1** from the new state.
   - **Side-effecting DECOMPOSE** (`decomposition-proposal`): the web accept advanced Clarified→Decomposed
     **but created no children** (the web is mechanical-only; it cannot create children). Route the human's
     **actual** accept to **`/harmony-plugin:harmony-decompose <ticket>`'s child-creating accept path** (the
     same path §4b uses for a synthesized accept, but here the human already accepted) so the children are
     created **in this running session**; its `resolve_brief` accept is idempotent on the already-advanced
     parent. Then continue the loop.
   - **Defer/deny** → ticket `Parked` ⇒ **TERMINAL** (§5). A browser deny is the human's defer; the
     conductor never reverses it.
2. **`pending_resolution` present — a browser reshape (iterate).** `get_task`/`get_brief` returns
   `pending_resolution = { command: 'iterate', detail: <feedback> }`; `awaiting_human_input` is `false`
   (ball → agent) and the active brief is unchanged (the web did NOT advance state — it left the brief
   `active` for you to revise). **Run the LLM iterate in-session** (§4d).
3. **Nothing changed** within the **~90-min** watch window → **poll-window expiry**: fall back to graceful
   degradation — tell the human to re-run `/harmony-plugin:harmony-conduct <ticket>`; the resolution (if any)
   persists on the ticket row; **end the turn**. The next run resumes from the ticket row (the no-session
   degradation). Do not keep an indefinite watch.

**The in-session (terminal) exit (B-500).** The watch also ends the moment the human answers in the **running
session (the terminal)** — accept / feedback / defer typed here. That is a normal in-session answer: handle it
via §4's "If the human answers in this same session" path and **stop polling immediately**. The watch must
never outlive a human who has already responded in-session — in-session and browser answers are **co-equal
exits**, whichever lands first.

**Hard floor in the consume path (AC7).** release (`release-decision-pending`) and verify
(`verification-ack-pending`) are consumed **ONLY from a human-submitted browser resolution — NEVER
conductor-synthesized.** Auto-pickup does not change this: the conductor still never *synthesizes* a
release/verify accept (the §4b auto-advance excludes them in every mode). But when it detects that the
**human** clicked Accept on a release/verify brief in the browser (the human IS the one accepting — the
floor holds by construction), it consumes that human decision and runs the side effect **in the running
session** by routing to `/harmony-plugin:finish-work <ticket>`:
- **release**: the web accept of the release brief clears the flag but **leaves the ticket at Built**
  (the release brief carries `pending_activity: null` — Built→Released is SYSTEM-on-deploy-success, not
  human-accept; see finish-work O1/O2). So on detecting a human browser-accept of release (flag cleared,
  still `Built`, no `pending_resolution`), route to `finish-work` to run the **merge + deploy** in-session;
  finish-work advances Built→Released only after the deploy actually succeeds.
- **verify**: likewise route to `finish-work`'s verify step on a human browser-accept; it advances
  Released→Verified.
If the human did NOT act (no browser accept), release/verify stay paused — the conductor waits or the watch
window expires; it never advances them itself.

### 4d. Run the LLM iterate on a browser reshape (B-485 — AC3)

A browser reshape handed you `pending_resolution = { command: 'iterate', detail: <feedback> }` on the
**active** brief, with `awaiting_human_input = false`. This is the one piece of model work the browser
*cannot* do (the mechanical-vs-LLM boundary, `90b17075`): the browser captured the human's intent
mechanically; **the LLM iterate runs where the agent runs — here**. Consume it:

0. **First, check whether the feedback grew the UPSTREAM scope — if so, RECOMMEND a revise-scope back-up
   instead of cramming it into this gate (B-519, agent-proposed path).** Before re-composing, read whether
   `detail` (or your own analysis of it) materially expanded the ticket's scope or design beyond what an
   in-gate iterate can honestly absorb — i.e. the *upstream* spec/decompose decision the current gate built on
   is now too narrow. If it did, the honest move is to **back up a phase**, not stuff the broadened scope into
   the current brief. **Surface a revise-scope RECOMMENDATION** by delegating to
   `/harmony-plugin:harmony-revise-scope <ticket>` (it drafts the target gate + broadened-scope summary +
   supersede-list vs keep-list and files a `revise-scope-review` brief). This is **a proposal the human
   accepts like any other recommendation** — same brief surface, same accept verb; **the conductor never
   reverts state itself** (only a human accept executes the back-up). After delegating, resume the loop at
   step 1: on accept the ticket is at the target discovery milestone and the loop drives forward from there; on
   reject the human declined the back-up, so fall through to the in-gate iterate (step 1 below) and address the
   feedback within the current gate. If the feedback is *within* the current gate's scope (the common case),
   skip this and just do the in-gate iterate.

1. **Re-compose the brief reflecting the feedback.** Re-invoke the **owning gate skill** for the brief's
   `awaiting_human_reason` (e.g. `harmony-clarify` for `clarification-draft`, `harmony-design-decide` for a
   design sub-track) so it revises its draft **incorporating `detail`** and re-calls
   `mcp__harmony__compose_brief` — the same in-place `iterate` path a same-session "iterate <feedback>"
   takes. `compose_brief` updates the active brief in place and **bumps `iteration` (+1)**, and re-sets
   `awaiting_human_input = true` (the brief is awaiting the human again ⇒ B-492 **'Needs human'**).
2. **The consumed marker is cleared by the re-compose.** `compose_brief` nulls `pending_resolution` on the
   active brief as part of the in-place iterate write — so re-composing the brief (step 1) *is* the consume,
   and the same reshape is not re-consumed on the next poll. You do not clear the marker yourself (the
   conductor owns no brief-write tool); the gate skill's re-compose does it for you. The invariant that
   matters: the marker must not survive to be re-consumed — and `compose_brief` guarantees it.
3. **The iterate loop closes through the browser.** The re-composed brief (iteration+1) now reflects the
   feedback and the ball is back with the human ('Needs human'). **Resume §4 (surface the brief + pause)** —
   and you may again offer auto-pickup (§4c) so the human iterates entirely from the browser.

The reshape is **not** an accept and **not** a state advance — it is a revise-and-resurface. The conductor
never accepts on the human's behalf here; it only does the LLM work the browser deferred to the agent.

### 5. Terminal conditions — when the loop ends (not pauses)

The loop **ends** (does not pause for resume) when, after re-reading the ticket at step 2:

- `workflow_state === 'Verified'` → done. Report: *"B-123 is Verified — conducted from <start state> to
  Verified."* (Even an unattended run reaches Verified only after the human resolved release + verify.)
- `workflow_state === 'Parked'` or `'Cancelled'` → the human deferred/cancelled at a gate. Report where it
  parked and why, and stop. (A deferral authored its own `deferral` knowledge entry via the gate skill —
  the conductor does not author it. Note: a deferral only ever happens at a controlled pause — the
  conductor's synthesized accept never defers.)

- `workflow_state === 'Decomposed'` **with children** (split umbrella, loop step 5) → **report-and-stop**:
  the conductor rendered the umbrella report and ends the run *on the parent*. This is a **third kind** of
  stop, distinct from the two above and from a brief-pause: it is **not** a true terminal (the parent is not
  Verified/Parked/Cancelled — it will still complete via the roll-up) and **not** a controlled pause (no
  brief, `awaiting_human_input` stays false — there is nothing for the human to decide here). It simply ends
  *this run*, and is **resumable**: re-running `/harmony-conduct <umbrella>` reconstitutes from the ticket
  row — if the B-471 roll-up has since advanced the parent to Released, the loop resumes at the verify hard
  floor; to Verified → reports terminal; still Decomposed-with-children → re-renders the umbrella report. The
  conductor never auto-advances it (dial-independent — no decision to delegate).

Everything else is a **pause**, not an end: the loop is always resumable from the ticket row. (The umbrella
report-and-stop above ends *the run* but is likewise resumable — it is a stop, not a dead end.)

## The controlled contract is intact (phase-2a guarantee)

Phases 2b + 2c are **strictly additive**. With **no flag**, this skill behaves *identically* to phase 2a:

- It does **not** auto-advance any gate (the delegation test returns "never" for `mode = controlled`).
- It does **not** synthesize any accept — every gate goes to the controlled pause (§4).
- It does **not** call `resolve_brief`, `record_decision`, or any write that makes a gate's decision — it
  delegates those to the owning gate skill, where the human's resolution lives.
- It does **not** edit code, commit, push, or merge — those are the build/release gate skills' jobs.
- The risk-class floor and the `--escalate` judgment only ever *add* a pause; with no flag there is nothing
  to add a pause to (controlled already pauses everywhere), so the no-flag run is byte-for-byte 2a.

Delegation is **opt-in per run**, **dial-capped**, and **floored**:

- It auto-advances a gate ONLY when the human passed an explicit `--pause-at`/`--unattended`/`--escalate`
  flag for this run, AND the workspace dial permits it (a `cautious` dial vetoes all delegation —
  `--escalate` included — announced).
- It NEVER crosses the hard floor: release (merge + deploy) and verify always surface for a human, even
  under `--unattended`/`--escalate`; one-way/irreversible decisions always require a human.
- It NEVER auto-advances a delegated gate whose `risk_classes` is non-empty (auth / data-migration /
  irreversible-destructive / shared-core) — the risk-class floor surfaces it for a human in EVERY
  delegating mode, at EVERY dial level, even when `--escalate` judged the gate routine; the pause names the
  class that tripped it.
- In `--escalate`, a gate the conductor judges genuinely worth a human opinion surfaces (and resumes on the
  next flagged re-run); a gate judged routine (and floor-clean) is decide-and-recorded with no pause.
- An auto-advanced / decide-and-recorded gate records the SAME Accepted decision a controlled run would —
  only the human pause is skipped, via the owning gate skill's existing accept path (no new write path for
  `--escalate`).
- An unknown/misspelled flag, an unknown `--pause-at` gate, or more than one delegating flag together, is
  an ERROR — never a silent delegation.

Browser auto-pickup (B-485) is **orthogonal and equally non-decisional**:

- It is the **default at each pause** (B-500 — the conductor auto-watches without asking and without
  requiring a re-run) and **session-held** (D4 — no background daemon). The watch is **bounded (~90 min, idle
  backoff)** and ends on **any** of three co-equal exits — a browser resolution, an in-session/terminal
  answer, or the ~90-min timeout; on timeout it degrades to today's persist-and-resume.
- It **never makes a decision the human didn't make.** It consumes only the human's *actual* browser verb
  (Accept / Reshape / Deny) and routes it through the same owning-gate-skill path a same-session answer
  takes. Accept ≠ synthesized — it is the human's, just submitted from the browser.
- A reshape runs the LLM `iterate` (re-compose in place, iteration+1, ball back to 'Needs human') — it is
  **not** an accept and advances no state; the iterate loop closes through the browser.
- **Hard floor unchanged:** release/verify are consumed ONLY from a human-submitted browser resolution,
  never conductor-synthesized; their side effects (merge+deploy, prod-observe) run in the running session
  via `finish-work`.
- It is **orthogonal to the `--pause-at`/`--unattended` selector** — auto-pickup changes *where* the human
  answers a controlled gate, not *whether* a gate is controlled.

## Still out of scope (later phases)

- **Quantitative risk *score* / circuit-breaker tuning** (B-458 phase 2d and beyond): the floor here is a
  deterministic, binary class detector (`detectRiskClasses` in `src/tools/risk-class.ts`) — present/absent
  per class, conservative by design. The conductor does not compute a numeric risk score, learn a
  threshold, or trip a rate-limit-style circuit-breaker. The hard floor, the dial ceiling, the risk-class
  floor, and the `--escalate` judgment are the guards in 2c.
- **Skills reading the dial generally** (F5 / B-355): the dial mirror here exists for the conductor's
  cautious kill-switch; a shared/db-driven trust source replaces the hand-maintained mirror in
  `src/tools/trust-model.ts` (see its drift-sync note) later.
