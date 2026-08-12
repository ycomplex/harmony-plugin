// B-696: the daemon's worker-exit classifier — WHAT happened when the one-shot worker exited?
//
// The daemon never parses worker stdout (agent-portability guardrail). The classification input is
// exactly: the worker's exit code + a fresh post-exit ticket read (+ the non-archived child count
// when the state is Decomposed, + whether the ticket progressed vs the pre-fire read). The branch
// ORDER below is the B-693 worker exit contract, verbatim — order IS the contract:
//
//   1. awaiting_human_input=true                       ⇒ wait     / 'clean-pause'
//   2. workflow_state ∈ TICKET_TERMINAL_STATES         ⇒ complete / 'terminal'
//   3. Decomposed + ≥1 non-archived child + flag false ⇒ complete / 'split-umbrella'
//      (founder-settled claim 1ebea32c: a split-umbrella exit COMPLETES the conduction — the
//      children carry the work forward under their own conductions; NEVER park it)
//   4. stale=true                                      ⇒ park     / 'stale'
//      (terminal-only stale constraint, B-507/B-575 class)
//   5. timedOut=true (B-739 — THIS daemon's deadline) ⇒ park     / 'worker-timeout'
//   6. non-zero (or unknown) exitCode                  ⇒ park     / 'dirty-exit'
//   7. exitCode=0, flag false, progressed=false,
//      repoProgressed=false                            ⇒ park     / 'no-progress'
//   7b. exitCode=0, flag false, progressed=false,
//      repoProgressed=true                              ⇒ park     / 'repo-active-board-silent'
//      (B-792: real repo work landed — a commit/push/PR head moved — but no state-advancing board
//      write happened. Distinguishable from 'no-progress' so a human triaging parked conductions
//      can tell "genuinely stuck" apart from "finished real work, just didn't write the board" — see
//      skills/harmony-shared/clean-exit-contract.md, the doctrine this branch enforces mechanically.
//      Distinguishability only: this does NOT auto-requeue or retry.)
//
// Park is IMMEDIATE at classification time (Accepted design d153970b) — this module always
// returns 'park' for reasons 4-7 above, never a retry. B-713 layers a bounded retry ON TOP of a
// 'dirty-exit' park (reap, backoff, re-fire, up to a cap) in the SCHEDULER (scheduler.ts), before
// it ever writes the 'parked' status this module's outcome implies; classification itself is
// unchanged. A parked conduction (cap exhausted, or any other park reason) waits for a human.
// Fallthrough (clean exit, progressed, ball still agent-side) is a wait: the next pass's wake
// detection re-fires.
//
// Pure functions, no I/O.

import type { Taskish } from '../conductor/poll-loop.js';

/** The ticket workflow states that end a conduction. An EXPLICIT allowlist constant — consumers
 *  must never hand-write terminal checks or substring-match state names (the B-565/B-580 completion-
 *  predicate bug class; `isConductionTerminal` is the same discipline on the conduction axis). */
export const TICKET_TERMINAL_STATES = ['Verified', 'Cancelled', 'Parked'] as const;

export type ExitOutcome =
  | { action: 'wait' }
  | { action: 'complete' }
  | { action: 'park'; reason: string };

export interface ClassifyArgs {
  /** The POST-EXIT ticket read (getTask view:'meta' is structurally assignable). */
  row: Taskish & { workflow_state?: string | null; stale?: boolean | null };
  /** Non-archived children of the ticket — only meaningful when the state is Decomposed. */
  nonArchivedChildCount: number;
  /** The worker process's exit code; null = unknown/reaped (treated as dirty, never clean). */
  exitCode: number | null;
  /** Did the ticket move (workflow_state or awaiting flag changed vs the pre-fire read)? */
  progressed: boolean;
  /** B-739: did THIS daemon rule this launch OVERRUN and reap it? Keyed on an in-process flag,
   *  NEVER on the exit code — a reaped container exits 137, but so does an out-of-memory kill and
   *  so does a worker reaped by a peer's takeover. The exit code cannot say who decided; the flag
   *  says this daemon did. */
  timedOut: boolean;
  /** B-792: did the repo move between fire and settle — a LIVE `git ls-remote` head-SHA probe of
   *  the leg's known work branch (`build_pr.branch`, else `work_branch.branch`), bracketing fire and
   *  settle, NOT a board-field read. True only when both probes succeeded and the SHA differs — a
   *  probe failure/absence never sets this true (see scheduler.ts's settleTrackedLaunch). This is
   *  exactly the B-758 specimen's blind spot: a rebase-push updates the PR head without re-recording
   *  `build_pr.head_sha`, so the board alone cannot see the movement. */
  repoProgressed: boolean;
}

