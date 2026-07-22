---
name: harmony-conduct
description: The opinionated-mode entry point: drive one ticket through the gate sequence end to end. Default = pause at every gate for the human's decision (controlled). Optional per-run delegation — `--pause-at <gate>` (auto-advance up to a gate), `--unattended` (auto-advance to the hard floor), or `--escalate` (auto-advance, but surface any gate genuinely worth a human opinion). A non-discretionary risk-class FLOOR (auth / data-migration / irreversible-destructive / shared-core) PAUSES a delegated gate for a human in `--escalate`; in `--unattended` and the auto-advanced prefix of `--pause-at` it does NOT pause mid-run — it is recorded and SURFACED on the release brief (the hard floor at release+verify already covers irreversibility). Triggers on "conduct B-123", "harmony conduct", "run B-123 through the flow", "drive this ticket to verified". The conductor orchestrates the plumbing BETWEEN gates; at a controlled gate it hands the decision to the human, and an auto-advanced gate still records the SAME Accepted decision a controlled run would. `--one-shot` (the daemon's worker flag, orthogonal to the mode selector) advances one leg and exits at the next human pause WITHOUT arming the watch — the daemon owns watching.
allowed-tools: mcp__harmony__* Read Grep Glob
disallowed-tools: Write Edit NotebookEdit Bash(git commit *) Bash(git push *) Bash(git merge *)
---

# Harmony Conduct (conductor — B-458 phase 2a controlled core + B-489 phase 2b autonomy selector + B-485 browser auto-pickup + B-493 phase 2c risk-class floor & --escalate + B-500 auto-watch by default + B-506 Decomposed split-umbrella branch + B-519 revise-scope / back-up + B-516 floor scoping: pause only in --escalate, release-brief signal otherwise + B-693 --one-shot worker exit)

The conductor loop. Given a ticket and a "go", it drives the whole gate sequence
(clarify → decompose → design → plan → build → release → verify) by delegating to the existing gate
skills **in lifecycle order**, automating the drudgery of hand-invoking `/harmony-plugin:harmony-next`
at each step into one continuous loop.

`harmony-conduct` is the **generalization of `harmony-next`** (agent-model §5): instead of pulling one
awaiting item and stopping, it loops over the forward path. The **controlled** route (the default, no
flag) is **not** a new decision surface — every gate still drafts and `compose_brief`s exactly as today,
and the human still answers through the existing brief surface (web UI Accept/Defer/feedback, or the gate
skill's accept/edit/iterate/`discuss <remark>` — B-461). Phase 2b adds an **opt-in per-run delegation selector** that lets the human
hand specific *early* gates to the conductor for the run; it does not change the controlled default and it
never crosses the hard floor (release + verify stay human). Phase 2c (B-493) adds two things on top: a
**non-discretionary risk-class FLOOR** that flags *any* delegated gate whose subject touches a
high-consequence class (auth / data-migration / irreversible-destructive / shared-core), and a 4th mode,
**`--escalate`**, which auto-advances like `--unattended` but **surfaces any gate the conductor judges
genuinely worth a human opinion**. Phase B-516 **scopes the floor's pause**: the floor **PAUSES a delegated
gate only in `--escalate`**; in `--unattended` and the auto-advanced prefix of `--pause-at` a non-empty
`risk_classes` does **NOT** pause mid-run — it is **recorded and surfaced on the release brief** instead.
The rationale: nothing executes irreversibly before release, and the **hard floor (release + verify)
already covers irreversibility** — a mid-run floor pause would override the human's explicit `--unattended`
control choice for no safety gain. Neither weakens the controlled default or the hard floor.

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
   **release** gate (merge + deploy: one-way, irreversible) and the **verify** gate (Deployed→Verified) —
   are NEVER auto-resolved by the conductor. Even `--unattended`/`--escalate` pause at release and at
   verify. One-way / irreversible decisions always surface for a human.
3a. **The RISK-CLASS FLOOR is non-discretionary and dial-independent — and B-516 scopes WHERE it pauses.**
   Before auto-advancing ANY delegated gate, the conductor reads `risk_classes` from `get_task` (a
   deterministic, conservative detector — auth / data-migration / irreversible-destructive / shared-core —
   over the ticket text + active brief, and over changed paths when known). What a non-empty `risk_classes`
   does depends on the mode:
   - **In `--escalate`:** the conductor **surfaces the gate + PAUSES + ANNOUNCES which class tripped it** —
     non-discretionarily, regardless of the dial level or any `--escalate` judgment that the gate is
     "routine". The floor sits **underneath** the `--escalate` judgment (it pauses a gate the judgment would
     call routine). This is the floor's original B-493 pause behaviour, and it is preserved unchanged for
     `--escalate`.
   - **In `--unattended` and the auto-advanced prefix of `--pause-at`:** a non-empty `risk_classes` does
     **NOT** pause the run mid-flight (**no exceptions — not even `irreversible-destructive`**). The
     conductor **records** the classes and **surfaces them on the release brief** (§4's release-brief signal)
     so the human sees them at the hard floor. *Rationale (B-516):* nothing executes irreversibly before
     release; the **hard floor at release + verify already floors irreversibility for a human**, so a mid-run
     floor pause here adds no safety and overrides the human's explicit `--unattended` control choice. The
     human chose to auto-advance the forward gates; the floor's job is done by carrying the signal to the
     release decision they already retained.

   The floor is still **additive and never removes a pause** — it does not change the controlled default
   (controlled already pauses everywhere) or the hard floor. It is computed identically in every mode (from
   `risk_classes`, recomputed each re-read); only the *response* differs: pause in `--escalate`, release-brief
   signal in `--unattended`/`--pause-at`.
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
  `clarify`, `decompose`, `design`, `plan`, `build`, `release`, `verify`. (In the auto-advanced *prefix*, a
  risk-class hit does **not** pause — it is recorded and surfaced on the release brief, §3a/§4. At `<gate>`
  and after, every gate is controlled anyway.)
- **`--unattended`** → `mode = unattended`. Auto-advance every forward gate up to the hard floor (pause at
  release and at verify). A risk-class hit on a forward gate does **not** pause the run mid-flight (B-516);
  it is recorded and surfaced on the release brief so the human sees it at the hard floor.
- **`--escalate`** → `mode = escalate` (B-493, phase 2c). Auto-advance like `--unattended` (every forward
  gate up to the hard floor), **except** that before auto-advancing a forward gate the conductor forms a
  qualitative *"is this gate genuinely worth a human opinion?"* judgment over the gate's drafted brief
  (see *The escalate judgment* below). Worth it → surface + pause (the gate reverts to controlled for this
  run); not worth it → decide-and-record via the owning gate skill's accept path (the same write
  `--unattended` uses). The risk-class floor (§3a) sits **underneath** the judgment: a risk-class hit
  floors a gate even when the judgment says "routine".

**Orthogonal to the mode selector — `--one-shot` (B-693, the daemon's worker flag).** Alongside the mode
(any of the above, or no flag), the invocation may carry **`--one-shot`**: advance one leg — run to the
next human-required pause — then **exit without arming the §4c watch** (the Conductor Daemon owns
watching; see the daemon spec §4.1 / B-696). It is **NOT a fifth mode**: it changes what happens **AT** a
human pause (exit vs arm-and-wait), never **WHICH** gates pause — the run behaves gate-for-gate with
**identical gate behaviour** to the same invocation without the flag, so "one leg" is mode-dependent by
construction: one gate in controlled, up to the hard floor under `--unattended`. It is never implied — a
daemon-fired worker passes it explicitly. The suppression itself lives at §4c's step-0 guard (the sole
poll.js spawn site); what the exit leaves behind is *The one-shot exit contract* (after §4c).

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
- **`--one-shot` is exempt from the mutual-exclusivity rule** (it is not a mode — it composes with any
  mode or none), but it gets the same misspelling strictness: `--oneshot`, `--one-sht`, etc. → **ERROR**
  and stop, never a silent ignore.

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
  moot here. The risk-class floor (§3a) is computed under *all* permitted modes and at every level — it
  PAUSES in `--escalate` and is carried to the release brief in `--unattended`/`--pause-at`, B-516.)

