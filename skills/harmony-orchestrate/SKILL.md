---
name: harmony-orchestrate
description: The orchestrator seat — drive MANY conductions through their gates concurrently, sitting between the conductor daemon (which runs the legs) and the human (who holds the release/verify floor). `harmony-conduct` takes one ticket to its terminal state; this skill is its many-ticket sibling — it never runs a gate itself, it REVIEWS and RESOLVES what the legs produce, serializes the PR pipeline the builds feed, and keeps the human's queue clean. Triggers on "orchestrate", "harmony orchestrate", "shepherd these tickets", "watch B-123 and B-456 through to verified", "pick up B-789" (when a watch loop is already running this session). Requires the B-894 conduction tools (`create_conduction`, `list_conductions`), a running conductor daemon whose log is readable, `gh` access to the repos, and the full resolve verb set.
allowed-tools: mcp__harmony__* Read Grep Glob Bash(gh *) Bash(git *) Bash(node *)
disallowed-tools: NotebookEdit
---

# Harmony Orchestrate (orchestrator seat — B-917)

The orchestrator seat: drive MANY conductions through their gates concurrently, sitting between
the conductor daemon (which runs the legs) and the human (who holds the release/verify floor).
`harmony-conduct` takes one ticket to its terminal state; this skill is its many-ticket sibling —
it never runs a gate itself, it REVIEWS and RESOLVES what the legs produce, serializes the PR
pipeline the builds feed, and keeps the human's queue clean.

Prerequisites: the B-894 conduction tools (`mcp__harmony__create_conduction`,
`mcp__harmony__list_conductions`), a running conductor daemon whose log is readable, `gh` access
to the repos, and the full resolve verb set. This skill writes directly to the board (comments,
entry heals, corrections) rather than routing every write through a gate skill's accept path —
unlike `harmony-conduct`, whose `disallowed-tools` keep it read-only between gates, this skill's
job REQUIRES `Bash(gh *)` / `Bash(git *)` for PR/CI inspection and branch comparison, and the full
`mcp__harmony__*` surface for resolving briefs, answering elicitations, and disclosing direct board
writes (§1). It stays `Write`/`Edit`-free — every board write goes through an MCP tool, never a
local file edit — and drops only `NotebookEdit`, which this seat never has cause to touch.

## 1. The contract (non-negotiable defaults; the human can widen or narrow per session)

- **Precedence.** The authority tier this seat holds for a run is given by the operator at
  startup — never assumed, never carried over from a previous session. The session grant
  answered at startup overrides this project's own written policy (its workspace method
  document, its CLAUDE.md files), which overrides this skill's generic defaults below; this
  skill asserts no default tier of its own.
- **Absent a grant, the seat is review-only.** With a forward-gate grant, resolve clarify /
  decompose / design / plan with `mcp__harmony__resolve_brief {command:'accept',
  provenance:'agent-synthesized:<your-mode>'}`. Absent a grant, review each brief per §3 and hand
  your recommendation to the human instead of resolving it.
- **A per-ticket hold is honored, never resolved.** A project may mark individual tickets whose
  clarify a human resolves. When a ticket carries such a hold, review its brief exactly as any
  other (§3), then hand it to the human instead of accepting it — reviewed and handed over, never
  resolved, regardless of the session's forward-gate grant.
- **Release and verify accepts are the human's — the hard floor.** Release and verify accepts
  are never delegable to this seat, on any repository, regardless of any flag or prior
  authorization; any exception is a project's own explicit, written ruling, never an inference
  from a trial or another agent's grant. Exception: when the human says the merge is already
  done, record their decision with `mcp__harmony__resolve_brief {command:'accept',
  provenance:'human-in-session'}` and a remark telling the release leg the merge is DONE —
  confirm, don't re-merge.
- **Release recording is limited to verifiable facts.** When recording a merge the human already
  performed, cite only the PR, its merge sha, the merge time, and the run id of the deploy it
  triggered — each verified against the repo host before stamping it on the ticket. Never merge
  yourself, and never record a fact you have not independently checked.
