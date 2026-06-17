---
name: harmony-conduct
description: Drive one ticket through the gate sequence end to end. Default = pause at every gate for the human's decision (controlled). Optional per-run delegation — `--pause-at <gate>` (auto-advance up to a gate) or `--unattended` (auto-advance to the hard floor). Triggers on "conduct B-123", "harmony conduct", "run B-123 through the flow", "drive this ticket to verified". The conductor orchestrates the plumbing BETWEEN gates; at a controlled gate it hands the decision to the human, and an auto-advanced gate still records the SAME Accepted decision a controlled run would.
allowed-tools: mcp__harmony__* Read Grep Glob
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Conduct (conductor — B-458 phase 2a controlled core + B-489 phase 2b autonomy selector)

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
never crosses the hard floor (release + verify stay human).

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
   are NEVER auto-resolved by the conductor. Even `--unattended` pauses at release and at verify. One-way /
   irreversible decisions always surface for a human.
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

**The per-run mode (controlled / `--pause-at <gate>` / `--unattended`) is the ONE piece of run-scoped
intent the ticket row does NOT carry** — it is supplied by the human's invocation each time. On a re-run
without a flag the conductor is controlled again (the safe default); to resume an unattended/partial run
the human re-passes the flag. The conductor never persists a delegation choice — there is nowhere it could,
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

Validation (do this BEFORE touching the ticket):

- `--pause-at` and `--unattended` are **mutually exclusive**. If both are present → **ERROR** and stop.
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
  delegation. **Override the per-run mode to `controlled`** and **ANNOUNCE** it plainly, e.g.: *"This
  workspace's Agent-Trust dial is set to **cautious**, which forbids delegation — I'm ignoring
  `--unattended` and running B-123 fully controlled (pausing at every gate). Raise the dial to balanced or
  autonomous in workspace settings to allow per-run delegation."* Never silently drop the flag.