A ticket id is **required** — `/harmony-plugin:harmony-conduct B-123 [--pause-at <gate> | --unattended | --escalate] [--one-shot]`.
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
  at **release** (merge + deploy) and **verify** for your decision, which always require a human. If a
  forward gate touches a risk class (auth / data-migration / irreversible/destructive / shared-core) I won't
  stop mid-run — I'll carry it onto the release brief so you see it at the release gate."*
- escalate: *"Conducting B-123 from <state> with `--escalate` — auto-advancing forward gates, but pausing
  on any gate I judge genuinely worth your opinion, on any gate that trips the risk-class floor (auth /
  data-migration / irreversible-destructive / shared-core), and always at **release** and **verify**.
  (Auto-advanced gates still record their decision as Accepted.)"*

Note the floor's behaviour once up front, matched to the mode: in **`--escalate`** say *"I'll also pause —
regardless of judgment — on any gate whose subject touches auth, a data migration, an irreversible/destructive
change, or a shared-core module."*; in **`--unattended`/`--pause-at`** say *"A risk class on a forward gate
won't stop the run — I'll surface it on the release brief so you review it at the hard floor."*

When the run carries **`--one-shot`**, append the worker notice to the report: *"One-shot: I'll exit at
the first human pause instead of watching — the daemon (or you) re-fires the next leg."*

### 2. The loop

Repeat the following until a **TERMINAL** or **PAUSE** condition is reached (see *§5. Terminal conditions*):

1. **Re-read the ticket, then render the progress overview.** `mcp__harmony__get_task({ task_id, view:
   'meta' })` at the TOP of every iteration — never trust a cached copy. Read `(workflow_state,
   workflow_activity, awaiting_human_input, awaiting_human_reason, awaiting_human_ref, stale)`. **Lean
   re-read discipline (B-684):** the FIRST pickup of a run (the initial §1 read) and the VERIFY gate
   always fetch FULL; every subsequent step-1 re-read and post-mutation confirm goes lean (`view:
   'meta'`) — and REFETCH FULL when `content_updated_at` has moved past the last full read.
   (`content_updated_at` bumps on tasks-row content edits — title, description, status, priority,
   assignee, epic/cycle/milestone, due_date, archived, field_values — but NOT on gate advances and NOT
   on acceptance-criteria/test-case/checklist/label edits, which live in separate tables; that is safe
   because the AC/test consumers — the gate skills — always do their own full/dedicated reads. It is
   deliberately NOT keyed on `updated_at`, which moves on every advance and would force a full read at
   every gate.) **Immediately after the
   re-read, regenerate and render the progress overview from the ticket row** (see *The progress overview*
   below). This happens on **every** iteration so the checklist always reflects the just-read state.

