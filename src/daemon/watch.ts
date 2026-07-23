// B-696: the daemon's wake detection — WHEN does the ball return to the agent?
//
// The daemon watches every active conduction's ticket row (getTask view:'meta') and fires a fresh
// one-shot worker the moment the agent owns the next move. Two wake signals (Accepted design
// d153970b):
//
//   'agent-ball'            — the canonical signal: `awaiting_human_input` flipped true→false (the
//                             human resolved whatever the worker paused on), OR the flag is already
//                             false at baseline with no active brief/exchange (first pickup after
//                             `harmony conduct` — the ball STARTS with the agent).
//   'discussion-cancelled'  — the B-611 blind-spot edge: a mechanical cancel concludes the attached
//                             exchange ('abandoned') and restores `awaiting_human_input = true`
//                             DIRECTLY, so the canonical true→false transition never happens. The
//                             signal is the baseline's ACTIVE exchange going non-active (status
//                             changed / row gone) with NO flag transition.
//
// Pure functions, no I/O — the scheduler (scheduler.ts) owns reads and timing. Semantics mirror
// src/conductor/poll-loop.ts's gate-then-classify (same defect class, different consumer: the poll
// resolves an in-session pause; the daemon launches a fresh worker).

import type { Taskish, ActiveExchangeish } from '../conductor/poll-loop.js';

export type WakeSignal = 'agent-ball' | 'discussion-cancelled';

/** The per-conduction state the daemon holds between passes, diffed against every fresh read. */
export interface WatchBaseline {
  awaitingHumanInput: boolean | null;
  activeExchange: ActiveExchangeish | null;
}

export function captureBaseline(row: Taskish): WatchBaseline {
  return {
    awaitingHumanInput: row.awaiting_human_input ?? null,
    activeExchange: row.active_exchange ?? null,
  };
}

/** B-611/B-461 (mirrors poll-loop.ts): the baseline's ACTIVE exchange is no longer active on the
 *  current read — status changed, row gone from the active projection, or a different exchange
 *  replaced it. A current read of the SAME exchange with the status field simply absent is
 *  INDETERMINATE, not a cancel. */
function baselineExchangeWentInactive(
  base: ActiveExchangeish | null,
  cur: ActiveExchangeish | null,
): boolean {
  if (base == null || base.status !== 'active') return false;
  if (cur == null) return true;
  if ((cur.exchange_id ?? null) !== (base.exchange_id ?? null)) return true;
  return cur.status != null && cur.status !== 'active';
}

/**
 * Compare a fresh read against the stored baseline and report whether the ball returned to the
 * agent. Returns null while the human still owns the move (keep watching).
 */
export function detectWake(baseline: WatchBaseline, current: Taskish): WakeSignal | null {
  const curFlag = current.awaiting_human_input ?? null;

  // Canonical flip: the baseline was awaiting a human; the fresh read no longer is.
  if (baseline.awaitingHumanInput === true && curFlag === false) return 'agent-ball';

  // First pickup: the flag was ALREADY false at baseline (a just-created conduction — `harmony
  // conduct` files no brief) and nothing awaits a human anywhere: no flag, no active brief marker,
  // no active exchange. The ball starts with the agent.
  if (
    baseline.awaitingHumanInput !== true &&
    curFlag !== true &&
    (current.pending_resolution ?? null) == null &&
    (current.active_exchange ?? null) == null
  ) {
    return 'agent-ball';
  }

  // B-611 edge — checked OUTSIDE the flag gate (the flag never transitions on a mechanical
  // cancel): the baseline's ACTIVE exchange went non-active without the flip.
  if (baselineExchangeWentInactive(baseline.activeExchange, current.active_exchange ?? null)) {
    return 'discussion-cancelled';
  }

  return null;
}
