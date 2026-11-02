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

export const WAITING_ON_KINDS = ['ci', 'pr-state', 'human-step', 'model-handoff'] as const;
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

/** The ticket-row shapes the declared-wait marker can arrive in: the `view:'meta'` projection's own
 *  `waiting_on` key (what the daemon and `tasks clean-check` actually read — meta's `field_values`
 *  is branch-only since B-1058, so the wait can never ride it there), or a full row's
 *  `field_values.waiting_on`. */
export interface WaitingOnCarrier {
  waiting_on?: unknown;
  field_values?: unknown;
}

/** Adapt a task row to the `{ waiting_on }` shape `parseWaitingOn` reads. The meta key wins; a full
 *  row's field_values is the fallback so both projections work. */
export function waitingOnFieldValues(task: WaitingOnCarrier | null | undefined): unknown {
  if (!task) return null;
  if (task.waiting_on !== undefined && task.waiting_on !== null) return { waiting_on: task.waiting_on };
  return task.field_values ?? null;
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

/** The identity of each stranded-work signal on a row — the VALUE that makes two sightings "the same
 *  signal" — or null when the row does not carry it. */
function strandedValue(row: StrandedWorkRow, code: 'answers' | 'reshape' | 'acceptance'): string | null {
  if (code === 'answers') {
    const a = row.active_exchange?.answers_submitted_at ?? null;
    const f = row.active_exchange?.force_quit_requested_at ?? null;
    return a !== null || f !== null ? `${a ?? ''}|${f ?? ''}` : null;
  }
  if (code === 'reshape') {
    // Any staged marker (iterate, discuss, edited-in-tool — B-1204) is stranded work; the value is the
    // whole marker JSON, so the command is not inspected and a new command needs no case here.
    return row.pending_resolution !== null && row.pending_resolution !== undefined ? JSON.stringify(row.pending_resolution) : null;
  }
  return row.pending_acceptance_event_id ?? null;
}

/** B-1157: does a FRESH post-exit read show work stranded by a LATE write (a human answered, reshaped or
 *  accepted after the leg's last read)? Returns the `late-<reason>` exit class, else null. Order is the
 *  priority when several are present.
 *
 *  `seen` are worker launch snapshots: input those legs already had their chance at. A conductor's
 *  post-exit read is not a worker observation and must not be included (B-1251). A signal whose value
 *  is the SAME on any launch snapshot is NOT late:
 *  the leg could have consumed it and did not (a bug, a refused consume, a malformed answer), and
 *  keeping the conduction active on it would loop legs forever instead of parking no-progress as today.
 *  Only a signal that DIFFERS from every seen row (new, or changed) counts. `late-human-ball` is not
 *  compared: a human-held ball does not wake a leg, so it cannot loop. */
export function strandedWorkSignal(fresh: StrandedWorkRow, seen: readonly StrandedWorkRow[] = []): string | null {
  const isNew = (code: 'answers' | 'reshape' | 'acceptance'): boolean => {
    const v = strandedValue(fresh, code);
    return v !== null && !seen.some((s) => strandedValue(s, code) === v);
  };
  if (isNew('answers')) return 'late-answers-landed';
  if (fresh.awaiting_human_input === true) return 'late-human-ball';
  if (isNew('reshape')) return 'late-reshape';
  if (isNew('acceptance')) return 'late-acceptance';
  return null;
}

/** Only standalone marker lines count; examples in fences and quoted prose are not declarations. */
export interface WaitComment { content: string; created_at: string }
export function waitCommentEvents(comments: readonly WaitComment[]) {
  const events: Array<{ ref: string; consumed: boolean; at: number }> = [];
  for (const comment of comments) {
    const at = Date.parse(comment.created_at);
    if (!Number.isFinite(at)) continue;
    let fenced = false;
    for (const line of comment.content.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const match = /^WAITING-ON(-CONSUMED)? ref=(\S+)\s*$/.exec(line);
      if (match) events.push({ ref: match[2], consumed: !!match[1], at });
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

/** Infer only a current-leg declaration. The earliest unconsumed same-ref declaration anchors
 * the ceiling even if an earlier recovery's marker was lost. Never resurrect an expired wait. */
export function recoverCommentWait(
  comments: readonly WaitComment[], fieldValues: unknown,
  opts: { firedAtMs?: number; nowMs: number },
): WaitingOn | null {
  if (opts.firedAtMs === undefined || !Number.isFinite(opts.firedAtMs)) return null;
  const events = waitCommentEvents(comments).filter(e => e.at <= opts.nowMs);
  const open = new Map<string, { first: number; last: number }>();
  for (const e of events) {
    if (e.consumed) open.delete(e.ref);
    else open.set(e.ref, { first: open.get(e.ref)?.first ?? e.at, last: e.at });
  }
  const candidate = [...open].filter(([, e]) => e.last >= opts.firedAtMs!)
    .sort((a, b) => b[1].last - a[1].last)[0];
  if (!candidate) return null;
  const [ref, times] = candidate;
  const prior = parseWaitingOn(fieldValues);
  const first = prior?.ref === ref ? Math.min(times.first, Date.parse(prior.first_since)) : times.first;
  const marker: WaitingOn = {
    kind: 'human-step', ref, since: new Date(times.last).toISOString(),
    first_since: new Date(first).toISOString(),
  };
  return liveWaitingOn({ waiting_on: marker }, opts);
}
