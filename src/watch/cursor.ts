/**
 * `harmony watch` cursor logic (B-1422). Pure functions over `WatchCursor` (seat-files.ts).
 *
 * `catchUp(cursor, snapshot, ctx)` diffs the board against what the watch last saw and reported:
 *   - No cursor (first run): every currently open seat-owned item is reported (no silent seeding);
 *     info lines (`state`, `acted`, `waiting`) and `added` are NOT replayed.
 *   - With a cursor: everything that changed while the watch was down is reported (AC4).
 *   - Level-triggered reminders: a seat-owned open item whose `last_reported` is older than
 *     `remindMs` is re-emitted with `reminder + 1`. Founder-held items are reported once, never
 *     reminded, and are listed by `--once` with their age.
 *   - `seq` is bumped once per emitted event (and at least once per changed write).
 */
import type { BoardSnapshot, TicketSnapshot } from './board-read.js';
import {
  baseEvent,
  classify,
  classifyRemoved,
  idleNow,
  openItemOf,
  ownerFor,
  refOf,
  sameOpenItem,
  type ClassifyCtx,
  type Owner,
  type WatchEvent,
} from './classify.js';
import type { CursorTicket, SeatProfile, WatchCursor } from './seat-files.js';

export const DEFAULT_REMIND_MS = 20 * 60_000;

export interface CatchUpCtx {
  now: number;
  profile: SeatProfile | null;
  projectKey: string;
  seat: string;
  remindMs?: number;
  quietMs?: number;
  idleMs?: number;
  /** Task uuids currently in scope. Snapshot tickets outside it are classified one last time, then removed. */
  inScope?: Set<string>;
  /** Fallback exit-class memory for boards without `last_leg_ended_at` (mutated). */
  exitSeen?: Map<string, string | null>;
}

export interface CatchUpResult {
  events: WatchEvent[];
  next: WatchCursor;
  /** False when nothing in the cursor changed and nothing was emitted (no write needed). */
  changed: boolean;
}

function ctxFor(ctx: CatchUpCtx, snapshot: BoardSnapshot, initial: boolean): ClassifyCtx {
  return {
    now: ctx.now,
    profile: ctx.profile,
    legEndKnown: snapshot.legEndKnown,
    remindMs: ctx.remindMs ?? DEFAULT_REMIND_MS,
    quietMs: ctx.quietMs,
    idleMs: ctx.idleMs,
    initial,
    exitSeen: ctx.exitSeen,
  };
}

/** The cursor entry after this read (and the reminder, if one is due). */
function nextEntry(
  prev: CursorTicket | undefined,
  cur: TicketSnapshot,
  cctx: ClassifyCtx,
  emitted: WatchEvent[],
): { entry: CursorTicket; reminder: WatchEvent | null } {
  const nowIso = new Date(cctx.now).toISOString();
  const open = openItemOf(cur, cctx);
  const ref = refOf(cur);
  let lastReported: string | null = null;
  let reminders = 0;
  let reminder: WatchEvent | null = null;

  if (open) {
    if (emitted.some((e) => e.event === open.event)) {
      lastReported = nowIso;
    } else if (sameOpenItem(prev, open) && prev?.last_reported) {
      lastReported = prev.last_reported;
      reminders = prev.reminders;
      const owner = ownerFor(open.event, open.reason, cctx.profile);
      const age = cctx.now - Date.parse(prev.last_reported);
      if (owner === 'seat' && age >= cctx.remindMs) {
        reminders += 1;
        reminder = baseEvent(open.event, cur, cctx, prev, { reason: open.reason, ref: open.ref, reminder: reminders });
        lastReported = nowIso;
      }
    }
  } else if (idleNow(cur, cctx)) {
    lastReported = emitted.some((e) => e.event === 'idle') ? nowIso : (prev?.last_reported ?? null);
  }

  const entry: CursorTicket = {
    key: cur.key,
    state: cur.workflow_state,
    awaiting: cur.awaiting_human_input,
    reason: cur.awaiting_human_reason,
    ref_id: ref?.id ?? null,
    // Keep a known iteration when this read's meta is missing, so a failed meta read never makes
    // the same pause look new.
    iteration: ref?.iteration ?? (prev && prev.awaiting && prev.reason === cur.awaiting_human_reason ? prev.iteration : null),
    conduction_status: cur.conduction?.status ?? null,
    leg_ended_at: cur.conduction?.last_leg_ended_at ?? null,
    waiting_on: cur.waiting_on ?? null,
    first_seen: prev?.first_seen ?? nowIso,
    last_reported: lastReported,
    reminders,
  };
  return { entry, reminder };
}

