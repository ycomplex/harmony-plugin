# Clean-exit contract (every leg, every surface)

A leg — a build subagent, a delegated gate skill, a one-shot daemon worker — does not get to just stop.
**Ending a turn is an action with its own obligations**, exactly like advancing state or filing a brief.
This doctrine states the one invariant every leg owes the ticket before it voluntarily ends its turn,
independent of WHICH skill or surface is running.

## The invariant

Before a leg ends its turn, it must have:

**(a) Consumed every marker it acted on.** A staged `pending_resolution` it read and applied, an open
elicitation exchange it answered — leaving one of these dangling is not a clean exit, it is a stall
wearing a clean exit code. The next reader (a human, or the next leg) must never have to guess whether a
marker is stale-but-actioned or genuinely still outstanding.

**(b) Left at least a progress comment when real repo work landed but no state-advancing write was yet
possible.** "Real repo work" means a commit, a branch push, or a PR update — something a human or the next
leg can find by looking at the repo, not just the ticket. If that work landed but the leg could not yet
advance `workflow_state` (blocked on a later step, ran out of turn budget, hit a capability denial after
the commit), the ticket's own comment trail must say so. A ticket that silently carries finished work with
no board trace is indistinguishable, from the outside, from a ticket where nothing happened at all — and
that indistinguishability is the defect, not a cosmetic gap.

Consuming (a) and reporting (b) are not alternatives — a leg that both consumed a marker AND landed repo
work owes both.

## Why (b) exists as its own clause, not just "advance state or park with a reason"

A leg can do everything right — commit, push, iterate on a brief, record a knowledge decision — and still
run out of turn before the one write that flips `workflow_state`. That is not a failure; delegated work is
allowed to span more than one leg. The failure is when NOTHING on the ticket says so: the next reader (or
the daemon's exit classifier, mechanically) has no way to distinguish "finished real work, ran out of turn"
from "spun and did nothing." The fix is not to force a state advance the leg isn't ready to make — it is to
make the in-between state legible with a comment, so whatever reads the ticket next (human or the daemon)
can tell the two apart.

## Where this is enforced mechanically — ONE rule, two surfaces

Both surfaces are mechanical now, and both decide from the **same list**. That is the point of this
section: the interactive side and the daemon side must state ONE rule, not two paraphrases that drift.

**The shared list.** `isCleanRowShape(row, nonArchivedChildCount)` in `src/daemon/classify.ts` is the single
statement of what a clean place to stop looks like, in this order:

1. `awaiting_human_input: true` — a composed brief or a filed elicitation round is holding the ball;
2. `workflow_state` ∈ `Verified` / `Cancelled` / `Parked` — a terminal outcome (a park carries an authored
   reason);
3. `Decomposed` with ≥1 non-archived child and the flag down — the split-umbrella report-and-stop.

Nothing else is a clean voluntary stop. A contract test (`src/hooks/stop-gate.contract.test.ts`) runs a
table of row shapes through **both** consumers and fails if they ever disagree.

**Interactive sessions: the turn-end gate (B-870).** A session driving a ticket writes a conduct breadcrumb
at leg start (`~/.harmony/conduct-sessions/<session_id>.json`, holding the ticket id — deliberately not
`.harmony-task.json`, which only exists at the build gate and can be stale in the cwd). The plugin's
`Stop` hook (`hooks/stop-gate.sh`) reads that breadcrumb, re-reads the ticket row, applies the shared list
above, and **blocks the turn-end** (exit 2, reason on stderr) when the row is none of the three shapes,
naming the remedy: compose the brief, file an elicitation round, or defer/park. A session with no breadcrumb
is untouched and pays no cost — the breadcrumb check is a `test -f` before any interpreter starts. The gate
is bounded on purpose: it blocks the same turn-end at most twice and then degrades with a loud line naming
the row state it could not classify, it fails **open** on any error (query failure, timeout, malformed
input), and an operator can disable it for their own session with `HARMONY_STOP_GATE_OFF` — a human-only
control, logged whenever it is active, and absent from every daemon profile. It is a floor under the
discipline, never a substitute for it: `skills/harmony-conduct/SKILL.md` §4f is the doctrine it enforces,
and §4e's backstop invariant is unchanged.

**Daemon workers: the exit classifier.** The daemon's worker-exit classifier (`src/daemon/classify.ts`) is the one surface that enforces (b)
**mechanically**: it now probes the repo directly (a live `git ls-remote` of the leg's known work branch,
bracketing fire and settle — never a board-field read, since a board field can go stale the moment a
rebase-push moves a PR head without re-recording it) and widens its board-progress read (an in-place brief
iterate, a newly-referenced knowledge decision, a consumed marker) alongside the existing
`workflow_state`/`awaiting_human_input` check. When repo work landed but the board stayed silent, the
conduction parks with the distinguishable reason `repo-active-board-silent` instead of the generic
`no-progress` — so a human triaging parked conductions can tell "this one finished real work, it just
didn't get to the board write" apart from "this one is genuinely stuck," at a glance, without re-deriving
it from the repo by hand. This is distinguishability only — it does not auto-requeue or retry a parked
conduction; a human still decides what happens next.

**What is still discipline.** The gate above checks the BOARD half — the row shape. Clause (a)
(consume every marker you acted on) and clause (b) (leave a progress comment when real repo work landed with
no state-advancing write yet possible) remain disciplines on the interactive side: a session can satisfy the
row-shape check while still leaving a marker dangling or a push unreported. `skills/harmony-conduct/SKILL.md`
§4e states both and points back here; the daemon's `repo-active-board-silent` park reason is the only place
clause (b) is mechanical. A delegated build subagent (no MCP tools, no Stop hook of its own) is discipline
throughout — it reports upward via the `WORKER-QUESTION:` marker and its delegating gate skill owns the
board write.

`start-work`'s build-in-flight/FAILURE PATH steps and `finish-work`'s B-774 post-merge-deploy confirmation
are both instances of (a)/(b) applied to their own gate's specific markers and repo artefacts — read those
skills for the mechanics; this doc is the one place the RULE itself is stated.

## What this generalizes from

**B-774** closed the release path's own instance of this gap: `finish-work` used to advance the ticket
before confirming the post-merge deploy actually landed, so a failed deploy could read as done. **B-792**
is the general form — a conductor leg that finished real work (commits, pushes, brief iterations,
knowledge decisions) but made no state-advancing write was getting parked as indistinguishable from a
worker that spun and did nothing, hiding finished work from the human triaging the park. Both specimens are
the same defect at different points in the lifecycle: an in-between state with real progress in it, and
nothing that says so.
