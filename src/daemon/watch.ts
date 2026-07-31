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

// B-691: the gate rule comes from the shared ball-axis authority, which the interactive poll consumes
// too — the two surfaces can no longer drift, because there is only one statement of the rule. (The
// types come from there as well, so the daemon no longer imports its core types from the conductor.)
import {
  ballWithHuman,
  ballReturned,
  exchangeWentInactive,
  type Taskish,
  type ActiveExchangeish,
} from '../conductor/ball-axis.js';

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

/** Project the stored baseline back into the row shape the shared ball-axis predicates take. */
function asTaskish(baseline: WatchBaseline): Taskish {
  return {
    awaiting_human_input: baseline.awaitingHumanInput,
    active_exchange: baseline.activeExchange,
  };
}

/**
 * Compare a fresh read against the stored baseline and report whether the ball returned to the
 * agent. Returns null while the human still owns the move (keep watching).
 *
 * B-691: `baseline` is the PREVIOUS READ — the scheduler rolls it forward on every no-wake pass, not
 * only after a worker exits. With a pinned baseline, a conduction first seen before its pause existed
 * could never wake.
 */
export function detectWake(baseline: WatchBaseline, current: Taskish): WakeSignal | null {
  const previous = asTaskish(baseline);

  // Canonical flip: the ball was with the human on the previous read and is no longer.
  if (ballReturned(previous, current)) return 'agent-ball';

  // First pickup: the ball was not with the human on either read, so it is the agent's — a
  // just-created conduction (`harmony conduct` files no brief), or a leg that ended with something
  // still outstanding for the agent to consume.
  //
  // B-691: this deliberately no longer requires the absence of a pending_resolution or an active
  // exchange. Those are AGENT-side markers: a flag-down row carrying submitted answers or a browser
  // reshape is the agent's ball WITH work outstanding, and requiring their absence made exactly that
  // state unwakeable — a conduction first seen with an already-answered exchange sat forever. The
  // fired worker re-derives state and consumes any marker at its own step 1 (B-696 spec §3), so the
  // watch does not need to pre-qualify what is waiting; it only needs to know whose turn it is.
  // Re-firing is bounded by the lease and the worker-running guard, not by these conditions.
  if (!ballWithHuman(previous) && !ballWithHuman(current)) return 'agent-ball';

  // B-611/B-461 edge — checked OUTSIDE the flag gate (the flag never transitions on a mechanical
  // cancel): the previous read's ACTIVE exchange went non-active without the flip.
  if (exchangeWentInactive(previous, current)) return 'discussion-cancelled';

  return null;
}