export function catchUp(cursor: WatchCursor | null, snapshot: BoardSnapshot, ctx: CatchUpCtx): CatchUpResult {
  const initial = cursor === null;
  const cctx = ctxFor(ctx, snapshot, initial);
  const prevTickets = cursor?.tickets ?? {};
  const tickets: Record<string, CursorTicket> = {};
  const events: WatchEvent[] = [];
  const seenIds = new Set<string>();

  for (const cur of snapshot.tickets) {
    seenIds.add(cur.id);
    const prev = prevTickets[cur.id];
    const inScope = ctx.inScope ? ctx.inScope.has(cur.id) : true;
    if (!inScope && !prev) continue; // never watched: nothing to say
    const emitted = classify(prev, cur, cctx);
    const { entry, reminder } = nextEntry(prev, cur, cctx, emitted);
    events.push(...emitted);
    if (reminder) events.push(reminder);
    ctx.exitSeen?.set(cur.id, cur.conduction?.last_worker_exit_class ?? null);
    if (inScope) tickets[cur.id] = entry;
    else if (prev) events.push(classifyRemoved(cur.id, prev, cctx, cur));
  }
  for (const [id, prev] of Object.entries(prevTickets)) {
    if (seenIds.has(id)) continue;
    events.push(classifyRemoved(id, prev, cctx));
  }

  const before = cursor ? JSON.stringify(cursor.tickets) : null;
  const changed = events.length > 0 || before !== JSON.stringify(tickets);
  let seq = cursor?.seq ?? 0;
  for (const e of events) {
    seq += 1;
    e.cursor = seq;
  }
  if (changed && events.length === 0) seq += 1;

  const next: WatchCursor = changed
    ? {
        schema: 1,
        project: ctx.projectKey,
        seat: ctx.seat,
        seq,
        updated_at: new Date(ctx.now).toISOString(),
        tickets,
      }
    : (cursor as WatchCursor);
  return { events, next, changed };
}

/** One row of `--once` / status output: the current state of a watched ticket. */
export interface CurrentRow {
  key: string;
  title: string;
  state: string | null;
  /** What is waiting: `ready` / `question` / `park`, or null when nothing is. */
  waiting: 'ready' | 'question' | 'park' | null;
  reason: string | null;
  /** Who the waiting item is on. Null when nothing is waiting. */
  on: Owner | null;
  /** When the item started waiting (task `updated_at`, the best board-side proxy). */
  since: string | null;
  age_s: number | null;
  waiting_on: unknown;
  conduction: string | null;
  conduction_status: string | null;
}

export function currentRows(snapshot: BoardSnapshot, ctx: Pick<CatchUpCtx, 'now' | 'profile' | 'quietMs'>): CurrentRow[] {
  const cctx = { now: ctx.now, legEndKnown: snapshot.legEndKnown, quietMs: ctx.quietMs };
  return snapshot.tickets
    .map((t): CurrentRow => {
      const open = openItemOf(t, cctx);
      const since = open ? t.updated_at : null;
      const age = since ? Math.max(0, Math.round((ctx.now - Date.parse(since)) / 1000)) : null;
      return {
        key: t.key,
        title: t.title,
        state: t.workflow_state,
        waiting: open?.event ?? null,
        reason: open?.reason ?? null,
        on: open ? ownerFor(open.event, open.reason, ctx.profile) : null,
        since,
        age_s: age,
        waiting_on: t.waiting_on ?? null,
        conduction: t.conduction?.id ?? null,
        conduction_status: t.conduction?.status ?? null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}