2. **If the ticket is already awaiting a human decision → handle per mode.** First check the reason:

   **`awaiting_human_reason === 'elicitation-round'` → NOT a brief, NOT a gate decision — ALWAYS wait
   (B-462).** An elicitation exchange has the ball with the human (questions filed by a gate skill via
   the B-645 engine). **Elicitation pauses are ORTHOGONAL to delegation:** there is no brief to accept
   and nothing to synthesize — the round's answers exist only in the human's head, so NO mode
   (`--pause-at`, `--unattended`, `--escalate`) auto-advances past an open exchange; delegation covers
   decisions, never the human's answers. Surface the round (render the last round from
   `get_elicitation` as prose, per the owning gate skill's terminal parity), then **arm the §4c watch
   and end the turn** exactly as at a controlled pause (in `--one-shot`, §4c's step-0 guard exits the
   run here instead of arming — same surface, no watch). The poll classifies a web submit as
   **`answers-landed`** (consume case 4 below); a terminal answer is a normal in-session exit.

   Otherwise `awaiting_human_input` set means a gate has already drafted a brief. There is one active
   brief per task, so do **NOT** run another gate on top of it. Run *The delegation test* below — which checks, in order, the cautious
   kill-switch, the hard floor (release/verify), the **`--escalate` risk-class floor** (`risk_classes`
   non-empty, in `--escalate` only — B-516), the `--escalate` judgment, and finally the mode table — to
   decide whether this gate is **delegated (auto-advanced)** or **controlled (pause)** for this run. When
   `risk_classes` is non-empty on an auto-advanced gate, **record the classes for the release-brief signal**
   (§4's release-brief signal) regardless of mode:
   - **Controlled / `--escalate`-floored / escalate-surfaced gate** → go to *§4. Surface the brief + pause*.
     This covers the resume case (a re-run that finds an unresolved brief at a controlled gate), a gate the
     risk-class floor tripped **in `--escalate`**, and a gate the `--escalate` judgment flagged as worth a
     human opinion.
   - **Delegated (auto-advanced) gate** → go to *§4b. Auto-advance*: synthesize the human's accept and
     route it to the owning gate skill's accept path, then continue the loop. NEVER auto-advance a
     release/verify gate (hard floor) — it always falls to *§4. Surface the brief + pause* regardless of mode
     or dial. A non-empty `risk_classes` on a forward gate is auto-advanced in `--unattended`/`--pause-at`
     (its classes recorded for the release brief), and floored to *§4* only in `--escalate`.

3. **If the ticket is `stale` → PAUSE and route to the patch author.** A superseded knowledge decision
   has put the ticket out of sync (state-machine §6.4). This is a human decision, not a forward gate, and
   it is **never** auto-advanced (not on the forward path, not gated by the per-run flag). Delegate to
   `/harmony-plugin:harmony-stale-patch <ticket>` (it drafts the `stale-patch-review` brief), then surface
   it and pause (*§4. Surface the brief + pause*) — exactly as `harmony-next` does. The loop does not
   advance a Stale ticket past the patch decision, even unattended.

4. **If `workflow_state === 'Captured'` → auto-advance `proposing` (plumbing, NOT a pause), then loop
   again.** A freshly-created ticket lands in `Captured` (the post-B-474 inbox state). `proposing`
   (Captured→Proposed) is a **brief-less AGENT/SYSTEM transition** with no human decision attached — and in the
   conductor, *choosing to conduct this ticket IS the promote decision* (the human named it; they've
   already decided it's worth pursuing). So the conductor advances it itself, with **no brief and no
   pause**: `mcp__harmony__advance_workflow({ task_id, activity: 'proposing' })` (Captured→Proposed). Then go
   back to step 1 (re-read) — the ticket is now `Proposed` and the next iteration runs the clarify gate.
   **Do NOT** try to file a `clarifying` brief from `Captured` — the transition table only allows
   `('Captured','proposing','Proposed')` then `('Proposed','clarifying','Clarified')`, so `compose_brief` with
   `pending_activity: 'clarifying'` would hard-error from `Captured`. (This is the one self-advance the
   conductor makes regardless of mode; it advances no *human* decision — contrast `harmony-next`, which
   **surfaces** proposing as a human triage decision because it pulls un-triaged queue items, see
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
     Decomposed→Deployed, and finish-work's no-PR verify path (the `umbrella-auto-verify` null-brief
     handling, §4) carries Deployed→Verified with a human ack. Tell the human to **conduct the children** to
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
   NEVER auto-advanced, in any mode — surface and pause (§4). **Decision-only extension (B-681):** the
   **deliverable gate of a `decision-only`-labelled ticket** (clarify for a capture-only ticket; the LAST
   design sub-track for a decision ticket) is that ticket's release+verify **collapsed into one** — its
   accept completes the ticket to Verified via the fast-forward — so it inherits this same hard floor:
   NEVER auto-advanced, in any mode. (The label is read from the gate skill's own full `get_task`; see
   `skills/harmony-shared/gate-routing.md` §The decision-only fast-forward.)
3. **Risk-class FLOOR (contract 3a — NON-DISCRETIONARY in `--escalate`, RELEASE-BRIEF SIGNAL otherwise — B-516).**
   Read `risk_classes` from the `get_task` of step-1 (the conductor already re-read the ticket). If it is
   **non-empty**:
   - **In `mode = escalate`:** the gate is **floored** — surface and pause (§4), regardless of the dial level
     and regardless of any `--escalate` judgment (step 4) that the gate is routine. ANNOUNCE which class(es)
     tripped it (§4 includes the wording). The floor sits ABOVE the `--escalate` judgment (step 4) and the
     mode table (step 5), and BELOW the hard floor.
   - **In `mode = unattended` or `partial` (auto-advanced prefix):** the gate is **NOT** floored — it
     auto-advances per the mode table (step 5). **No exceptions — not even `irreversible-destructive`.**
     Instead, **record the tripped classes** (merge them into the run's accumulated risk set) so §4's
     release-brief signal surfaces them at the hard floor. *Rationale (B-516):* nothing executes irreversibly
     before release; the hard floor already floors irreversibility for a human, so a mid-run pause here adds
     no safety and would override the human's explicit `--unattended` control choice.

   It is still additive — it never grants an auto-advance the mode wouldn't, and it never removes the hard
   floor's pause; B-516 only narrows *which mode* it pauses.
4. **`--escalate` judgment (only in `mode = escalate`, B-493).** If the effective mode is `escalate` and the
   gate survived steps 1–3 (not floored), form the qualitative *"is this gate genuinely worth a human
   opinion?"* judgment over the gate's drafted brief (see *The escalate judgment* below). **Worth it →
   surface and pause (§4)** (revert this gate to controlled for the run). **Not worth it → auto-advance**
   (fall through to step 5's decide-and-record). In any other mode this step is skipped.
5. **Mode-delegation branch.** Given the effective `mode`, the gate auto-advances iff:

| effective `mode` | a gate auto-advances iff … |
|---|---|
| `controlled` | never — every gate is controlled (pause) |
| `partial` (`pauseAt = G`) | the gate's phase is **strictly before** `G` in lifecycle order — AND the phase is not release/verify (survived step 2). A risk-class hit does **not** pause it (step 3 records it for the release brief instead) |
| `unattended` | the gate's phase is a forward gate (clarify/decompose/design/plan/build) — i.e. **not** release/verify (survived step 2). A risk-class hit does **not** pause it (step 3 records it for the release brief instead) |
| `escalate` | the gate's phase is a forward gate — AND it survived steps 3–4 (NOT risk-class-floored AND judged routine in step 4) |

**The hard floor wins over everything:** release and verify are NEVER auto-advanced, in any mode (step 2).
The **risk-class floor pauses a delegated gate ONLY in `--escalate`** (step 3) — there it beats the mode
table and the escalate judgment; in `--unattended`/`--pause-at` it does not pause but is carried to the
release brief. `stale` is likewise never auto-advanced (loop step 3), and a `Captured` ticket always
self-advances `proposing` as plumbing (loop step 4), not via this test.

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

When the delegation test selects a gate to **auto-advance** (it survived the hard floor; in `--escalate` it
was not risk-class-floored and was judged routine; in `--unattended`/`--pause-at` it auto-advances even with
a non-empty `risk_classes`, whose classes are recorded for the release brief — B-516), the conductor
**synthesizes the human's "accept"** for that brief and routes it to the owning gate skill's accept path —
the *same routing* the controlled flow uses when the human types "accept" in-session (§controlled pause's
"If the human answers in this same session"). It is the SAME write in every delegating mode (`--pause-at`,
`--unattended`, `--escalate`'s decide-and-record) — `--escalate` does **not** introduce a new accept path; it
only adds a *pause* decision in front of this one. It does **not** invent a new write path:

- **Pure gates** — design (`*-design-decision` per sub-track), plan
  (`plan-draft`): the accept is the gate skill's `resolve_brief({ decision: 'accept', … })`. Routing to the
  owning gate skill's accept path (NOT a raw conductor `resolve_brief`) ensures the gate skill records its
  Accepted knowledge decision and runs its own completion logic.
- **Side-effecting CLARIFY** (`brief-review`, B-648): clarify's accept **files the happy-path ACs**
  (`manage_acceptance_criteria`, idempotent) **before** `resolve_brief`. Synthesize the accept by routing
  to `harmony-clarify`'s accept path exactly as decompose routes through `harmony-decompose`'s, so the ACs
  land on the ticket as part of the accept.
- **Side-effecting DECOMPOSE** (`decomposition-proposal`): the accept is `harmony-decompose`'s
  **child-creating accept path**, NOT a bare `resolve_brief` — children must be created first (the gate
  skill owns that). Synthesize the accept by routing to `harmony-decompose`'s accept (the same path a human
  "accept" takes), so the children are created and the parent advances.
- **release / verify**: **NEVER** auto-resolved. (Unreachable here — the delegation test excludes them; the
  hard floor is the backstop.) A gate with non-empty `risk_classes` **does** reach §4b in
  `--unattended`/`--pause-at` (it auto-advances — its classes are recorded for the release-brief signal, §4);
  only in `--escalate` does the risk-class floor (delegation test step 3) send it to §4 first instead.

**Parity invariant (AC5):** an auto-advanced gate records the **SAME Accepted knowledge** a controlled run
would. Auto-advance only skips the human *pause* — it does not skip the *decision record*. Because the
conductor reuses the owning gate skill's accept path (the human's exact routing), the Accepted knowledge
entry, state transition, and side effects are identical to a human-accepted controlled run. If a gate skill
would NOT record a decision on a plain human accept, neither does its auto-advance — the contract is
"identical to a human accept, minus the pause", nothing more.

After the synthesized accept, briefly note it for the human's audit trail, e.g.: *"Auto-advanced the
**<gate>** gate (accepted on your behalf per `--unattended`); recorded its decision. Continuing…"* Then
**resume the loop at step 1** (re-read the ticket; the gate skill has advanced the state). Do not pause.

**Build evidence lands as part of the build/release/verify accept side-effects (B-560).** Just as a gate
skill's accept records its Accepted knowledge, the build/release/verify gates LAND build evidence on the
ticket as part of their accept: `start-work` records test cases + checks the satisfied ACs at build,
`finish-work` comments the PR→merge→deploy trail at release and the verify result at verify, and the verify
brief ALWAYS carries a mechanical evidence-status line from `get_build_evidence_status` (like the §4
release-brief risk signal). This holds identically whether the gate was controlled or auto-advanced — see
those gate skills and `skills/harmony-shared/gate-routing.md`. (A split-umbrella roll-up is exempt: its
evidence is carried by its children.)

**Out-of-scope items surfaced during the run are NOT auto-minted — and NOT left as notes (B-585, B-641).** A
conduct run surfaces adjacent bugs, refactors, nice-to-haves and review nits that aren't in the ticket's
accepted scope. Do **NOT** reflexively mint a standalone ticket for each — that is the largest source of board
bloat. Force a disposition per `skills/harmony-shared/disposition-discipline.md`: fix-first if
trivial/in-scope/same-PR, else accumulate the item in the per-parent "Follow-ups rollup" (a **within-run
buffer**, tagged `do-now`/`defer-with-trigger`/`drop`). At the **release** gate (alongside the B-560 evidence
comments above) the main session **DRAINS** the buffer: every item resolves to exactly one of four terminal
outcomes — **fix-inline / fold-into-existing** (an AC / scope-item or `subsume_task`, **not a bare comment**)
**/ drop-with-reason / file-a-ticket** — nothing persists as a note; a `defer-with-trigger` becomes a fold or a
**low-priority backlog ticket with the trigger in its body**. Run **triage-and-consolidate** for fold-vs-file
(`find_related_tickets` → prefer **fold** (`subsume_task` into an existing/umbrella ticket) or **dedupe**,
minting only when genuinely novel), and **surface the drained buffer on the release brief** so the human can
**veto a drop or upgrade a fold to a file before verify** (drain → surface → verify).

**Cross-ticket completion audit at the release gate (B-643).** The same release drain also asks: *did this run's work complete another **open** ticket?* If so, the covering run reconciles it rather than leaving it open and stale — **subsume-if-complete / annotate-if-unsure** — surfaced on the release brief for the human to confirm at the hard-floor. This is the covering-run half of a write-then-honor loop whose other half lives in the clarify/design gates; the whole mechanism (including the `search_tasks` Verified-sibling check that bridges `find_related`'s Verified exclusion) is documented in `skills/harmony-shared/ticket-disposition.md` → **"Reconciling a ticket another run already finished."**

**Retiring a ticket at a disposal point — one convention (B-604).** When the run retires a ticket (as opposed
to dispositioning a surfaced *item*, above), the end-state is keyed on **does the work continue?** — see
`skills/harmony-shared/ticket-disposition.md`. In short: a **fold/dedup** → **Subsume** (`subsume_task`; keep
its `workflow_state`, never additionally Cancel); an **"obsolete, don't proceed" drop** → **cancel+archive**
(`advance_workflow` `cancelling` → `add_comment` with the reason → `update_task archived:true`, in that order —
never archive-only, never cancel-only); a **defer** stays **Parked** (a park is NOT a disposal). This is the
adjacent axis to the item-disposition discipline above.

### The state → activity map (the §6.1 forward path)

Branch on `workflow_state` to pick the next gate. **The canonical gate→owning-skill routing — which skill
owns each gate, whether accept is pure or side-effecting, and where the hard floor sits — lives in
`skills/harmony-shared/gate-routing.md`. Consult it; do not restate it here.** The conductor reads that
table keyed by `workflow_state` (walking forward one state at a time); `harmony-next` reads the same table
keyed by `awaiting_human_reason` (resolving an existing brief). The forward path it walks: `Proposed` →
`Clarified` → `Decomposed` → `Designed` → `Planned` → `Built` → `Deployed` → `Verified`.

What is **conduct-specific** (NOT in the shared table — this is the conductor's *handling*, not the routing
facts; this is the deliberate other half of B-490's "same routing, opposite handling"):

| `workflow_state` | Conductor's handling |
|---|---|
| Captured | auto-advance `proposing` (Captured→Proposed) as **plumbing, not a pause** — see loop step 4 (the OPPOSITE of `harmony-next`, which surfaces proposing as a triage decision) |
| Decomposed **(split umbrella)** | **report-and-stop** — the children carry design/build; the B-471 roll-up completes the parent (loop step 5). NOT a forward gate |
| Decomposed **(no-split)** | run the **design** gate (owning skill per `gate-routing.md`); serialized per sub-track (see below) |
| Built / Deployed | the **release** / **verify** gates — **HARD FLOOR, always human** (gate-routing.md marks these); never auto-advanced |
| Verified / Parked / Cancelled | TERMINAL — loop ends |

**Decision-only tickets complete at their deliverable gate (B-681).** When the ticket carries the
`decision-only` label, the walk above ENDS at the deliverable gate: the clarify accept (capture-only) or
the last design sub-track's accept (decision ticket) carries an explicit completion line and — on the
human's accept — the owning gate skill runs the trailing `advance_workflow('fast-forwarding')`
(Clarified→Verified / Designed→Verified). The conductor never routes such a ticket to plan/build/release;
the loop's next re-read finds it Verified (TERMINAL). That deliverable gate inherits the hard floor
(delegation test step 2) — never auto-advanced. Until the deliverable gate, the marker changes nothing.
The decided thing stays `realization='agreed'` (B-677 flips it when built); evidence is exempt
(`get_build_evidence_status.exempt_reason = 'decision-only'`).

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

- **Plan gate (B-585):** before accepting a plan that rests on a load-bearing integration / auth / cross-surface
  assumption, confirm it was **de-risked by running** — not just read through — per `harmony-design-decide` §5a.
- **Build gate (B-585):** a build scoped *relative to* "how it works today" (a fix/refinement, or a
  `CREATE OR REPLACE` of a redefined DB object) must **verify the base** against the current code before building,
  per `start-work` O3.

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
| Captured / Proposed | clarify |
| Clarified | decompose |
| Decomposed | design |
| Designed | plan |
| Planned | build |
| Built | release |
| Deployed | verify |
| Verified | — all `completed` (terminal) |
| Parked / Cancelled | mark phases through the last-reached one `completed`, leave the rest `pending`; the run is terminal |

(`Captured` and `Proposed` both map to the `clarify` phase — a `Captured` ticket auto-advances `proposing` to
`Proposed` first, §"The loop" step 4, so the very next overview after the promote shows `clarify` as
`in_progress` exactly as it would from `Proposed`.) For **Verified**, mark every item `completed`. For
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

**Decision-only rendering (B-681).** For a ticket carrying the `decision-only` label, the phases past its
deliverable gate never run: render them as **"— skipped (decision-only fast-forward)"**. A capture-only
ticket skips decompose/design/plan/build/release/verify (its clarify accept completes it); a decision
ticket skips plan/build/release/verify (its last design sub-track's accept completes it). The deliverable
gate's item is the one to mark `in_progress`, annotated **"completes to Verified on accept"**. This stays a
cheap derived read: the label is already on the gate skill's full `get_task`.

**Annotate the delegation plan (informational).** When the effective mode is `partial`, `unattended`, or
`escalate`, you may annotate each phase item's text with whether it will be **auto-advanced** or **paused**
under the current mode (e.g. "design — auto-advance", "release — pause (you decide)"), derived from the
delegation test + the hard floor. For `escalate`, a forward gate is best annotated **"auto-advance unless I
judge it worth your opinion"** (the judgment is per-brief and not known until the gate drafts), and a phase
is annotated **"pause — risk-class floor"** if you already know it trips the floor. For
`unattended`/`partial`, a forward phase that trips the floor is annotated **"auto-advance — risk recorded for
the release brief"** (B-516: the floor does NOT pause here — it surfaces on the release brief). The floor and
the escalate judgment are both decided per-iteration from the just-read ticket (`risk_classes` + the drafted
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
per-run flag (contract item 2) — never crossing the hard floor (contract item 3), pausing on a
risk-class-floored gate **in `--escalate`** (contract item 3a; in `--unattended`/`--pause-at` the floor is a
release-brief signal, not a pause — B-516), and in `--escalate` also pausing on any gate it judges worth a
human opinion.

### 4. Surface the brief + pause for the human's decision (controlled gate, or the hard floor)

This is the **controlled pause** — reached at every gate in controlled mode, at `pauseAt` and after in
partial mode, at any gate the `--escalate` judgment deems worth your opinion, **at any `--escalate` gate the
risk-class floor tripped (§3a)**, ALWAYS at release + verify (the hard floor) and at a `stale` patch in
every mode. (In `--unattended`/`--pause-at` a risk-class hit does **not** reach this pause — it is recorded
and surfaced on the **release brief** instead, §3a/B-516; see *The release-brief risk signal* below.)

Surface the active brief so the human can decide:

- `mcp__harmony__get_brief({ task_id })` and display the rendered `content` blob **verbatim** in a fenced
  block (it is already BLUF-formatted and lint-clean — do not re-summarise it). Note `iteration` if > 1.
- **Null brief on a `verification-ack-pending` umbrella (B-471):** `get_brief` can be **null** when
  `awaiting_human_reason = 'verification-ack-pending'` and `awaiting_human_ref.kind ===
  'umbrella-auto-verify'` — the trigger-surfaced **PR-less umbrella** (a decomposed parent the DB trigger
  auto-advanced Decomposed→Deployed once all children reached Verified; it set the flag but composed no
  brief). Do **not** choke on the missing brief. The `verifying` gate already routes to
  `/harmony-plugin:finish-work <ticket>` (per the map), which composes the verification brief first and
  then surfaces it. Recognise the umbrella by the `umbrella-auto-verify` marker on `awaiting_human_ref`.

Then **STOP and tell the human the ball is in their court.** State plainly: which gate this is, the
one-line decision (`doc.decide`), and how to answer. For a hard-floor gate reached under a delegation flag,
say so explicitly —

> *"B-123 is at the **release** gate (merge + deploy). This always requires a human even under
> `--unattended` — it's a one-way, irreversible decision. Awaiting your decision: <doc.decide>. Accept /
> defer / give feedback in the web UI, or here."*

For a gate the **risk-class floor** tripped **in `--escalate`** (§3a), say so explicitly and **name the
class(es)** that tripped it (from `risk_classes`) — in `--escalate` this is non-discretionary and
dial-independent, so the human knows it was not the conductor's discretion —

> *"B-123 is at the **design** gate. Running `--escalate`, its subject touches **auth** (risk-class floor),
> so I'm surfacing it for you — in `--escalate`, risk-class hits always require a human regardless of dial or
> judgment. Awaiting your decision: <doc.decide>. Accept / defer / give feedback."*

(In `--unattended`/`--pause-at` the conductor does **not** pause here for a risk class — it auto-advances and
records the class for the release-brief signal below.)

For a gate the **`--escalate` judgment** flagged as worth your opinion, say which signal fired —

> *"B-123 is at the **design** gate. Running `--escalate`, I judged this one worth your eyes: the
> recommendation is low-confidence and the two alternatives are near-ties. Awaiting your decision:
> <doc.decide>. Accept / defer / give feedback. I'll keep watching — resolve here in the terminal or from the browser (Accept / Reshape / Deny) and I'll continue automatically."*

For an ordinary controlled gate —

> *"B-123 is at the **<gate>** gate, awaiting your decision: <doc.decide>. Accept / defer / give feedback
> in the web UI, or here. I'll keep watching — resolve here in the terminal or from the browser (Accept /
> Reshape / Deny) and I'll continue automatically."*

**The release-brief risk signal (B-516 — the `--unattended`/`--pause-at` floor outcome).** When the run
auto-advanced a forward gate whose `risk_classes` was non-empty (the floor did NOT pause it, §3a), the risk
is carried forward to the **release** gate rather than lost. At the **release** pause (always controlled — the
hard floor), `finish-work` composes the `release-decision-pending` brief and **computes a path-based risk
signal from the build's `changed_paths`** (`git diff --name-only origin/main...HEAD` over the PR, the high-precision
source — see finish-work O1) and adds it as an **attention line** on the brief, e.g.: *"⚠ Risk floor: this
change touches **auth + data-migration** — review accordingly."* Prefer the path-derived signal (precise)
over the accumulated prose set the conductor saw mid-run (the prose set may include down-weighted
false-positives; it is a fallback only if no diff is available). So even though the conductor did not pause
mid-run for the risk class, the human **still sees it at the release gate they always retained** — the floor's
safety value is delivered at the hard floor, not by interrupting the auto-advanced prefix.

**The conductor does not resolve a controlled brief on its own.** Accept/defer/edit/iterate/`discuss
<remark>` at a controlled gate is the human's decision, made through the existing surface (the web UI's
Accept/Defer, or the owning gate skill's accept/edit/iterate/discuss path — `harmony-clarify`/
`harmony-decompose`/`harmony-design-decide`/
`start-work`/`finish-work` each own their resolve, including the side effects: children-creation,
merge+deploy, prod-observation). At a controlled gate the conductor *never* synthesizes the resolution —
doing so would be the system making the human's decision, which is exactly what the controlled route exists
to prevent. (The *delegated* path in §4b is different: there the human has explicitly authorized the
accept for this run via the flag, and the conductor synthesizes exactly that accept — never a defer, never
an edit, only the accept the flag authorized, and never past the floor.) On **`discuss <remark>`** (B-461)
the conductor delegates to the OWNING gate skill for the brief's `awaiting_human_reason` to open a
discussion exchange on the active brief per `skills/harmony-shared/elicitation-engine.md` §The discuss
trigger (the remark seeds round 1). While a discussion is open, **brief resolution is suspended** — do not
route an accept/defer to the brief; offer **force-quit** or **cancel** instead. When the exchange concludes,
the gate skill re-composes the brief once and the pause resumes on the updated brief.

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
TaskDetailPanel on any device), continuing the instant it lands. **This is not optional and not automatic: you MUST arm the watch as a concrete action (§4c) before yielding the turn — never end the turn assuming the runtime will re-invoke you. "Surfaced the brief and stopped" is a bug; the only clean end-of-turn at a pause is an in-session answer you just received, or the ~90-min window expiry (graceful degradation). (Exception, B-693: in `--one-shot` the clean end-of-turn IS the exit — §4c's step-0 guard ends the run at this pause without arming; the daemon owns watching.)** State it plainly, e.g.: *"I'll keep watching
for your decision — resolve it here in the terminal or from the browser (Accept / Reshape / Deny) and I'll
continue automatically."* The watch is **bounded (~90 min, idle backoff)** and ends on **any** of three
co-equal exits: a browser resolution, an in-session/terminal answer, or the ~90-min timeout. On timeout the
loop is paused with **graceful degradation**: a later `/harmony-plugin:harmony-conduct B-123` resumes from the
ticket row (re-pass the flag to resume a partial/unattended/escalate run; absent a flag the resumed run is
controlled) — this is the **no-session degradation**: a browser resolution submitted while no session is
running simply **persists on the ticket row** and the next run applies it. Go to **§4c (Auto-pickup)**.

### 4c. Auto-pickup — consume a browser resolution in the live session (B-485 + B-500)

This is a **session-scoped watch with backoff** (locked param **D4**: a **session-/window-scoped background
poll that dies with the session** is permitted — *session-held v1*; a **persistent / cross-session daemon**
is still v2). Auto-pickup is the *running session* watching for the human's out-of-band browser resolution
and consuming it. The watch runs as a **background poll the session launches** (B-532), but it is bound to
the session's lifetime — it **dies with the session** (`pkill`ed on re-arm and on session end) and is
**NOT** a persistent/cross-session daemon and **NOT** a new write path. It changes only *where* the human
answers (the browser, on any device) versus requiring a session re-run; **it is orthogonal to delegation**
(§4b) — the human still resolves **every** controlled gate. Auto-pickup never makes a decision the human
didn't make; it routes the human's **actual** browser command to the owning gate skill, exactly as a
same-session answer would. **Auto-watch is the default (B-500):** after every controlled pause the conductor
enters this loop automatically — it does **not** ask the human to opt in and does **not** require a manual
re-run. **The one exception is `--one-shot` (B-693): a one-shot run never enters this section — it exits at
the pause via the step-0 guard below; the daemon owns watching.** The interactive default is otherwise
unchanged.

**The poll loop (bounded, idle-backoff, default-on).** After surfacing the brief at a controlled pause, the
conductor re-reads `mcp__harmony__get_task({ task_id })` on a bounded, idle-backoff schedule up to a **total
watch window of ~90 minutes** — long enough for the human to step away and resolve from the browser later,
bounded so an abandoned session doesn't spin forever.

**You MUST ARM the watch — "wait" is NOT automatic.** Polling across turns does not happen on its own: after
surfacing the brief you must schedule a *self-firing re-invocation* of this conductor before yielding the
turn, then end the turn. Do **not** just stop and assume the runtime will call you back — it will not, and the
watch silently dies (this is the B-531 bug). The *behaviour* — arm a self-firing watch after every
controlled/hard-floor pause — is the **durable contract**; the concrete mechanism below is a **swappable
recipe** (B-532 swapped the earlier Claude-Code `ScheduleWakeup` recipe for the bundled background poll
script below — the *recipe* changed, the *contract* did not; a persistent cross-session daemon would be a
further, separate change, still out of scope). (In `--one-shot` the arming imperative is inverted by the
step-0 guard below: the run exits at the pause instead — the daemon owns watching.)

**Claude Code — how to actually arm (the current recipe, B-532).** The watch is a **plugin-bundled
background poll script** — `dist/bin/poll.js`. It reads the ticket **IN-PROCESS** via the shared-core
`get_task` (`getTask`) — **not** MCP, **not** the CLI subprocess, **not** the self-executing committed
`dist/index.js` — with auth + project **pinned once at launch from `HARMONY_API_TOKEN`** (immune to a
mid-watch `~/.harmony` active-project switch). It exits the instant the human resolves — the **canonical exit
signal is `awaiting_human_input` clearing (true→false)** (B-611), after which it classifies what the human did
(state advanced / `pending_resolution` reshape / a Discuss request (`discuss-requested`, B-461) / `Parked` /
submitted elicitation answers (`answers-landed`, B-645) / a non-advancing sub-track accept) — it also exits on
`discussion-cancelled` (B-461: the active exchange went non-active WITHOUT the flag transition — a mechanical
cancel restores the flag directly) — or the ~90-min window expires. To arm it, after surfacing the
brief (or an elicitation round) **launch it in the background and end the turn**:

0. **THE ONE-SHOT GUARD (B-693) — checked FIRST, at this sole spawn site.** If the run carries
   `--one-shot`, do **NOT** arm: no `pkill`, no spawn — surface the pause exactly as §4 renders it, state
   the worker exit (*"exiting — the daemon owns watching; re-fire `harmony-conduct <ticket>` for the next
   leg"*), and **END THE RUN**. This guard lives at the ONLY place poll.js is ever spawned, so it covers
   **every** pause path — forward controlled gates, the **release** and **verify** hard-floor pauses, a
   **stale-patch** pause, and **elicitation rounds** alike — and a future new pause path physically cannot
   arm in a one-shot run, because arming only happens through this recipe. What the exit leaves on the
   ticket row is specified in *The one-shot exit contract* below. (Steps 1–3 are the interactive,
   non-one-shot path.)
1. **`pkill -f "dist/bin/poll.js <ticket>"`** first, to kill any prior poll still watching THIS ticket
   (idempotent re-arm). Also run this on session end so no poll outlives the session — the watch is
   session-scoped and must die with the session.
2. **`Bash(run_in_background)`** → `node ${CLAUDE_PLUGIN_ROOT}/dist/bin/poll.js <ticket>`. The ticket id is
   in the argv (greppable) precisely so `pkill -f` can target exactly this watch and so the watch self-cleans.
3. **End the turn.** The background process IS the watch — you do nothing between now and its exit.

On the script's exit your `run_in_background` re-invocation fires: **re-read `get_task` yourself** — the
script's stdout/exit code are *diagnostic only*; the conductor re-reads the ticket row and is the source of
truth. (These poll-exit re-reads may also use `view: 'meta'` — the classification fields below are all in
meta, B-684.) The **canonical signal a human resolved is `awaiting_human_input` clearing (true→false)**; once it
clears, classify what they did (state advanced / `pending_resolution` reshape / a Discuss request /
elicitation answers landed /
a non-advancing sub-track accept / nothing changed) — plus the one no-flag-transition exit, a mechanical
discussion cancel — consume it per the cases below, and **if it is still
pending, ARM AGAIN** (pkill the prior poll, re-launch, end the turn). The poll script owns the **cadence
(tunable):** first poll **~120s**; back off but keep each delay **under ~300s** while the human is likely
present; widen to a coarse tail (~900s) once clearly idle; stop at the **~90-min** window and degrade (case 7
below). Between launch and
exit you do nothing — the background poll IS the watch. The watch ends on **any** of three co-equal exits — a
browser resolution, an in-session/terminal answer, or the ~90-min timeout, whichever lands first. On each
re-read, the **exit gate is `awaiting_human_input` going true→false** — the moment that flag drops the human
resolved (in the browser or terminal); classify which resolution it was:

1. **State advanced — a browser accept/defer was applied** (`resolve_brief` ran from the web). The
   `workflow_state` moved forward (accept) or is now `Parked` (defer/deny), and `awaiting_human_input` is
   `false`. The web's accept/defer is the **mechanical** half (`resolve_brief` + the B-482 reconciliation
   guard). What remains is any **side effect** that only runs where the agent runs:
   - **Pure gate** (design sub-tracks, plan `plan-draft`): nothing further — the
     accept fully resolved mechanically. **Continue the loop at step 1** from the new state.
   - **Side-effecting CLARIFY** (`brief-review`, B-648): the web accept advanced Proposed→Clarified **but
     filed no ACs** (the web is mechanical-only; it cannot file the clarify-authored happy-path ACs).
     Route the human's **actual** accept to **`/harmony-plugin:harmony-clarify <ticket>`'s accept path**
     (the same path §4b uses for a synthesized accept, but here the human already accepted) so the ACs
     are filed **in this running session** — idempotent if already filed. If no session was running at
     the web accept, the design gate's self-heal covers it. Then continue the loop.
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
   `active` for you to revise). **Run the LLM iterate in-session** (§4d). (A marker whose `command` is
   `'discuss'` is NOT a reshape — see case 3.)
3. **`discuss-requested` — a browser Discuss on the active brief (B-461).** The flag cleared and the
   marker is `pending_resolution = { command: 'discuss', detail: <remark> }` — the human wants a
   conversation on this brief, not a regenerated one. **Route to the OWNING gate skill** for the brief's
   `awaiting_human_reason` to open the discussion exchange on the active brief and **file round 1** per
   `skills/harmony-shared/elicitation-engine.md` §The discuss trigger (the remark seeds round 1; filing
   round 1 CONSUMES the marker — it clears `pending_resolution`). Brief resolution is suspended while the
   discussion is open. The round re-sets the flag and re-arms the watch.
4. **`answers-landed` — the human submitted an elicitation round's answers (or a force-quit) from the
   web (B-645/B-462).** The flag cleared and the task's `active_exchange` carries an unconsumed
   `answers_submitted_at` (or `force_quit_requested_at`) — checked BEFORE case 5, or an exchange answer
   would misclassify as a non-advancing accept and never be consumed. This is INPUT, not a resolution:
   **re-invoke the owning gate skill** for the exchange's `gate` (e.g. `clarifying` →
   `/harmony-plugin:harmony-clarify <ticket>`) — its resume path reads the answers via
   `get_elicitation` and consumes them (files the next round, which re-sets the flag and re-arms the
   watch; or concludes and proceeds to its draft). The conductor never answers, re-asks, or concludes
   an exchange itself — the gate skill owns the exchange; the conductor only routes the wake-up.
