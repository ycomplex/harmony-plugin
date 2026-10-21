// B-1157: the declared external wait — a leg that exits clean because it is waiting on something
// OUTSIDE the board (a CI run, a PR state change, an off-board human step such as the founder's
// ./promote-prod.sh) writes a ticket-row marker `field_values.waiting_on` through the existing
// update_task tool, and the conduction is HELD (stays active) instead of parked 'no-progress'.
//
// The marker is a CLAIM the daemon verifies, never trusts blindly: it only counts while LIVE —
// well-formed, written during THIS leg (a marker left by an earlier leg must not hold this one), and
// inside the 24h ceiling measured from `first_since` (so a re-declaration cannot extend the wait
// forever). Everything here is derived from the ticket row alone, so a hold survives a daemon restart.
//
// Pure functions, no I/O, never throw.

export const WAIT_CEILING_MS = 24 * 60 * 60 * 1000;
export const WAIT_DEFAULT_RECHECK_MS = 15 * 60 * 1000;

export const WAITING_ON_KINDS = ['ci', 'pr-state', 'human-step'] as const;
export type WaitingOnKind = (typeof WAITING_ON_KINDS)[number];

export interface WaitingOn {
  kind: WaitingOnKind;
  ref: string;
  /** ISO — when THIS declaration was written. */
  since: string;
  /** ISO — when the wait was first declared; preserved across re-declarations, anchors the ceiling. */
  first_since: string;
  /** ISO — when the held conduction should next fire a re-check leg. */
  resume_after?: string;
}

function validIso(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

/** Tolerant parse of `field_values.waiting_on`; anything malformed reads as null. */
export function parseWaitingOn(fieldValues: unknown): WaitingOn | null {
  if (fieldValues === null || typeof fieldValues !== 'object') return null;
  const raw = (fieldValues as Record<string, unknown>).waiting_on;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (!(WAITING_ON_KINDS as readonly unknown[]).includes(m.kind)) return null;
  if (typeof m.ref !== 'string' || m.ref.trim() === '') return null;
  if (!validIso(m.since) || !validIso(m.first_since)) return null;
  if (m.resume_after !== undefined && m.resume_after !== null && !validIso(m.resume_after)) return null;
  return {
    kind: m.kind as WaitingOnKind,
    ref: m.ref,
    since: m.since,
    first_since: m.first_since,
    ...(typeof m.resume_after === 'string' ? { resume_after: m.resume_after } : {}),
  };
}

/** The marker, only while it is LIVE: valid, not left over from before this leg fired, inside the ceiling. */
export function liveWaitingOn(
  fieldValues: unknown,
  opts: { firedAtMs?: number; nowMs: number },
): WaitingOn | null {
  const w = parseWaitingOn(fieldValues);
  if (!w) return null;
  if (opts.firedAtMs !== undefined && Date.parse(w.since) < opts.firedAtMs) return null;
  if (opts.nowMs >= Date.parse(w.first_since) + WAIT_CEILING_MS) return null;
  return w;
}

/** When the held conduction should next re-check: resume_after, else since + the default recheck,
 *  never later than the ceiling. */
export function waitResumeAtMs(w: WaitingOn): number {
  const ceiling = Date.parse(w.first_since) + WAIT_CEILING_MS;
  const wanted = w.resume_after ? Date.parse(w.resume_after) : Date.parse(w.since) + WAIT_DEFAULT_RECHECK_MS;
  return Math.min(wanted, ceiling);
}

/** The ticket-row fields strandedWorkSignal reads (a getTask meta result is structurally assignable). */
export interface StrandedWorkRow {
  awaiting_human_input?: boolean | null;
  active_exchange?: { answers_submitted_at?: string | null; force_quit_requested_at?: string | null } | null;
  pending_resolution?: unknown;
  pending_acceptance_event_id?: string | null;
}

/** B-1157: does a FRESH post-exit read show work stranded by a late write (a human answered, flipped
 *  the ball, reshaped or accepted after the leg's last read)? Returns the `late-<reason>` exit class,
 *  else null. Order is the priority when several are present. */
export function strandedWorkSignal(fresh: StrandedWorkRow): string | null {
  if (fresh.active_exchange && (fresh.active_exchange.answers_submitted_at != null || fresh.active_exchange.force_quit_requested_at != null)) {
    return 'late-answers-landed';
  }
  if (fresh.awaiting_human_input === true) return 'late-human-ball';
  if (fresh.pending_resolution !== null && fresh.pending_resolution !== undefined) return 'late-reshape';
  if (fresh.pending_acceptance_event_id !== null && fresh.pending_acceptance_event_id !== undefined) return 'late-acceptance';
  return null;
}
