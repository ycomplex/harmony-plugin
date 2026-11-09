import { describe, expect, it } from 'vitest';
import { catchUp, currentRows, type CatchUpCtx } from './cursor.js';
import type { BoardSnapshot, TicketSnapshot } from './board-read.js';
import type { SeatProfile, WatchCursor } from './seat-files.js';
import { WatchCursorSchema } from './seat-files.js';
import { conduction, paused, T0, ticket } from './test-fakes.js';

const MIN = 60_000;
const snap = (...tickets: TicketSnapshot[]): BoardSnapshot => ({ tickets, legEndKnown: true });
const ctx = (now: number, over: Partial<CatchUpCtx> = {}): CatchUpCtx => ({ now, profile: null, projectKey: 'B', seat: 'orch', remindMs: 20 * MIN, ...over });
const names = (evs: { event: string }[]) => evs.map((e) => e.event);
const profile = (over: Partial<SeatProfile>): SeatProfile => ({
  session_id: 's1',
  project: 'B',
  milestone: null,
  anchor: null,
  owns: [],
  held_for_founder: [],
  remind: null,
  ...over,
});

describe('catchUp', () => {
  it('first run (no cursor) reports existing seat-owned pauses and replays no info lines', () => {
    const r = catchUp(null, snap(paused(1), ticket(2, { workflow_state: 'Built', waiting_on: { kind: 'ci' } })), ctx(T0));
    expect(names(r.events)).toEqual(['ready']);
    expect(r.events[0].key).toBe('B-1');
    expect(r.changed).toBe(true);
    expect(WatchCursorSchema.parse(r.next)).toBeTruthy();
    expect(r.next.tickets['task-1']).toMatchObject({ awaiting: true, reason: 'plan-draft', ref_id: 'br-1', iteration: 1, last_reported: new Date(T0).toISOString(), reminders: 0 });
  });

  it('with a cursor, reports what changed while the watch was down (AC4 core)', () => {
    const first = catchUp(null, snap(ticket(1, { conduction: conduction() })), ctx(T0));
    expect(first.events).toEqual([]);
    const later = catchUp(first.next, snap(paused(1)), ctx(T0 + 5 * MIN));
    expect(names(later.events)).toEqual(['ready']);
  });

  it('does not re-report a reported pause; nothing changed → no write', () => {
    const a = catchUp(null, snap(paused(1)), ctx(T0));
    const b = catchUp(a.next, snap(paused(1)), ctx(T0 + MIN));
    expect(b.events).toEqual([]);
    expect(b.changed).toBe(false);
    expect(b.next).toBe(a.next);
  });

  it('AC5: an owned item still open after --remind re-emits with reminder 1, then 2', () => {
    const a = catchUp(null, snap(paused(1)), ctx(T0));
    const b = catchUp(a.next, snap(paused(1)), ctx(T0 + 19 * MIN));
    expect(b.events).toEqual([]);
    const c = catchUp(b.next, snap(paused(1)), ctx(T0 + 20 * MIN));
    expect(c.events.map((e) => [e.event, e.reminder])).toEqual([['ready', 1]]);
    const d = catchUp(c.next, snap(paused(1)), ctx(T0 + 30 * MIN));
    expect(d.events).toEqual([]);
    const e = catchUp(d.next, snap(paused(1)), ctx(T0 + 40 * MIN));
    expect(e.events.map((x) => [x.event, x.reminder])).toEqual([['ready', 2]]);
    expect(e.next.tickets['task-1'].reminders).toBe(2);
  });

  it('AC5: a founder-held item is reported once (owner founder) and never reminded', () => {
    const p = profile({ held_for_founder: ['verify'] });
    const t = paused(1, 'verification-ack-pending');
    const a = catchUp(null, snap(t), ctx(T0, { profile: p }));
    expect(a.events.map((e) => [e.event, e.owner])).toEqual([['ready', 'founder']]);
    const b = catchUp(a.next, snap(t), ctx(T0 + 5 * 60 * MIN, { profile: p }));
    expect(b.events).toEqual([]);
  });

  it('a cleared pause resets the reminder count', () => {
    const a = catchUp(null, snap(paused(1)), ctx(T0));
    const b = catchUp(a.next, snap(paused(1)), ctx(T0 + 20 * MIN));
    expect(b.next.tickets['task-1'].reminders).toBe(1);
    const c = catchUp(b.next, snap(ticket(1, { conduction: conduction() })), ctx(T0 + 21 * MIN));
    expect(names(c.events)).toEqual(['acted']);
    expect(c.next.tickets['task-1']).toMatchObject({ awaiting: false, reminders: 0, last_reported: null });
  });

  it('bumps seq per event', () => {
    const a = catchUp(null, snap(paused(1), paused(2)), ctx(T0));
    expect(a.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(a.next.seq).toBe(2);
    const b = catchUp(a.next, snap(paused(1), paused(2), ticket(3)), ctx(T0 + MIN, { inScope: new Set(['task-1', 'task-2', 'task-3']) }));
    expect(b.events.map((e) => [e.event, e.cursor])).toEqual([['added', 3]]);
  });

  it('removed: a cursor ticket that left the scope (classified one last time first)', () => {
    const a = catchUp(null, snap(ticket(1, { conduction: conduction() }), ticket(2)), ctx(T0));
    const parkedNow = ticket(1, { conduction: conduction({ status: 'parked', last_worker_exit_class: 'stale' }) });
    const b = catchUp(a.next, snap(parkedNow), ctx(T0 + MIN, { inScope: new Set() }));
    expect(names(b.events)).toEqual(['park', 'removed', 'removed']);
    expect(b.next.tickets).toEqual({});
  });

  it('keeps first_seen across reads', () => {
    const a = catchUp(null, snap(ticket(1)), ctx(T0));
    const b = catchUp(a.next, snap(ticket(1, { workflow_state: 'Built' })), ctx(T0 + MIN));
    expect(b.next.tickets['task-1'].first_seen).toBe(new Date(T0).toISOString());
  });

  it('a parked conduction is an open item: reported on a first run and reminded', () => {
    const t = ticket(1, { conduction: conduction({ status: 'parked', last_worker_exit_class: 'dirty-exit' }) });
    const a = catchUp(null, { tickets: [t], legEndKnown: false }, ctx(T0));
    expect(names(a.events)).toEqual(['dirty-exit', 'park']);
    const b = catchUp(a.next, snap(t), ctx(T0 + 20 * MIN));
    expect(b.events.map((e) => [e.event, e.reminder])).toEqual([['park', 1]]);
  });
});

describe('currentRows', () => {
  it('lists what is waiting, on whom, and for how long — founder-held items included', () => {
    const p = profile({ held_for_founder: ['verify'] });
    const t = paused(2, 'verification-ack-pending', { updated_at: new Date(T0 - 2 * 3600_000).toISOString() });
    const rows = currentRows(snap(paused(1), t, ticket(3)), { now: T0, profile: p });
    expect(rows.map((r) => [r.key, r.waiting, r.on])).toEqual([
      ['B-1', 'ready', 'seat'],
      ['B-2', 'ready', 'founder'],
      ['B-3', null, null],
    ]);
    expect(rows[1].age_s).toBe(7200);
  });
});

// Type-level check that the cursor shape is the seat-files contract.
const _c: WatchCursor = catchUp(null, snap(), ctx(T0)).next;
void _c;