export function classifyWorkerExit(args: ClassifyArgs): ExitOutcome {
  const { row, nonArchivedChildCount, exitCode, progressed } = args;
  const state = row.workflow_state ?? null;

  // 1. The worker paused for a human (brief filed / exchange open) — the clean one-shot exit.
  if (row.awaiting_human_input === true) return { action: 'wait' };

  // 2. The ticket reached a terminal state — the conduction is done. Exact allowlist membership.
  if (state !== null && (TICKET_TERMINAL_STATES as readonly string[]).includes(state)) {
    return { action: 'complete' };
  }

  // 3. Split-umbrella: the worker decomposed the ticket into live children and exited.
  if (state === 'Decomposed' && nonArchivedChildCount >= 1 && row.awaiting_human_input === false) {
    return { action: 'complete' };
  }

  // 4. Stale ticket ⇒ the conduction parks (a human must reconcile via harmony-stale-patch).
  if (row.stale === true) return { action: 'park', reason: 'stale' };

  // 5. This daemon's own deadline fired (B-739). Placed HERE, at the dirty-exit position, and
  //    deliberately NOT at the top: branches 1-4 must still win, so a worker that filed a brief,
  //    drove the ticket terminal, or produced a live split umbrella BEFORE it hung is still
  //    classified on what the ticket row proves. The deadline stops a stuck worker; it must never
  //    discard an outcome that genuinely landed. Its own class (not 'dirty-exit') is what keeps it
  //    out of B-713's retry ladder, which is guarded on cls === 'dirty-exit' — a run that burned a
  //    generous deadline without exiting is structurally stuck, not transient, so it parks first
  //    time. Retry remains available as a HUMAN action via Re-conduct.
  if (args.timedOut) return { action: 'park', reason: 'worker-timeout' };

  // 6. Dirty exit — non-zero or unknown code with nothing above explaining it.
  if (exitCode !== 0) return { action: 'park', reason: 'dirty-exit' };

  // 7. Clean exit that moved nothing and paused nothing on the BOARD — but the repo may still have
  //    moved (a commit/push/PR head advanced with no state-advancing write yet possible). Distinguish
  //    the two park reasons so a human triaging parked conductions can tell "finished real work,
  //    just didn't write the board" apart from "genuinely stuck" — see clean-exit-contract.md.
  //    Distinguishability only: neither reason auto-requeues or retries.
  if (!progressed) {
    return args.repoProgressed
      ? { action: 'park', reason: 'repo-active-board-silent' }
      : { action: 'park', reason: 'no-progress' };
  }

  // Fallthrough: clean, progressed, ball still agent-side — keep the conduction active; the next
  // pass's wake detection fires a fresh worker.
  return { action: 'wait' };
}

/** The `last_worker_exit_class` label for an outcome (recorded on the conduction row). */
export function exitClass(outcome: ExitOutcome, args: ClassifyArgs): string {
  if (outcome.action === 'park') return outcome.reason;
  if (outcome.action === 'complete') {
    const state = args.row.workflow_state ?? null;
    return state !== null && (TICKET_TERMINAL_STATES as readonly string[]).includes(state)
      ? 'terminal'
      : 'split-umbrella';
  }
  return 'clean-pause';
}
