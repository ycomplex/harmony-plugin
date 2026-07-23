// B-532: the pure, dependency-injected core of the conductor's background watch.
//
// The conductor (skills/harmony-conduct, §4c) launches a bundled background poll script
// (src/bin/poll.ts → dist/bin/poll.js) via Bash(run_in_background) after surfacing a brief at a
// controlled pause. That script reads the ticket via the IN-PROCESS shared core (getTask), captures a
// baseline + an anchored launch stamp, and drives THIS loop. The loop watches one Harmony ticket and
// resolves the instant something the human did becomes visible — or after a bounded ~90-minute window.
//
// This module is deliberately pure: time (`now`), waiting (`sleep`), and the read (`readTask`) are all
// INJECTED, so the whole loop — change detection, the elapsed-anchored window, and the backoff schedule —
// is unit-testable with a fake clock and a fake reader, no real timers or network. The entrypoint
// (src/bin/poll.ts) supplies the real `Date.now`, a real `setTimeout` sleep, and a real `getTask` read.

/** The subset of a Harmony task row the watch cares about (a `getTask` result is structurally assignable). */
export interface Taskish {
  workflow_state?: string | null;
  pending_resolution?: PendingResolutionish | null;
  awaiting_human_input?: boolean | null;
  active_exchange?: ActiveExchangeish | null;
  pending_remark?: PendingRemarkish | null;
}

/** The browser-submitted reshape marker (`briefs.pending_resolution`); shape mirrors PendingResolution. */
export interface PendingResolutionish {
  command?: string;
  detail?: string | null;
}

/** get_task's compact active-elicitation-exchange projection (B-645); shape mirrors
 *  ActiveExchangeSummary. The watch only classifies on the two consumable markers. */
export interface ActiveExchangeish {
  exchange_id?: string;
  status?: string;
  round?: number;
  answers_submitted_at?: string | null;
  force_quit_requested_at?: string | null;
}

/** get_task's unconsumed accept-with-remark projection (B-503); shape mirrors PendingRemark. */
export interface PendingRemarkish {
  brief_id?: string;
  reason?: string;
  detail?: string | null;
}

/** The state captured at launch, against which every poll is compared. */
export interface PollBaseline {
  workflowState?: string | null;
  pendingResolution?: PendingResolutionish | null;
  awaitingHumanInput?: boolean | null;
  activeExchange?: ActiveExchangeish | null;
  pendingRemark?: PendingRemarkish | null;
}

/**
 * What the human did, CLASSIFIED after the exit gate fires (B-611). The sole exit gate is the canonical
 * `awaiting_human_input` true→false transition; the post-gate classifications mirror the §4c
 * consume cases. `answers-landed` (B-645) is a submitted elicitation round (or a force-quit request) — the
 * agent reads the answers via get_elicitation and files the next round / concludes. `discuss-requested`
 * (B-461) is a browser Discuss on the active brief (`pending_resolution.command === 'discuss'`) — the agent
 * opens a discussion exchange rather than re-composing. `resolved` is the non-advancing case (the flag
 * cleared with no state advance / reshape / discuss / exchange answer / park — e.g. a design sub-track
 * accept composed with `pending_activity: null`).
 *
 * ONE classification fires OUTSIDE the flag gate: `discussion-cancelled` (B-461) — a mechanical cancel
 * concluded the attached exchange ('abandoned') and restored `awaiting_human_input = true` DIRECTLY, so
 * the canonical true→false transition never happens (the B-611 blind-spot class). It is detected as the
 * baseline's ACTIVE exchange going non-active (status changed / row gone) without the flag transition.
 *
 * B-503 (accept-with-remark): an unconsumed remark is NOT a trigger of its own — it rides on
 * `ChangeDetail.pending_remark` ALONGSIDE whichever post-gate classification fired (an accept with a
 * remark both advances state and carries the remark; the classifier reports BOTH).
 */
export type ChangeTrigger =
  | 'state-advanced'
  | 'pending_resolution'
  | 'discuss-requested'
  | 'parked'
  | 'answers-landed'
  | 'discussion-cancelled'
  | 'resolved';

export interface ChangeDetail {
  trigger: ChangeTrigger;
  workflow_state?: string | null;
  pending_resolution?: PendingResolutionish | null;
  active_exchange?: ActiveExchangeish | null;
  /** B-503: an unconsumed accept-with-remark, carried ALONGSIDE the trigger (never a trigger of its
   *  own — an accept WITH a remark both advances state AND carries the remark, and the classifier
   *  must report BOTH; collapsing them into one trigger is the B-611 swallow class). */
  pending_remark?: PendingRemarkish | null;
}