- **`agent_trust.level === 'balanced'` or `'autonomous'`**: the dial permits per-run forward delegation —
  honour the parsed `mode` as-is. (In v1 the dial does not further gate *which* forward gates may be
  delegated beyond the cautious kill-switch; the per-run flag governs that. release/verify stay human
  regardless of the level, so the dial's release/verify auto-advance classes are moot here.)

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

### 2. The loop

Repeat the following until a **TERMINAL** or **PAUSE** condition is reached (see *§5. Terminal conditions*):

1. **Re-read the ticket, then render the progress overview.** `mcp__harmony__get_task({ task_id })` at the
   TOP of every iteration — never trust a cached copy. Read `(workflow_state, workflow_activity,
   awaiting_human_input, awaiting_human_reason, awaiting_human_ref, stale)`. **Immediately after the
   re-read, regenerate and render the progress overview from the ticket row** (see *The progress overview*
   below). This happens on **every** iteration so the checklist always reflects the just-read state.

2. **If the ticket is already awaiting a human decision → handle per mode.** If `awaiting_human_input`
   is set, a gate has already drafted a brief. There is one active brief per task, so do **NOT** run
   another gate on top of it. Decide whether this gate is **delegated** or **controlled** for this run
   (see *The delegation test* below):
   - **Controlled gate** → go to *§4. Surface the brief + pause*. This is the resume case: a re-run that
     finds an unresolved brief at a controlled gate surfaces it and waits.
   - **Delegated (auto-advanced) gate** → go to *§4b. Auto-advance*: synthesize the human's accept and
     route it to the owning gate skill's accept path, then continue the loop. NEVER auto-advance a
     release/verify gate (hard floor) — those always fall to *§4. Surface the brief + pause* regardless of
     mode.

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

5. **Otherwise, determine the next forward activity and RUN it** by delegating to the owning gate skill
   (state→activity map below). The gate skill queries knowledge, drafts the decision, and `compose_brief`s
   — setting `awaiting_human_input`. Then the loop re-reads at step 1, lands in step 2 (now awaiting), and
   either pauses (controlled gate) or auto-advances (delegated gate). *(Side-effecting note: the gate
   skills' accept paths carry the side effects — `harmony-decompose` creates children on accept,
   `finish-work` does the merge/deploy on accept. In a controlled run those happen at the human's accept;
   in a delegated run the conductor synthesizes the accept and the gate skill performs the same side
   effects — see §4b.)*

### The delegation test — is THIS gate auto-advanced for this run?

Map the just-read `workflow_state` to its **phase** (clarify/decompose/design/plan/build/release/verify;
use the phase map in *The progress overview*). Then, given the effective `mode`:

| effective `mode` | a gate is **auto-advanced** iff … |
|---|---|
| `controlled` | never — every gate is controlled (pause) |
| `partial` (`pauseAt = G`) | the gate's phase is **strictly before** `G` in lifecycle order — AND the phase is not release/verify |
| `unattended` | the gate's phase is a forward gate (clarify/decompose/design/plan/build) — i.e. **not** release/verify |

**The hard floor wins over everything:** release and verify are NEVER auto-advanced, in any mode. If the
delegation test above would select a release/verify gate (e.g. `--pause-at` set past them, or
`--unattended`), it is still controlled — surface and pause (§4). `stale` is likewise never auto-advanced
(step 3), and a `Captured` ticket always self-advances `promoting` as plumbing (step 4), not via this test.

Lifecycle order for "strictly before": `clarify < decompose < design < plan < build < release < verify`.

### 4b. Auto-advance a delegated gate — synthesize the human's accept

When the delegation test selects a gate (and it is past the floor), the conductor **synthesizes the
human's "accept"** for that brief and routes it to the owning gate skill's accept path — the *same routing*
the controlled flow uses when the human types "accept" in-session (§controlled pause's "If the human
answers in this same session"). It does **not** invent a new write path:

- **Pure gates** — clarify (`brief-review`), design (`*-design-decision` per sub-track), plan
  (`plan-draft`): the accept is the gate skill's `resolve_brief({ decision: 'accept', … })`. Routing to the
  owning gate skill's accept path (NOT a raw conductor `resolve_brief`) ensures the gate skill records its
  Accepted knowledge decision and runs its own completion logic.
- **Side-effecting DECOMPOSE** (`decomposition-proposal`): the accept is `harmony-decompose`'s
  **child-creating accept path**, NOT a bare `resolve_brief` — children must be created first (the gate
  skill owns that). Synthesize the accept by routing to `harmony-decompose`'s accept (the same path a human
  "accept" takes), so the children are created and the parent advances.
- **release / verify**: **NEVER** auto-resolved. (Unreachable here — the delegation test excludes them; the
  floor is the backstop.)

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
| Decomposed | designing | `/harmony-plugin:harmony-design-decide <ticket> --track <sub-track>` | pure per sub-track; serialized (one brief at a time) |
| Designed | planning | `/harmony-plugin:start-work <ticket>` | pure (accept = `resolve_brief`; the accept is "go" to build) |
| Planned | building | `/harmony-plugin:start-work <ticket>` | build work, then files `release-decision-pending` |
| Built | releasing | `/harmony-plugin:finish-work <ticket>` | side-effecting (accept → merge+deploy) — **HARD FLOOR, always human** |
| Released | verifying | `/harmony-plugin:finish-work <ticket>` (verify step) | side-effecting (observe prod); also the PR-less umbrella path — **HARD FLOOR, always human** |
| Verified | — | (none) | TERMINAL — loop ends |
| Parked / Cancelled | — | (none) | TERMINAL — loop ends |

**Designing is multi-sub-track and serialized.** `harmony-design-decide` runs ONE sub-track per
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

**Annotate the delegation plan (informational).** When the effective mode is `partial` or `unattended`,
you may annotate each phase item's text with whether it will be **auto-advanced** or **paused** under the
current mode (e.g. "design — auto-advance", "release — pause (you decide)"), derived from the delegation
test + the hard floor. This is purely informational — it never drives a decision and never substitutes for
the controlled pause; it just makes the run's plan legible. Derive it fresh from `mode` each iteration; do
not store it.

This checklist is purely informational — it never drives a decision and never substitutes for the
brief-surface pause. It is regenerated, not mutated, so it can never disagree with the ticket row.

### 3. One step per iteration — auto-advance continues, a controlled gate pauses

After delegating to a gate skill, the loop re-reads at step 1 and the delegation test decides:
- a **controlled** gate → the gate has composed a brief and set `awaiting_human_input`; the ball is now in
  the human's court → §4 (pause).
- a **delegated** gate → §4b (synthesize accept, continue looping).

The controlled flow's forward motion is gated on the human resolving each brief; that is contract item 1.
The delegated flow's forward motion is the conductor synthesizing the accept the human authorized via the
per-run flag (contract item 2) — never crossing the hard floor (contract item 3).

### 4. Surface the brief + pause for the human's decision (controlled gate, or the hard floor)

This is the **controlled pause** — reached at every gate in controlled mode, at `pauseAt` and after in
partial mode, and ALWAYS at release + verify (the hard floor) and at a `stale` patch, in every mode.

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
state, **resume the loop at step 2** (re-read the ticket, run the next gate). If the human steps away, the
loop is paused; a later `/harmony-plugin:harmony-conduct B-123` resumes from the ticket row (re-pass the
flag to resume a partial/unattended run; absent a flag the resumed run is controlled).

### 5. Terminal conditions — when the loop ends (not pauses)

The loop **ends** (does not pause for resume) when, after re-reading the ticket at step 2:

- `workflow_state === 'Verified'` → done. Report: *"B-123 is Verified — conducted from <start state> to
  Verified."* (Even an unattended run reaches Verified only after the human resolved release + verify.)
- `workflow_state === 'Parked'` or `'Cancelled'` → the human deferred/cancelled at a gate. Report where it
  parked and why, and stop. (A deferral authored its own `deferral` knowledge entry via the gate skill —
  the conductor does not author it. Note: a deferral only ever happens at a controlled pause — the
  conductor's synthesized accept never defers.)

Everything else is a **pause**, not an end: the loop is always resumable from the ticket row.

## The controlled contract is intact (phase-2a guarantee)

Phase 2b is **strictly additive**. With **no flag**, this skill behaves *identically* to phase 2a:

- It does **not** auto-advance any gate (the delegation test returns "never" for `mode = controlled`).
- It does **not** synthesize any accept — every gate goes to the controlled pause (§4).
- It does **not** call `resolve_brief`, `record_decision`, or any write that makes a gate's decision — it
  delegates those to the owning gate skill, where the human's resolution lives.
- It does **not** edit code, commit, push, or merge — those are the build/release gate skills' jobs.

Delegation is **opt-in per run** and **dial-capped**:

- It auto-advances a gate ONLY when the human passed an explicit `--pause-at`/`--unattended` flag for this
  run, AND the workspace dial permits it (a `cautious` dial vetoes all delegation, announced).
- It NEVER crosses the hard floor: release (merge + deploy) and verify always surface for a human, even
  unattended; one-way/irreversible decisions always require a human.
- An auto-advanced gate records the SAME Accepted decision a controlled run would — only the human pause is
  skipped, via the owning gate skill's existing accept path.
- An unknown/misspelled `--pause-at` gate, or both flags together, is an ERROR — never a silent delegation.

## Still out of scope (later phases)

- **Circuit-breaker / risk signal** (B-458 phases 2c/2d): the conductor does not compute a risk score or
  raise a circuit-breaker. The hard floor + the dial ceiling are the only guards in 2b.
- **Skills reading the dial generally** (F5 / B-355): the dial mirror here exists for the conductor's
  cautious kill-switch; a shared/db-driven trust source replaces the hand-maintained mirror in
  `src/tools/trust-model.ts` (see its drift-sync note) later.
