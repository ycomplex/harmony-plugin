/**
 * `harmony watch` classifier (B-1422). Pure: no clock, no I/O.
 *
 * `classify(prev, cur, ctx)` turns one ticket's previous cursor entry and its current snapshot into
 * the events the watch reports. "Whose ball" is decided by the shared authority
 * (`src/conductor/ball-axis.ts`), never re-implemented here.
 *
 * Edge rules (level-triggered reminders live in cursor.ts):
 *   - `ready` / `question`: the ball is with a human AND the leg has ended. Reported once per pause
 *     identity (reason, ref id, iteration). `question` replaces `ready` for `elicitation-round`.
 *   - `incident` (B-1452): replaces `question` when the elicitation round's `awaiting_human_ref`
 *     carries `incident` (a leg exposed a credential). Same identity rules; always seat-owned, so it
 *     wakes `--until-event` and is reminded; cursor.ts orders it before every other event.
 *   - `park`: the conduction became `parked`, or the ticket became `Parked`.
 *   - `dirty-exit`: a leg ended with a dirty exit class (see `isDirtyExitClass`).
 *   - `waiting`, `acted`, `state`: info edges; they need a previous entry, so a first run never
 *     replays them.
 *   - `added` / `removed`: the ticket joined / left the scope (not on a first run).
 *   - `idle`: a live conduction with no running leg, the ball not with a human, no `waiting_on`,
 *     and the ticket unchanged for `idleMs`. Once per idle spell.
 */
import { ballWithHuman } from '../conductor/ball-axis.js';
import { TICKET_TERMINAL_STATES } from '../daemon/classify.js';
import { isConductionLive } from '../tools/conduction-record.js';
import type { TicketSnapshot } from './board-read.js';
import type { CursorTicket, SeatProfile } from './seat-files.js';

export type WatchEventName =
  | 'incident'
  | 'ready'
  | 'question'
  | 'park'
  | 'dirty-exit'
  | 'waiting'
  | 'acted'
  | 'state'
  | 'added'
  | 'removed'
  | 'idle'
  | 'health'
  | 'start';

export const WATCH_EVENT_NAMES: readonly WatchEventName[] = [
  'incident',
  'ready',
  'question',
  'park',
  'dirty-exit',
  'waiting',
  'acted',
  'state',
  'added',
  'removed',
  'idle',
  'health',
  'start',
];

export type Owner = 'seat' | 'founder' | 'info';

export interface WatchRef {
  type: string | null;
  id: string | null;
  iteration: number | null;
}

export interface WatchEvent {
  ts: string;
  event: WatchEventName;
  owner: Owner;
  key: string | null;
  title: string | null;
  state: string | null;
  reason: string | null;
  ref: WatchRef | null;
  conduction: string | null;
  leg: { ended: boolean; exit: string | null } | null;
  waiting_on: unknown;
  first_seen: string | null;
  reminder: number;
  /** Cursor seq this event was reported at (set by cursor.ts / loop.ts). */
  cursor: number;
  /** Health events only. */
  status?: 'offline' | 'auth-failed' | 'recovered' | 'degraded' | 'warning';
  since?: string;
  detail?: string;
  /** Task uuid (not part of the printed line's identity; handy for consumers). */
  task_id?: string;
  /** Start event only: the board the watch reads. */
  project?: { name: string; key: string };
  /** Start event only: `prod` / `staging` / `custom`, from the Supabase URL the CLI uses. */
  target?: 'prod' | 'staging' | 'custom';
  /** Start event only: the resolved scope. */
  scope?: { kind: 'milestone'; id: string; name: string | null } | { kind: 'keys'; keys: string[] } | { kind: 'conductions' };
  /** Start event only: how many tickets the scope resolved to. */
  tickets?: number;
}

/** Gate aliases accepted in a seat profile's `owns` / `held_for_founder` (docs/harmony-watch-files.md). */
export const GATE_ALIASES: Readonly<Record<string, string>> = {
  clarify: 'clarification-draft',
  decompose: 'decomposition-proposal',
  design: 'design-decision-draft',
  plan: 'plan-draft',
  release: 'release-decision-pending',
  verify: 'verification-ack-pending',
};