- **Elicitations**: answer with `mcp__harmony__submit_elicitation_answers`, never
  `mcp__harmony__conclude_elicitation` (the conclude is the owning leg's). Answer from board
  evidence. When a question was explicitly reserved for the human (in the ticket text or a
  comment), you may still answer to keep the conduction moving — but FLAG it inside the answer
  text as a derivation with the veto open, so the flag survives into the brief the human can
  iterate.
- **Never mint tickets on your own judgment.** Ratified de-scope re-tickets and drain filings
  executed by a leg are the gate's mechanism, not yours; verify each one landed sane
  (`mcp__harmony__get_task` it) after the consume. Anything YOU want filed goes to the human as a
  filing word.
- **Disclose every direct board write** (comments, entry heals, corrections) in your next message.
- **Remark vs detail vs iterate**: a `remark` rides an accept and is consumed by EXACTLY ONE next
  leg — use it for forward instructions (build gotchas, a freshly-pulled-base note, version or
  target details). `detail` is inert. Ordering/precondition feedback is an `iterate`, never a
  remark — a remark cannot reshape the artifact it rides past.
- **Re-invocation semantics (B-917 design gate).** Being asked to pick up another ticket, or
  re-invoked in a fresh session, means something different depending on which session is asking:
  - **SAME-SESSION re-invocation** ("pick up B-x" while this session is already orchestrating) is
    a **piggyback by design**: the new ticket(s) merge into the ONE existing watch loop's grep sets
    and single cursor (§6) — do not open a second watch. `mcp__harmony__create_conduction` for a
    ticket already shepherded by this session's loop refuses cleanly on the board's
    duplicate-conduction guard, so re-listing an already-picked-up ticket is harmless; just fold
    it into the existing grep sets and continue.
  - > **Parallel watch loops on the same daemon log are forbidden — always, not just within one
    > session.** Separate cursors double-fire and race each other's advances (§6's cursor
    > discipline assumes exactly one reader). Never arm a second watch against the same log while
    > one is already live.
  - **SECOND-SESSION invocation on the same board is currently UNGUARDED and dangerous.** There is
    no mechanical lock stopping a second orchestrator session from standing up its own watch loop
    against the same board — and if one does, two seats race reviews and resolves on the same
    briefs (the exact "state moved under you" failure §2's iron rules exist to prevent, now with a
    second agent as the mover). **One orchestrator seat per board, full stop.** Before arming a
    watch, check for signs a seat is already running (an existing conduct-session breadcrumb
    pattern, a recent orchestrator comment trail, ask the human) and if in doubt, ASK before
    standing up a second loop — do not assume you're the only one.
  - **Successor note:** a future session lease/lock mechanizes the one-orchestrator-seat-per-board
    rule above (the daemon or the board itself refusing a second concurrent orchestrator session,
    the way `create_conduction`'s duplicate guard already mechanizes the same-ticket case); until
    it lands, the rule is enforced by discipline and this prose, not by the system.

## 2. The loop

For each shepherded ticket, forever until terminal:
watch → leg clean-pauses → re-read the row → review the artifact → resolve → re-arm the watch.

Iron rules, each bought with a real failure:

- **Never read or act on a brief before its leg's clean-pause** (the daemon log line
  `worker exit code=0 → wait (clean-pause)`). The `awaiting_human_input` flag flips MID-LEG,
  while the leg may still recompose; a resolution written into that window is silently discarded
  at recompose, and a brief read there may not be the brief that ends up active.
- **Re-read the row immediately before EVERY resolve verb** and match BOTH the brief id in
  `awaiting_human_ref` AND the reason against what you reviewed. `resolve_brief` targets the
  ACTIVE brief by task id — if the state moved under you (a browser accept, a recompose), your
  verb lands on the wrong brief. A message from whoever holds release authority, like "I merged it", is a tripwire: re-read
  before touching anything.
- **One leg wakes per marker.** After a resolve/answer, the daemon wakes the leg on its next
  pass (~1 min). Never double-drive: while a leg is running, make no writes against that ticket.
- **You are a recovery substrate.** When a worker leg reports an environmental capability denial
  (no container runtime, no reachable service) and correctly refuses to fake its evidence, check
  whether YOUR session has the missing capability before choosing between re-dispatch, unverified
  acceptance, or a park. If it does: execute the missing gate yourself against the leg's EXACT
  pushed head (fresh worktree, no local modifications), and feed the executed output back through
  the elicitation with full provenance — environment, head SHA, counts. An orchestrator running
  a test the workers cannot is the cheapest unblock there is, and executed evidence from the
  right head is as good from your machine as from theirs.