5. **Flag cleared, state unchanged, no `pending_resolution`, no exchange marker — a non-advancing accept
   (B-611).**
   `awaiting_human_input` went `false` but `workflow_state` did NOT move and there is no reshape marker. This
   is a **design sub-track accept** whose brief was composed with `pending_activity: null` — it records the
   sub-track decision **without advancing state** (state advances to `Designed` only once *all* required
   sub-tracks are accepted; an accepted non-last sub-track clears the flag but leaves the ticket at
   `Decomposed`/`Designed`-in-progress). This is a **real resolution, NOT a timeout**: **continue the loop at
   step 1** — re-invoke the design gate (`/harmony-plugin:harmony-design-decide <ticket>`) to file the **next**
   required sub-track, which re-sets `awaiting_human_input = true` and re-arms the watch. (Before B-611 the
   poll watched only the three *consequences* — advance / reshape / park — so this flag-only clear was missed
   and the watch false-timed-out at ~90 min.)
6. **`discussion-cancelled` — a mechanical cancel restored the brief (B-461).** The ONE exit that fires
   WITHOUT the flag's true→false transition: the baseline's active discussion exchange went non-active
   (status changed / row gone) while `awaiting_human_input` stayed `true` — the web's cancel ("never mind
   — keep the brief as it was") concluded the exchange `'abandoned'` and restored the flag directly, so
   the flag gate alone would miss it (the B-611 blind-spot class). Nothing to redraft and no claims:
   **re-read the ticket and resume the pause on the untouched brief** (re-surface it per §4) and
   **re-arm the watch**.