export const DEFAULT_QUIET_MS = 90_000;
export const DEFAULT_IDLE_MS = 30 * 60_000;

export interface ClassifyCtx {
  now: number;
  profile: SeatProfile | null;
  legEndKnown: boolean;
  remindMs: number;
  quietMs?: number;
  idleMs?: number;
  /** True on a first run (no cursor): no `added`, no info replay. */
  initial?: boolean;
  /** Fallback memory of the last exit class seen, for boards without `last_leg_ended_at`. */
  exitSeen?: Map<string, string | null>;
}

/**
 * Exit classes that are NOT a dirty exit. The daemon (src/daemon/classify.ts `exitClass`, and the
 * scheduler's direct writes) labels a crashed / non-zero leg `dirty-exit`; everything it writes for
 * a clean pause, a completion or a deliberate park is listed here. Anything else — `dirty-exit`,
 * any `dirty*` class, or a class this list does not know — is treated as a dirty exit, so an
 * unfamiliar failure wakes the seat rather than passing silently.
 */
export const CLEAN_EXIT_CLASSES: readonly string[] = [
  'clean-pause',
  'waiting-on',
  'terminal',
  'terminal-no-leg',
  'complete',
  'split-umbrella',
  'ticket-parked',
  'ticket-parked-no-leg',
  'ticket-archived',
  'no-progress',
  'repo-active-board-silent',
  'stale',
  'worker-timeout',
  'operator-reap',
  'quota',
  'quota-repeated',
  'rate-limit',
  'fast-track-inadmissible',
  'agent-ineligible',
  'model-handoff',
];

export function isDirtyExitClass(cls: string | null | undefined): boolean {
  if (cls === null || cls === undefined || cls === '') return false;
  if (cls.startsWith('dirty')) return true;
  return !CLEAN_EXIT_CLASSES.includes(cls);
}

function expand(entries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    out.add(e);
    const alias = GATE_ALIASES[e];
    if (alias) out.add(alias);
  }
  return out;
}

/**
 * Who an event belongs to.
 *   - `waiting`, `acted`, `state` and `start` are always `info`.
 *   - `ready` / `question`: decided by the reason. Listed in `held_for_founder` → `founder`; listed in
 *     `owns` → `seat`; listed nowhere → `seat` (fail toward waking). The event name itself is also
 *     accepted as an entry (`ready`, `question`), after the reason.
 *   - `incident` (B-1452): always `seat`, whatever the profile says. Only a human can release it, but
 *     a founder-held item never wakes the seat and is never reminded; an exposed credential must do
 *     both, so the seat surfaces it to the founder at once.
 *   - every other event: `seat`, unless `held_for_founder` lists the event name.
 *   - no profile → `seat`.
 */
export function ownerFor(event: WatchEventName, reason: string | null, profile: SeatProfile | null): Owner {
  if (event === 'waiting' || event === 'acted' || event === 'state' || event === 'start') return 'info';
  if (event === 'incident') return 'seat';
  if (!profile) return 'seat';
  const held = expand(profile.held_for_founder);
  const owns = expand(profile.owns);
  if (event === 'ready' || event === 'question') {
    if (reason !== null) {
      if (held.has(reason)) return 'founder';
      if (owns.has(reason)) return 'seat';
    }
    if (held.has(event)) return 'founder';
    return 'seat';
  }
  return held.has(event) ? 'founder' : 'seat';
}

