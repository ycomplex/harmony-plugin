// B-691: the single authority for "does the human still hold the ball?".
//
// Both conductor watch surfaces need to answer that one question, and before this module each
// answered it separately:
//
//   - src/conductor/poll-loop.ts  (detectChange) — the interactive session watch armed by
//     harmony-conduct at a controlled pause. Needs a 7-way classification to route its in-session
//     consume.
//   - src/daemon/watch.ts         (detectWake)   — the Conductor Daemon's wake detection. Deliberately
//     does NOT classify the resume (B-696 spec §1: the fired worker re-derives state itself), so it
//     needs only a 2-way signal.
//
// They legitimately need different OUTPUTS, so this module deliberately does not unify their return
// types — it unifies the QUESTION. Both derive their gate from the predicates here.
//
// Why this exists at all (B-691, founder amendment A4): daemon/watch.ts documented itself as
// mirroring poll-loop.ts's gate-then-classify, and the divergence that produced the B-691 defect grew
// underneath that comment — the daemon re-captured its baseline after each worker exit while the poll
// never did. Prose parity is not parity. A third watch consumer must consume this module rather than
// re-implement the gate.

/** The subset of a Harmony task row the watch surfaces care about (a `getTask` result is
 *  structurally assignable). Lives here rather than in poll-loop.ts so the daemon does not have to
 *  import its core types from the conductor module. */
export interface Taskish {
  workflow_state?: string | null;
  pending_resolution?: PendingResolutionish | null;
  awaiting_human_input?: boolean | null;
  active_exchange?: ActiveExchangeish | null;
  pending_remark?: PendingRemarkish | null;
}

/** The browser-submitted reshape/discuss marker (`briefs.pending_resolution`). */
export interface PendingResolutionish {
  command?: string;
  detail?: string | null;
}

/** get_task's compact active-elicitation-exchange projection (B-645). */
export interface ActiveExchangeish {
  exchange_id?: string;
  status?: string;
  round?: number;
  answers_submitted_at?: string | null;
  force_quit_requested_at?: string | null;
}

/** get_task's unconsumed accept-with-remark projection (B-503). */
export interface PendingRemarkish {
  brief_id?: string;
  reason?: string;
  detail?: string | null;
}

/**
 * THE predicate: the ball is with the human if and only if `awaiting_human_input` is true.
 *
 * Deliberately keyed on the flag ALONE and never on `awaiting_human_reason` — the reason is
 * unconstrained text (B-732) and a gate that reads it would silently exclude whichever pause kind it
 * failed to enumerate. That mistake is the one B-691's original report guessed at: it supposed the
 * exit gate was blind to `awaiting_human_reason='elicitation-round'`. It never read the reason at
 * all, and it must stay that way.
 */
export function ballWithHuman(row: Taskish): boolean {
  return row.awaiting_human_input === true;
}

/**
 * The canonical return transition: the ball WAS with the human on the previous read and is no longer.
 *
 * `previous` MUST be the immediately preceding read, not a pinned launch-time snapshot. That
 * distinction IS the B-691 defect: with a pinned baseline captured before the pause existed, the flag
 * rising afterwards is invisible and no later clear can ever fire this transition, so the watch burns
 * its whole window in silence. Callers own the rolling; this function only states the rule.
 */
export function ballReturned(previous: Taskish, current: Taskish): boolean {
  return ballWithHuman(previous) && !ballWithHuman(current);
}

/**
 * The B-461 edge that fires OUTSIDE the transition: a mechanical cancel concludes the attached
 * exchange ('abandoned') and restores `awaiting_human_input = true` DIRECTLY, so the canonical
 * true→false transition never happens and a flag-only gate would miss it (the B-611 blind-spot class).
 *
 * The signal is the previous read's ACTIVE exchange going non-active: status changed, the row is gone
 * from the active projection (get_task's `active_exchange` only surfaces status='active' rows, so a
 * cancelled exchange reads as null), or a different exchange has replaced it. A current read of the
 * SAME exchange with the status field simply absent is INDETERMINATE, not a cancel — keep polling.
 */
export function exchangeWentInactive(previous: Taskish, current: Taskish): boolean {
  const base = previous.active_exchange ?? null;
  const cur = current.active_exchange ?? null;
  if (base == null || base.status !== 'active') return false;
  if (cur == null) return true;
  if ((cur.exchange_id ?? null) !== (base.exchange_id ?? null)) return true;
  return cur.status != null && cur.status !== 'active';
}

/**
 * An exchange marker is present when the active exchange carries an unconsumed web→agent stamp:
 * submitted answers OR a force-quit request (B-645). A flag-down row carrying one of these IS the
 * agent's ball with work outstanding — which is why first-pickup must NOT require the absence of an
 * active exchange (the B-691 daemon first-sight variant).
 */
export function hasUnconsumedExchangeMarker(row: Taskish): boolean {
  const ex = row.active_exchange ?? null;
  return ex != null && (ex.answers_submitted_at != null || ex.force_quit_requested_at != null);
}