export type PollResult =
  | { reason: 'changed'; detail: ChangeDetail }
  | { reason: 'timeout' };

// ── Cadence / backoff (tunable) ───────────────────────────────────────────────────────────────────
// The total watch window — long enough for the human to step away and resolve from the browser later,
// bounded so an abandoned session doesn't spin forever (§4c: "~90 minutes").
export const WATCH_WINDOW_MS = 90 * 60 * 1000;

// The backoff is keyed on ELAPSED-since-launch (never on a poll counter), so it composes cleanly with the
// anchored window. Early: a tight ~120s poll while the human is likely present (keeps the prompt cache
// warm). Steady: back off but stay under ~300s. Tail: once clearly idle, widen to a coarse ~900s poll.
export const POLL_CADENCE = {
  /** First poll delay — ~2 min (§4c "first poll ~120s"). */
  firstDelayMs: 120_000,
  /** Steady delay — kept under ~300s so a present human isn't kept waiting (§4c "under ~300s"). */
  steadyDelayMs: 240_000,
  /** Coarse tail delay once clearly idle — ~15 min (§4c "widen to a coarse tail ~900s"). */
  tailDelayMs: 900_000,
  /** After the first ~2-min poll, settle into the steady cadence. */
  steadyAfterMs: 120_000,
  /** After ~30 min with no change, widen to the coarse tail. */
  tailAfterMs: 30 * 60 * 1000,
} as const;

/** The default elapsed→delay schedule: ramps first(120s) → steady(<300s) → coarse tail(~900s). */
export function defaultCadence(elapsedMs: number): number {
  if (elapsedMs < POLL_CADENCE.steadyAfterMs) return POLL_CADENCE.firstDelayMs;
  if (elapsedMs < POLL_CADENCE.tailAfterMs) return POLL_CADENCE.steadyDelayMs;
  return POLL_CADENCE.tailDelayMs;
}

function pendingPresent(pr: PendingResolutionish | null | undefined): pr is PendingResolutionish {
  return pr != null;
}

function samePending(
  a: PendingResolutionish | null | undefined,
  b: PendingResolutionish | null | undefined,
): boolean {
  if (!pendingPresent(a) && !pendingPresent(b)) return true;
  if (!pendingPresent(a) || !pendingPresent(b)) return false;
  return a.command === b.command && (a.detail ?? null) === (b.detail ?? null);
}

/** An exchange marker is present when the active exchange carries an unconsumed web→agent stamp:
 *  submitted answers OR a force-quit request (B-645). */
function exchangeMarkerPresent(ex: ActiveExchangeish | null | undefined): ex is ActiveExchangeish {
  return ex != null && (ex.answers_submitted_at != null || ex.force_quit_requested_at != null);
}

/** B-461: the baseline's ACTIVE exchange is no longer active on the current read — its status changed,
 *  the row is gone from the active projection (get_task's `active_exchange` only surfaces status='active'
 *  rows, so a cancelled exchange reads as null), or a different exchange has replaced it. Requires the
 *  baseline exchange to have been captured as ACTIVE (fetchActiveExchange always stamps status). A current
 *  read of the SAME exchange with the status field simply absent is INDETERMINATE, not a cancel — keep
 *  polling (a real cancel presents as row-gone or an explicit non-active status). */
function baselineExchangeWentInactive(
  base: ActiveExchangeish | null | undefined,
  cur: ActiveExchangeish | null | undefined,
): boolean {
  if (base == null || base.status !== 'active') return false;
  if (cur == null) return true;
  if ((cur.exchange_id ?? null) !== (base.exchange_id ?? null)) return true;
  return cur.status != null && cur.status !== 'active';
}

/** B-503: same remark ⇔ same brief + identical detail. A remark equal to the baseline's is STALE
 *  (it was already unconsumed at launch — the previous consumer owns it), never fresh news. */
function sameRemark(
  a: PendingRemarkish | null | undefined,
  b: PendingRemarkish | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return (a.brief_id ?? null) === (b.brief_id ?? null) && (a.detail ?? null) === (b.detail ?? null);
}

/** B-503: attach a genuinely-new unconsumed accept-with-remark ALONGSIDE whatever post-gate
 *  classification fired — never instead of it (the B-611 swallow class: an accept WITH a remark
 *  both advances state AND carries the remark; the classifier must report BOTH). A remark already
 *  present at baseline is stale and never attached. */
function withRemark(detail: ChangeDetail, baseline: PollBaseline, task: Taskish): ChangeDetail {
  const remark = task.pending_remark ?? null;
  if (remark != null && !sameRemark(remark, baseline.pendingRemark)) {
    return { ...detail, pending_remark: remark };
  }
  return detail;
}