/** Normalise `awaiting_human_ref` (+ meta) into `{ type, id, iteration }`. */
export function refOf(cur: TicketSnapshot): WatchRef | null {
  if (!cur.awaiting_human_input) return null;
  const raw = (cur.awaiting_human_ref ?? null) as Record<string, unknown> | null;
  const type = raw ? ((raw.type ?? raw.kind ?? null) as string | null) : null;
  const idRaw = raw ? (raw.id ?? raw.exchange_id ?? raw.pr_url ?? raw.pr_number ?? null) : null;
  const id = idRaw === null || idRaw === undefined ? null : String(idRaw);
  let iteration: number | null = null;
  if (raw && typeof raw.round === 'number') iteration = raw.round;
  else if (cur.meta?.active_exchange && typeof cur.meta.active_exchange.round === 'number' && type === 'elicitation')
    iteration = cur.meta.active_exchange.round;
  else if (cur.meta && typeof cur.meta.active_brief_iteration === 'number') iteration = cur.meta.active_brief_iteration;
  return { type, id, iteration };
}

/** A leg is RUNNING iff `leg_started_at` is set and (`last_leg_ended_at` is null or older). */
export function legRunning(cur: TicketSnapshot): boolean {
  const c = cur.conduction;
  if (!c || !c.leg_started_at) return false;
  if (c.last_leg_ended_at === undefined) return true; // unknown column: decided by the quiet fallback
  if (c.last_leg_ended_at === null) return true;
  return Date.parse(c.leg_started_at) > Date.parse(c.last_leg_ended_at);
}

/**
 * Has the leg that filed this pause ended? With the column: not running. Without it (older board):
 * no leg recorded at all, or the pause has held unchanged (task `updated_at`) for `quietMs`.
 */
export function legEnded(cur: TicketSnapshot, ctx: Pick<ClassifyCtx, 'now' | 'legEndKnown' | 'quietMs'>): boolean {
  const c = cur.conduction;
  if (!c || !c.leg_started_at) return true;
  if (ctx.legEndKnown && c.last_leg_ended_at !== undefined) return !legRunning(cur);
  const quiet = ctx.quietMs ?? DEFAULT_QUIET_MS;
  const since = Date.parse(cur.updated_at);
  return !Number.isNaN(since) && ctx.now - since >= quiet;
}

function isTerminal(state: string | null): boolean {
  return state !== null && (TICKET_TERMINAL_STATES as readonly string[]).includes(state);
}

/** B-1452: the pause is an incident round (`awaiting_human_ref.incident` set on an elicitation round). */
export function isIncidentPause(cur: TicketSnapshot): boolean {
  if (cur.awaiting_human_reason !== 'elicitation-round') return false;
  const ref = cur.awaiting_human_ref;
  if (ref === null || typeof ref !== 'object' || Array.isArray(ref)) return false;
  const incident = (ref as Record<string, unknown>).incident;
  return typeof incident === 'string' ? incident.length > 0 : incident !== undefined && incident !== null && incident !== false;
}

/** The ticket's open item, if any: a filed pause (incident/ready/question) or a parked conduction. */
export interface OpenItem {
  event: 'incident' | 'ready' | 'question' | 'park';
  reason: string | null;
  ref: WatchRef | null;
}

export function openItemOf(cur: TicketSnapshot, ctx: Pick<ClassifyCtx, 'now' | 'legEndKnown' | 'quietMs'>): OpenItem | null {
  if (ballWithHuman(cur) && legEnded(cur, ctx)) {
    return {
      event: isIncidentPause(cur) ? 'incident' : cur.awaiting_human_reason === 'elicitation-round' ? 'question' : 'ready',
      reason: cur.awaiting_human_reason,
      ref: refOf(cur),
    };
  }
  if (cur.conduction?.status === 'parked' && !isTerminal(cur.workflow_state)) {
    return { event: 'park', reason: cur.conduction.last_worker_exit_class, ref: null };
  }
  return null;
}

/** Is `prev` (cursor entry) the same open item as `item`? */
export function sameOpenItem(prev: CursorTicket | undefined, item: OpenItem): boolean {
  if (!prev) return false;
  if (item.event === 'park') return !prev.awaiting && prev.conduction_status === 'parked';
  return (
    prev.awaiting === true &&
    prev.reason === item.reason &&
    prev.ref_id === (item.ref?.id ?? null) &&
    // A missing iteration on either side (a meta read that failed) matches, so it never re-reports.
    (prev.iteration === null || (item.ref?.iteration ?? null) === null || prev.iteration === item.ref?.iteration)
  );
}

