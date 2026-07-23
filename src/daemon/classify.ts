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
//   5. non-zero (or unknown) exitCode                  ⇒ park     / 'dirty-exit'
//   6. exitCode=0, flag false, progressed=false        ⇒ park     / 'no-progress'
//
// Park is IMMEDIATE — no auto-retry (Accepted design d153970b); a parked conduction waits for a
// human. Fallthrough (clean exit, progressed, ball still agent-side) is a wait: the next pass's
// wake detection re-fires.
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

  // 5. Dirty exit — non-zero or unknown code with nothing above explaining it.
  if (exitCode !== 0) return { action: 'park', reason: 'dirty-exit' };

  // 6. Clean exit that moved nothing and paused nothing — the worker spun; park for a human.
  if (!progressed) return { action: 'park', reason: 'no-progress' };

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