/** Same marker ⇔ same exchange + identical stamps. Timestamps make this exact: a fresh submit always
 *  carries a new answers_submitted_at, so a marker equal to the baseline's is stale, never news. */
function sameExchangeMarker(
  a: ActiveExchangeish | null | undefined,
  b: ActiveExchangeish | null | undefined,
): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return (
    (a.exchange_id ?? null) === (b.exchange_id ?? null) &&
    (a.answers_submitted_at ?? null) === (b.answers_submitted_at ?? null) &&
    (a.force_quit_requested_at ?? null) === (b.force_quit_requested_at ?? null)
  );
}

/**
 * Compare a freshly-read task against the launch baseline and report what (if anything) the human did.
 *
 * GATE-THEN-CLASSIFY (B-611). The flag-based exit signal is the canonical "human resolved" primitive:
 * `awaiting_human_input` transitioning true→false (the baseline was awaiting; the fresh read no longer is).
 * Until that flag clears, nothing the human could have done is consumable yet — so we return null and keep
 * polling regardless of any incidental state / pending_resolution difference, with ONE exception checked
 * OUTSIDE the gate (B-461): `discussion-cancelled` — the baseline's ACTIVE exchange went non-active
 * (status changed / row gone) WITHOUT the true→false transition, because a mechanical cancel restores
 * `awaiting_human_input = true` directly (the B-611 blind-spot class — the flag gate alone would miss it).
 * Once the gate fires, we CLASSIFY what the human did, in priority order (mirrors the §4c consume cases):
 *   1. `parked`             — the ticket is now Parked (a browser defer/deny). Surfaced explicitly because it
 *                             is terminal and must not be mistaken for a forward advance.
 *   2. `state-advanced`     — `workflow_state` differs from the baseline (a browser accept advanced the gate).
 *   3. `pending_resolution` — a browser reshape left a (new/changed) `pending_resolution` marker on the
 *                             active brief with the state unchanged. When the marker's command is 'discuss'
 *                             (B-461) this classifies as `discuss-requested` instead — a request to open a
 *                             discussion exchange on the active brief, not a reshape.
 *   4. `answers-landed`     — (B-645) the active elicitation exchange carries an unconsumed marker: the human
 *                             submitted a round's answers (`answers_submitted_at`) or requested a force-quit
 *                             (`force_quit_requested_at`). The consumer reads the answers via get_elicitation
 *                             and files the next round / concludes.
 *   5. `resolved`           — the flag cleared but state is unchanged and there is no new marker of any kind:
 *                             a NON-ADVANCING accept (the B-611 case — a design sub-track brief composed with
 *                             `pending_activity: null` clears `awaiting_human_input` without advancing /
 *                             reshaping / parking). A real resolution to continue the loop on, NOT a timeout.
 * Order matters: Parked is checked before the generic state-diff so a defer/deny reports `parked`; the
 * pending_resolution and answers-landed checks require the marker to be genuinely new (present and not equal
 * to the baseline marker) so a pre-existing marker can't change the classification; and `answers-landed` MUST
 * precede `resolved` — an elicitation round-submit clears the flag with no state change, so without step 4 it
 * would misclassify as the B-611 non-advancing-accept case and the answers would never be consumed.
 */