function isIdle(cur: TicketSnapshot, ctx: ClassifyCtx): boolean {
  const c = cur.conduction;
  if (!c || !isConductionLive(c.status)) return false;
  if (isTerminal(cur.workflow_state)) return false;
  if (ballWithHuman(cur)) return false;
  if (cur.waiting_on !== null && cur.waiting_on !== undefined) return false;
  if (legRunning(cur) && (ctx.legEndKnown || !legEnded(cur, ctx))) return false;
  const since = Date.parse(cur.updated_at);
  return !Number.isNaN(since) && ctx.now - since >= (ctx.idleMs ?? DEFAULT_IDLE_MS);
}

/** The idle condition holds (exported for cursor.ts's spell bookkeeping). */
export function idleNow(cur: TicketSnapshot, ctx: ClassifyCtx): boolean {
  return isIdle(cur, ctx);
}

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function baseEvent(
  event: WatchEventName,
  cur: TicketSnapshot,
  ctx: ClassifyCtx,
  prev: CursorTicket | undefined,
  extra: { reason?: string | null; ref?: WatchRef | null; reminder?: number } = {},
): WatchEvent {
  const reason = extra.reason !== undefined ? extra.reason : cur.awaiting_human_reason;
  return {
    ts: new Date(ctx.now).toISOString(),
    event,
    owner: ownerFor(event, reason, ctx.profile),
    key: cur.key,
    title: cur.title,
    state: cur.workflow_state,
    reason,
    ref: extra.ref !== undefined ? extra.ref : refOf(cur),
    conduction: cur.conduction?.id ?? null,
    leg: cur.conduction ? { ended: legEnded(cur, ctx), exit: cur.conduction.last_worker_exit_class } : null,
    waiting_on: cur.waiting_on ?? null,
    first_seen: prev?.first_seen ?? new Date(ctx.now).toISOString(),
    reminder: extra.reminder ?? 0,
    cursor: 0,
    task_id: cur.id,
  };
}

/** One ticket's edge events. */
export function classify(prev: CursorTicket | undefined, cur: TicketSnapshot, ctx: ClassifyCtx): WatchEvent[] {
  const events: WatchEvent[] = [];
  const push = (e: WatchEvent) => events.push(e);

  if (!prev && !ctx.initial) push(baseEvent('added', cur, ctx, prev));

  // Info edges need a previous read.
  if (prev) {
    if (prev.state !== cur.workflow_state) push(baseEvent('state', cur, ctx, prev));
    if (prev.awaiting && !cur.awaiting_human_input) push(baseEvent('acted', cur, ctx, prev, { reason: prev.reason }));
    if (!jsonEq(prev.waiting_on, cur.waiting_on)) push(baseEvent('waiting', cur, ctx, prev));
  }

  // Dirty exit: a new leg end with a dirty class.
  const cls = cur.conduction?.last_worker_exit_class ?? null;
  if (cur.conduction && isDirtyExitClass(cls)) {
    let fresh: boolean;
    if (ctx.legEndKnown && cur.conduction.last_leg_ended_at !== undefined) {
      fresh = !!cur.conduction.last_leg_ended_at && cur.conduction.last_leg_ended_at !== (prev?.leg_ended_at ?? null);
    } else {
      const seen = ctx.exitSeen?.get(cur.id);
      fresh = seen === undefined ? !prev || ctx.initial === true : seen !== cls;
    }
    if (fresh) push(baseEvent('dirty-exit', cur, ctx, prev, { reason: cls, ref: null }));
  }

  // Park: an open parked conduction is reported once (then reminded by cursor.ts); a parked
  // conduction under a pause or a terminal ticket, and a ticket moving to Parked, are edges.
  const open = openItemOf(cur, ctx);
  let parkNow = false;
  if (open?.event === 'park') parkNow = !(sameOpenItem(prev, open) && prev?.last_reported != null);
  else if (cur.conduction?.status === 'parked' && !!prev && prev.conduction_status !== 'parked') parkNow = true;
  else if (cur.workflow_state === 'Parked' && !!prev && prev.state !== 'Parked') parkNow = true;
  if (parkNow) push(baseEvent('park', cur, ctx, prev, { reason: cls, ref: null }));

  // Pause edge: once per identity.
  if (open && open.event !== 'park') {
    const reported = sameOpenItem(prev, open) && prev?.last_reported != null;
    if (!reported) push(baseEvent(open.event, cur, ctx, prev, { reason: open.reason, ref: open.ref }));
  }

  // Idle: once per spell (a spell ends when the ticket changes, i.e. updated_at moves past the report).
  if (isIdle(cur, ctx)) {
    const lr = prev?.last_reported ? Date.parse(prev.last_reported) : NaN;
    const reportedThisSpell = !Number.isNaN(lr) && lr >= Date.parse(cur.updated_at);
    if (!reportedThisSpell) push(baseEvent('idle', cur, ctx, prev, { reason: null, ref: null }));
  }

  return events;
}

