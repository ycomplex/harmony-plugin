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

## Where this is enforced mechanically — and where it is a discipline

The daemon's worker-exit classifier (`src/daemon/classify.ts`) is the one surface that enforces (b)
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

Everywhere else — an interactive session, a delegated build subagent, a gate skill mid-run — the
enforcement is a **discipline**, not a mechanism: there is no daemon watching an interactive session's
exit. `skills/harmony-conduct/SKILL.md` §4e's backstop invariant is the interactive instance of clause
(a); its extension to also require (b) — and its explicit pointer back to this doc — is what keeps the
interactive and daemon-driven paths stating the SAME rule instead of two paraphrases that can drift.
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