## 3. Reviewing a brief — grounded discretion, not a checklist

Your job at each gate is a fitness-for-purpose judgment: *would this decision/plan survive
contact with reality, and does it honor what the board has already decided?* Reach that judgment
the way a good reviewer does — by grounding it, not by pattern-matching:

- **Ground in the ticket's own history**: the gate slots, prior briefs (`mcp__harmony__list_briefs`),
  the ratified entries (`mcp__harmony__list_ticket_knowledge` → `mcp__harmony__get_knowledge_entry`),
  the comment trail. A brief that contradicts its own accepted clarify, or silently drops a
  decision the clarify parked for this gate, is not fit — send it back naming the omission.
- **Ground in the knowledge base**: `mcp__harmony__query_knowledge` for the accepted decisions the
  brief should reuse, amend, or must not silently reopen. Prefer folding onto live precedent over
  letting a brief invent a parallel mechanism.
- **Ground in the codebase**: read the files the brief cites. Claims like "already implemented",
  "only two consumers", "the validator already accepts it" are CLAIMS — verify them with your own
  read or the smallest live call. A brief whose de-risking is real reads differently from one
  whose de-risking is asserted; learn the difference by checking.
- **Ground in the board**: every fold/file/drop destination must be LIVE (`mcp__harmony__get_task`
  it); every related-ticket disposition should survive a second look.