/** The `removed` event for a ticket that left the scope (`last` is its last snapshot, if any). */
export function classifyRemoved(taskId: string, prev: CursorTicket, ctx: ClassifyCtx, last?: TicketSnapshot): WatchEvent {
  return {
    ts: new Date(ctx.now).toISOString(),
    event: 'removed',
    owner: ownerFor('removed', null, ctx.profile),
    key: prev.key,
    title: last?.title ?? null,
    state: last?.workflow_state ?? prev.state,
    reason: null,
    ref: null,
    conduction: last?.conduction?.id ?? null,
    leg: null,
    waiting_on: last ? (last.waiting_on ?? null) : prev.waiting_on,
    first_seen: prev.first_seen,
    reminder: 0,
    cursor: 0,
    task_id: taskId,
  };
}

/** A health event (no ticket). */
export function healthEvent(
  now: number,
  status: NonNullable<WatchEvent['status']>,
  profile: SeatProfile | null,
  extra: { since?: string; detail?: string } = {},
): WatchEvent {
  return {
    ts: new Date(now).toISOString(),
    event: 'health',
    owner: ownerFor('health', null, profile),
    key: null,
    title: null,
    state: null,
    reason: null,
    ref: null,
    conduction: null,
    leg: null,
    waiting_on: null,
    first_seen: null,
    reminder: 0,
    cursor: 0,
    status,
    ...(extra.since ? { since: extra.since } : {}),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

/**
 * The `start` event (always `info`, never a wake): what this run watches. `detail` is the
 * readable line, for example
 * `watching milestone v1.14 (c5a35a47…) in project Backlogs (B) on prod — 7 tickets`.
 */
export function startEvent(
  now: number,
  project: { name: string; key: string },
  target: 'prod' | 'staging' | 'custom',
  scope: NonNullable<WatchEvent['scope']>,
  tickets: number,
  cursorSeq = 0,
): WatchEvent {
  let what: string;
  if (scope.kind === 'milestone') {
    what = scope.name && scope.name !== scope.id ? `milestone ${scope.name} (${scope.id.slice(0, 8)}…)` : `milestone ${scope.id}`;
  } else if (scope.kind === 'keys') {
    what = `tickets ${scope.keys.join(', ')}`;
  } else {
    what = 'live conductions';
  }
  return {
    ts: new Date(now).toISOString(),
    event: 'start',
    owner: 'info',
    key: null,
    title: null,
    state: null,
    reason: null,
    ref: null,
    conduction: null,
    leg: null,
    waiting_on: null,
    first_seen: null,
    reminder: 0,
    cursor: cursorSeq,
    detail: `watching ${what} in project ${project.name} (${project.key}) on ${target} — ${tickets} ticket${tickets === 1 ? '' : 's'}`,
    project,
    target,
    scope,
    tickets,
  };
}