export function detectChange(baseline: PollBaseline, task: Taskish): ChangeDetail | null {
  // GATE (B-611): the SOLE flag-based exit signal is awaiting_human_input transitioning true→false.
  const gateFired = baseline.awaitingHumanInput === true && task.awaiting_human_input === false;

  if (!gateFired) {
    // B-461 'discussion-cancelled' — deliberately its OWN check, NOT inside the flag-gated
    // classification (the B-611 blind-spot class): a mechanical cancel concludes the attached
    // exchange ('abandoned') and restores awaiting_human_input = true DIRECTLY, so the canonical
    // true→false transition never happens and the flag gate alone would miss it. The signal is the
    // baseline's ACTIVE exchange going non-active (status changed / row gone) without the flag
    // transition. The poll exits on it like any other classification.
    if (baselineExchangeWentInactive(baseline.activeExchange, task.active_exchange ?? null)) {
      return { trigger: 'discussion-cancelled', workflow_state: task.workflow_state ?? null };
    }
    // Until the human resolves (the flag drops), nothing else is consumable — keep polling no matter
    // what else looks different.
    return null;
  }

  const state = task.workflow_state ?? null;
  const baseState = baseline.workflowState ?? null;

  // CLASSIFY (post-gate) in §4c priority order. Every post-gate classification passes through
  // withRemark (B-503): an unconsumed accept-with-remark rides ALONGSIDE the trigger — a browser
  // accept that carried a remark both advances state ('state-advanced') AND leaves the remark, and
  // the consumer must see BOTH (dropping either is the B-611 swallow class).
  if (state === 'Parked') {
    return withRemark({ trigger: 'parked', workflow_state: state }, baseline, task);
  }
  if (state !== baseState) {
    return withRemark({ trigger: 'state-advanced', workflow_state: state }, baseline, task);
  }
  const pr = task.pending_resolution ?? null;
  if (pendingPresent(pr) && !samePending(pr, baseline.pendingResolution)) {
    // B-461: a browser Discuss leaves the same marker shape with command='discuss' — that is a request
    // to OPEN a discussion exchange on the active brief, not a reshape; everything else keeps the
    // existing 'pending_resolution' (reshape) classification.
    if (pr.command === 'discuss') {
      return withRemark({ trigger: 'discuss-requested', workflow_state: state, pending_resolution: pr }, baseline, task);
    }
    return withRemark({ trigger: 'pending_resolution', workflow_state: state, pending_resolution: pr }, baseline, task);
  }
  // B-645: an unconsumed exchange marker (submitted answers / force-quit request) — checked BEFORE
  // 'resolved' so a round-submit (flag cleared, state unchanged) is never mistaken for the B-611
  // non-advancing accept. Like pending_resolution, the marker must be genuinely new vs the baseline.
  const ex = task.active_exchange ?? null;
  if (exchangeMarkerPresent(ex) && !sameExchangeMarker(ex, baseline.activeExchange)) {
    return withRemark({ trigger: 'answers-landed', workflow_state: state, active_exchange: ex }, baseline, task);
  }
  // The flag cleared with no advance / reshape / exchange answer / park — a non-advancing sub-track
  // accept (B-611). An accept-with-remark on a non-advancing accept still attaches the remark.
  return withRemark({ trigger: 'resolved', workflow_state: state }, baseline, task);
}

/**
 * The "no change" shape a transient read error degrades to: the baseline projected back as a fresh read.
 * Correctness-critical (B-611): it carries `awaiting_human_input` from the baseline, so a failed poll reads
 * as "still awaiting" and the exit gate cannot false-trip on it — a transient read error must NEVER look
 * like a human resolution. Extracted as a pure helper so the fallback shape is unit-testable.
 */
export function baselineReadFallback(baseline: PollBaseline): Taskish {
  return {
    workflow_state: baseline.workflowState,
    pending_resolution: baseline.pendingResolution,
    awaiting_human_input: baseline.awaitingHumanInput,
    active_exchange: baseline.activeExchange,
    pending_remark: baseline.pendingRemark,
  };
}

export interface PollLoopOpts {
  /** Reads the watched task. The entrypoint injects `() => getTask(client, projectId, { task_id })`. */
  readTask: () => Promise<Taskish>;
  /** The clock. The entrypoint injects `Date.now`. */
  now: () => number;
  /** Awaits `ms` milliseconds. The entrypoint injects a real setTimeout-based sleep. */
  sleep: (ms: number) => Promise<void>;
  /** The clock value captured ONCE at launch — the anchor the window is measured against (B-548). */
  launchStamp: number;
  /** The state captured at launch to diff every poll against. */
  baseline: PollBaseline;
  /** Total watch window; defaults to WATCH_WINDOW_MS (~90 min). */
  windowMs?: number;
  /** Elapsed→delay schedule; defaults to {@link defaultCadence}. */
  cadence?: (elapsedMs: number) => number;
}

/**
 * Watch one ticket until it changes or the bounded window expires.
 *
 * - Reads FIRST each iteration, so a change already visible at launch is caught before any sleep.
 * - Exits `{ reason: 'changed', detail }` on the first detected change (see {@link detectChange}).
 * - Exits `{ reason: 'timeout' }` once `now() - launchStamp >= windowMs`.
 *
 * B-548 GUARD: elapsed is ALWAYS `now() - launchStamp`, measured against the anchored launch stamp passed
 * in — it is never accumulated from sleep durations and never conflated with the budget. The final sleep
 * is capped to the remaining window so the loop wakes at most at the window boundary rather than overshoot.
 */
export async function runPollLoop(opts: PollLoopOpts): Promise<PollResult> {
  const windowMs = opts.windowMs ?? WATCH_WINDOW_MS;
  const cadence = opts.cadence ?? defaultCadence;

  for (;;) {
    const task = await opts.readTask();
    const change = detectChange(opts.baseline, task);
    if (change) return { reason: 'changed', detail: change };

    const elapsed = opts.now() - opts.launchStamp;
    if (elapsed >= windowMs) return { reason: 'timeout' };

    const remaining = windowMs - elapsed;
    const delay = Math.min(cadence(elapsed), remaining);
    await opts.sleep(delay);
  }
}
