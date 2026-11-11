// B-1452: the watch reports an incident round as an `incident` event, first.
import { describe, expect, it } from 'vitest';
import { classify, isIncidentPause, openItemOf, ownerFor, WATCH_EVENT_NAMES, type WatchEvent } from './classify.js';
import { catchUp, currentRows } from './cursor.js';
import { isWake, runWatch } from './loop.js';
import { formatCurrentRow, formatEvent } from '../cli/commands/watch.js';
import type { BoardSnapshot, TicketSnapshot } from './board-read.js';
import type { SeatProfile } from './seat-files.js';
import { FakeBoard, FakeClock, paused, T0 } from './test-fakes.js';

const MIN = 60_000;
const snap = (...tickets: TicketSnapshot[]): BoardSnapshot => ({ tickets, legEndKnown: true });
const profile = (over: Partial<SeatProfile> = {}): SeatProfile => ({
  session_id: 's1', project: 'B', milestone: 'm1', anchor: null, owns: [], held_for_founder: [], remind: null, ...over,
});

/** An incident round filed by an ended leg on ticket n. */
function incident(n: number, round = 1): TicketSnapshot {
  return paused(n, 'elicitation-round', {
    awaiting_human_ref: { kind: 'elicitation', exchange_id: `ex-${n}`, round, gate: 'building', incident: 'credential-exposure' },
    meta: { active_brief_iteration: null, active_exchange: { round } as never },
  });
}

describe('incident event', () => {
  it('is a known event name', () => {
    expect(WATCH_EVENT_NAMES).toContain('incident');
  });

  it('replaces question for an elicitation round whose ref carries incident', () => {
    const t = incident(5);
    expect(isIncidentPause(t)).toBe(true);
    expect(openItemOf(t, { now: T0, legEndKnown: true })?.event).toBe('incident');
    const q = paused(6, 'elicitation-round', { awaiting_human_ref: { kind: 'elicitation', exchange_id: 'ex-6', round: 1 } });
    expect(openItemOf(q, { now: T0, legEndKnown: true })?.event).toBe('question');
  });

  it('is always seat-owned (wakes --until-event), even when the profile holds questions for the founder', () => {
    const p = profile({ held_for_founder: ['incident', 'question', 'elicitation-round'] });
    expect(ownerFor('incident', 'elicitation-round', p)).toBe('seat');
    const [e] = classify(undefined, incident(5), { now: T0, profile: p, legEndKnown: true, remindMs: 20 * MIN, initial: true });
    expect(e.event).toBe('incident');
    expect(e.owner).toBe('seat');
    expect(isWake(e)).toBe(true);
    expect(formatEvent(e)).toMatch(/ incident \[seat\] B-5 /);
  });

  it('(3) catch-up prints every incident before a ready event in the same batch, before seq numbers', () => {
    // The ready ticket sorts first by key and is first in the snapshot.
    const r = catchUp(null, snap(paused(1), incident(9)), { now: T0, profile: null, projectKey: 'B', seat: 'orch' });
    expect(r.events.map((e) => [e.event, e.key, e.cursor])).toEqual([
      ['incident', 'B-9', 1],
      ['ready', 'B-1', 2],
    ]);
  });

  it('is reported once per round and reminded like a question', () => {
    const ctx = (now: number) => ({ now, profile: profile({ held_for_founder: ['elicitation-round'] }), projectKey: 'B', seat: 'orch', remindMs: 20 * MIN });
    const a = catchUp(null, snap(incident(9)), ctx(T0));
    expect(a.events.map((e) => e.event)).toEqual(['incident']);
    const b = catchUp(a.next, snap(incident(9)), ctx(T0 + 5 * MIN));
    expect(b.events).toEqual([]);
    const c = catchUp(b.next, snap(incident(9)), ctx(T0 + 20 * MIN));
    expect(c.events.map((e) => [e.event, e.reminder])).toEqual([['incident', 1]]);
    const d = catchUp(c.next, snap(incident(9, 2)), ctx(T0 + 21 * MIN));
    expect(d.events.map((e) => [e.event, e.reminder])).toEqual([['incident', 0]]);
  });

  it('--once rows list incidents first', () => {
    const rows = currentRows(snap(paused(1), paused(2), incident(9)), { now: T0, profile: null });
    expect(rows.map((r) => [r.key, r.waiting])).toEqual([
      ['B-9', 'incident'],
      ['B-1', 'ready'],
      ['B-2', 'ready'],
    ]);
    expect(formatCurrentRow(rows[0])).toMatch(/^B-9 In Progress: incident \(elicitation-round\) on seat/);
  });

  it('(3) --once (the seat session-start check) prints the incident event and row first', async () => {
    const clock = new FakeClock();
    const board = new FakeBoard(clock);
    board.put(paused(1));
    board.put(incident(9));
    const events: WatchEvent[] = [];
    const rows: string[] = [];
    const res = await runWatch({
      now: clock.now,
      sleep: clock.sleep,
      reader: board,
      scope: { kind: 'milestone', id: 'm1' },
      hint: null,
      emit: (e) => events.push(e),
      cursor: null,
      printCurrent: (r) => rows.push(...r.map(formatCurrentRow)),
      mode: 'once',
      options: { seat: 'orch', projectKey: 'B', scopeSlug: 'milestone-m1', profile: null, pid: 1 },
    });
    expect(res.exitCode).toBe(0);
    expect(events.map((e) => e.event)).toEqual(['incident', 'ready']);
    expect(rows[0]).toMatch(/^B-9 .*incident/);
  });

  it('--until-event wakes on an incident even when every other reason is held for the founder', async () => {
    const clock = new FakeClock();
    const board = new FakeBoard(clock);
    board.put(incident(9));
    const events: WatchEvent[] = [];
    const res = await runWatch({
      now: clock.now,
      sleep: clock.sleep,
      reader: board,
      scope: { kind: 'milestone', id: 'm1' },
      hint: null,
      emit: (e) => events.push(e),
      cursor: null,
      mode: 'until-event',
      options: {
        seat: 'orch', projectKey: 'B', scopeSlug: 'milestone-m1', pid: 1, maxWaitMs: 10 * MIN, settleMs: 0,
        profile: profile({ held_for_founder: ['elicitation-round', 'question', 'ready'] }),
      },
    });
    expect(res).toMatchObject({ exitCode: 0, reason: 'event' });
    expect(events[0]).toMatchObject({ event: 'incident', owner: 'seat', key: 'B-9' });
  });
});