7. **Nothing changed** within the **~90-min** watch window (`awaiting_human_input` still `true`) →
   **poll-window expiry**: fall back to graceful degradation — tell the human to re-run
   `/harmony-plugin:harmony-conduct <ticket>`; the resolution (if any) persists on the ticket row; **end the
   turn**. The next run resumes from the ticket row (the no-session degradation). Do not keep an indefinite
   watch.

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
  (the release brief carries `pending_activity: null` — Built→Deployed is SYSTEM-on-deploy-success, not
  human-accept; see finish-work O1/O2). So on detecting a human browser-accept of release (flag cleared,
  still `Built`, no `pending_resolution`), route to `finish-work` to run the **merge + deploy** in-session;
  finish-work advances Built→Deployed only after the deploy actually succeeds.
- **verify**: likewise route to `finish-work`'s verify step on a human browser-accept; it advances
  Deployed→Verified.
If the human did NOT act (no browser accept), release/verify stay paused — the conductor waits or the watch
window expires; it never advances them itself.

### The one-shot exit contract (B-693 — the worker half, joint with B-696)

A `--one-shot` run is the Conductor Daemon's worker: it advances one leg and hands back. It writes **no
separate exit status — the ticket row IS the contract**; the daemon classifies the outcome purely from the
row shape the exit leaves behind (daemon spec §3 step 4):