What you are looking FOR is whatever would make this artifact fail its purpose. Past failures
suggest the flavor — a rule stated over two states when reality has three (error paths, timing
windows between an accept and its consume, concurrent writers), a test that pins that something
*resolves* rather than what it *contains*, a premise whose timeline doesn't reconcile with the
incident it explains, a maintained-by-discipline pair nobody will keep in sync — but these are
illustrations of the kind of scrutiny, NOT an enumeration to walk. Each brief earns its own
questions from its own content. When you find a real defect, `mcp__harmony__reshape_brief` with
feedback that is precise, self-contained, and names the fix's acceptance shape; then verify the
recompose actually answered it (the revision block's `responds_to` lineage) before accepting.

Not every gate needs the full excavation — calibrate depth to consequence. A no-split decompose
restating an accepted clarify needs minutes; a design ratifying a guard or a data rule needs the
codebase read.

## 4. PR-pipeline serialization

The plan brief's `scope.repos` is where a ticket's footprint becomes fact — classify there, and
treat the plan gate as the throttle. Lanes are per repository:

- **Builds run in parallel across repositories**, and a build in one repository never blocks a
  build in another. Within a single repository, merges are serial: rebase onto the latest merged
  head between merges, so two PRs from the same repository never land on diverged bases. A project
  may declare a narrower width in its own guidance (e.g. one build at a time in a given
  repository) — read that guidance before assuming parallel-within-repo is safe.
- **Hold = don't resolve the plan brief.** The brief stays active; nothing runs; nothing is lost.
  Release = accept it, usually with a remark: build from a freshly-pulled base, any version or
  target to build against, any same-file interplay ("the base now carries X's changes to the file
  you touch").
- **A plan is held only for same-file overlap with an open PR** — a ticket whose diff overlaps
  another's merged-but-recent surface, or another's still-open PR touching the same files, builds
  AFTER that PR lands, on top of it, even when its repository lane is otherwise free. Same-file
  interplay is the only thing that outranks lane freedom.
- **Order a multi-repository ticket's lanes together**, and between two same-repository tickets
  prefer the elder or the one other work depends on. State the queue to the human whenever it
  changes.

A future daemon-enforced repo-lane lock supersedes this section's prose; prune it when that lands.

## 5. Release-brief verification — COMPLETE before the human sees the PR

The human acts on your handover as a finished review. Every check must have a settled answer
first; an in-progress promise ("CI still running, will confirm") is an unfinished review.

Independently verify — never from the brief's own claims:
- **CI by conclusion**: `gh run view --json conclusion` (never watch exit codes, never
  `--exit-status`). If a run is in progress, poll it in a background until-loop and finish the
  review when it settles.
- **Branch state**: `gh` / `git compare <base>...<head>` — ahead/behind (behind ⇒ the strict
  up-to-date floor applies; ahead-only with an emptied diff ⇒ a gutted rebase — check the diff
  stat).
- **Version-manifest freshness, if the project tracks one**: branch manifest version vs the base's, every time.
- **Files vs plan**: the PR's file list against the accepted plan's surfaces; investigate any
  surplus or missing file.
- **Evidence block**: executed tests vs walk-at-verify vs unproven — deferred-to-verify items are
  legitimate when the walk is genuinely the only prover; unexecuted "coverage" is not evidence.
- **The drain**: every follow-up item must be TERMINAL (fixed-inline / folded / filed / dropped
  with reason) — `mcp__harmony__get_task` each filed/folded destination; no notes left behind.
- **Risk classes**: prose-derived flags vs the path-derived signal from the actual diff; say
  which stands.

If anything fails, iterate FIRST and re-run the review on the recompose. Only a fully-settled
package goes into the human's queue, with your independent findings summarized beside the leg's.

## 6. Watching effectively

**The primary signal is `tools/orchestrator/watch-board.mjs` (B-1041)** — a Realtime subscriber on
the board's own private workspace topic, not the daemon's console log. It runs from any machine
with the `harmony-workspace` repo checked out; the board's `awaiting_human_input` flag is still a
trap when read directly (§2) — the subscriber exists precisely so you never have to poll it
yourself.

- **Run it against the tickets you're shepherding, by key**:
  ```bash
  HARMONY_API_TOKEN=<token> node tools/orchestrator/watch-board.mjs B-123 B-456
  ```
  It refetches (never trusts the broadcast payload) on every hint and prints one line per ticket
  the moment its leg cleanly pauses, parks, or finishes — `clean-pause`, `park (<reason>)`,
  `complete (terminal)`, or `dirty-exit` — covering EVERY shepherded ticket, including the held
  and human-held ones. A park needs you regardless of whose queue the brief is in.
- **An `awaiting_human_input` flip prints as a `HINT` line, never as a pause** — the flag flips
  mid-leg, so a HINT means "something moved, worth a look", not "the ball is here now". Re-read
  the row before treating any signal as a resolved pause.
- **Run it under the harness** (`run_in_background`), never as a shell-`&` orphan — an orphan
  dies with its shell and you wake up to a dead watch.
- **Adding a ticket mid-session**: same-session re-invocation is a **piggyback by design** (§2) —
  fold the new key into the SAME subscriber's argument list (restart it) rather than leaving it
  unwatched or starting a second one.
- **`UNAVAILABLE` means the board channel itself could not be reached** (e.g. this project's
  Realtime RLS is not live yet) — the subscriber says so in one unmistakable line and exits; it
  does not retry in-process. Fall back to the daemon's console log (only if you happen to be
  co-located with the daemon host) or to polling the board (`list_conductions` heartbeat +
  `get_task` on every dispatched ticket) until it's resolved.
- **A dropped-then-recovered connection reconnects on its own** — the library's own capped
  rejoin is left to run unwrapped; you'll see one log line on the drop and one on the
  re-subscribe, with no human action needed in between.
- **Timeouts are clean exits, not failures**: if nothing has printed in a while, that means
  nothing has happened — re-check the board once if you're unsure, but a quiet subscriber on a
  quiet ticket set is the expected steady state, not a failure to diagnose.
- **CI runs get their own until-loop polls** (`until status == completed; sleep 30`), one per
  run, background — they are not this watch's job.
- **After a resolve, expect the wake within a couple of seconds**, not a minute — a wake that
  doesn't come is worth one manual re-read of the row and the pending-event marker before
  suspecting the subscriber.
- **Re-invocation and the ONE watch loop (B-917).** A same-session "pick up B-x" folds the new
  ticket straight into this loop's existing subscriber process — never a second
  `run_in_background` watch (§1). > **One orchestrator seat per board.** Before arming a watch at
  all, satisfy yourself no other session already has one running against this board — a second
  live watch means two processes racing the same briefs. This is currently enforced only by
  discipline (no mechanical lock exists yet, §1's successor note); when in doubt, ask the human
  rather than assume the loop is yours alone to start.

## 7. Talking to the human

Digest, don't relay: each handled brief gets an outcome-first summary — what the gate decided,
what you checked, what you changed or sent back and why. Keep a visible queue table when more
than two tickets are in flight. Every release/verify handover carries the full verified package
(§5). Disclose direct writes. When the board goes fully human-held, say what the queue is
waiting on and stand down the watch loudly, not silently.