- **Clean human pause** — `awaiting_human_input: true` plus an active brief or elicitation exchange
  (**release and verify pauses included** — the hard floor is a clean pause like any other) → the daemon
  waits for the human.
- **Terminal** — `Verified` / `Cancelled` (or `Parked` via a human defer consumed in-run — a human
  outcome, never the worker's own) → the conduction is done.
- **Split-umbrella report-and-stop** — `Decomposed` with non-archived children, `awaiting_human_input:
  false`, no active brief (§5's report-and-stop): a **legitimate clean exit** — the daemon must NOT
  classify it as dirty; how the daemon proceeds from it (conduct the children / park-and-flag) is B-696's
  decision, not this skill's.
- **Anything else = DIRTY** → the daemon parks the conduction and flags the human. This **explicitly
  includes a TORN pause: `workflow_state` advanced but no composed brief** (a crash in the
  advance→compose window). A torn pause must never be mistaken for a clean one — it is the same flag+row
  atomicity family as **B-498** (the browser reshape's single-RPC write); both exit-contract owners stay
  consistent with that classification.

Suppression is total by construction: the step-0 guard sits at the sole poll.js spawn site, so a one-shot
run leaves **no background watch process** — `pgrep -f "dist/bin/poll.js"` after a one-shot exit finds
nothing armed by this run (the AC2 live check).

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
  row — if the B-471 roll-up has since advanced the parent to Deployed, the loop resumes at the verify hard
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
- The **risk-class floor** (auth / data-migration / irreversible-destructive / shared-core) **pauses a
  delegated gate only in `--escalate`** (B-516) — there it surfaces for a human at EVERY dial level, even when
  `--escalate` judged the gate routine, and the pause names the class that tripped it. In
  `--unattended`/`--pause-at` the floor does **NOT** pause mid-run (**no exceptions — not even
  `irreversible-destructive`**); the tripped classes are recorded and surfaced on the **release brief**, where
  the human reviews them at the hard floor. (Rationale: nothing executes irreversibly before release; the
  release+verify hard floor already covers irreversibility, so a mid-run pause would only override the human's
  explicit `--unattended` control choice.)
- In `--escalate`, a gate the conductor judges genuinely worth a human opinion surfaces (and resumes on the
  next flagged re-run); a gate judged routine (and floor-clean) is decide-and-recorded with no pause.
- An auto-advanced / decide-and-recorded gate records the SAME Accepted decision a controlled run would —
  only the human pause is skipped, via the owning gate skill's existing accept path (no new write path for
  `--escalate`).
- An unknown/misspelled flag, an unknown `--pause-at` gate, or more than one delegating flag together, is
  an ERROR — never a silent delegation.

Browser auto-pickup (B-485) is **orthogonal and equally non-decisional**:

- It is the **default at each pause** (B-500 — the conductor auto-watches without asking and without
  requiring a re-run) and **session-scoped** (D4 — a session-/window-scoped background poll that **dies with
  the session** is permitted, via B-532's bundled `dist/bin/poll.js`; a persistent/cross-session daemon is
  still v2). The watch is **bounded (~90 min, idle backoff)** and ends on **any** of three co-equal exits — a
  browser resolution, an in-session/terminal answer, or the ~90-min timeout; on timeout it degrades to
  today's persist-and-resume.
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

`--one-shot` (B-693) is **orthogonal and equally non-decisional**:

- It changes only what happens **at** a human pause — exit instead of arm-and-wait. Gate behaviour, the
  delegation test, the risk-class floor, and the hard floor are untouched in every mode.
- It never weakens B-500's interactive auto-watch default — a run without the flag arms exactly as today.
- The exit leaves the decision surface intact: the pause persists on the ticket row (the no-session
  degradation is the designed path), and the daemon — or a human re-run — picks it up from there. The row
  shapes it may leave are pinned in *The one-shot exit contract* (torn pause = dirty, B-498 family).

## Still out of scope (later phases)

- **Quantitative risk *score* / circuit-breaker tuning** (B-458 phase 2d and beyond): the floor here is a
  deterministic, binary class detector (`detectRiskClasses` in `src/tools/risk-class.ts`) — present/absent
  per class, conservative-on-ambiguity by design (B-516 scope-aware: negation/word-sense/clean-diff
  down-weight trim the *clear* false-positives only). The conductor does not compute a numeric risk score,
  learn a threshold, or trip a rate-limit-style circuit-breaker. The hard floor, the dial ceiling, the
  risk-class floor (now `--escalate`-scoped for its pause, B-516), and the `--escalate` judgment are the
  guards in 2c.
- **Skills reading the dial generally** (F5 / B-355): the dial mirror here exists for the conductor's
  cautious kill-switch; a shared/db-driven trust source replaces the hand-maintained mirror in
  `src/tools/trust-model.ts` (see its drift-sync note) later.
