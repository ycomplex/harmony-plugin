import { describe, expect, it } from 'vitest';
import {
  classify,
  GATE_ALIASES,
  isDirtyExitClass,
  legEnded,
  legRunning,
  ownerFor,
  type ClassifyCtx,
} from './classify.js';
import type { CursorTicket, SeatProfile } from './seat-files.js';
import { conduction, paused, T0, ticket } from './test-fakes.js';

const profile = (over: Partial<SeatProfile> = {}): SeatProfile => ({
  session_id: 's1',
  project: 'B',
  milestone: 'v1.13',
  anchor: 'B-1422',
  owns: [],
  held_for_founder: [],
  remind: null,
  ...over,
});

const ctx = (over: Partial<ClassifyCtx> = {}): ClassifyCtx => ({ now: T0, profile: null, legEndKnown: true, remindMs: 20 * 60_000, ...over });

function prevOf(over: Partial<CursorTicket> = {}): CursorTicket {
  return {
    key: 'B-1',
    state: 'In Progress',
    awaiting: false,
    reason: null,
    ref_id: null,
    iteration: null,
    conduction_status: 'active',
    leg_ended_at: null,
    waiting_on: null,
    first_seen: new Date(T0 - 3_600_000).toISOString(),
    last_reported: null,
    reminders: 0,
    ...over,
  };
}

const names = (evs: { event: string }[]) => evs.map((e) => e.event);

describe('AC6 profile routing (ownerFor)', () => {
  it('owns / held_for_founder by exact reason', () => {
    const p = profile({ owns: ['plan-draft'], held_for_founder: ['design-decision-draft'] });
    expect(ownerFor('ready', 'plan-draft', p)).toBe('seat');
    expect(ownerFor('ready', 'design-decision-draft', p)).toBe('founder');
  });

  it('owns / held_for_founder by gate alias', () => {
    const p = profile({ owns: ['plan', 'release'], held_for_founder: ['verify', 'clarify'] });
    expect(ownerFor('ready', 'plan-draft', p)).toBe('seat');
    expect(ownerFor('ready', 'release-decision-pending', p)).toBe('seat');
    expect(ownerFor('ready', 'verification-ack-pending', p)).toBe('founder');
    expect(ownerFor('ready', 'clarification-draft', p)).toBe('founder');
  });

  it('the alias table matches docs/harmony-watch-files.md exactly', () => {
    expect(GATE_ALIASES).toEqual({
      clarify: 'clarification-draft',
      decompose: 'decomposition-proposal',
      design: 'design-decision-draft',
      plan: 'plan-draft',
      release: 'release-decision-pending',
      verify: 'verification-ack-pending',
    });
  });

  it('an unlisted reason wakes the seat', () => {
    const p = profile({ owns: ['plan'], held_for_founder: ['verify'] });
    expect(ownerFor('ready', 'release-approval-pending', p)).toBe('seat');
    expect(ownerFor('question', 'elicitation-round', p)).toBe('seat');
  });

  it('no profile: everything that is not info is seat-owned', () => {
    for (const e of ['ready', 'question', 'park', 'dirty-exit', 'added', 'removed', 'idle', 'health'] as const) {
      expect(ownerFor(e, 'verification-ack-pending', null)).toBe('seat');
    }
  });

  it('waiting / acted / state are always info; others can be held by event name', () => {
    const p = profile({ held_for_founder: ['park', 'state', 'ready'] });
    expect(ownerFor('waiting', null, p)).toBe('info');
    expect(ownerFor('acted', null, p)).toBe('info');
    expect(ownerFor('state', null, p)).toBe('info');
    expect(ownerFor('start', null, p)).toBe('info');
    expect(ownerFor('start', null, null)).toBe('info');
    expect(ownerFor('park', null, p)).toBe('founder');
    expect(ownerFor('dirty-exit', null, p)).toBe('seat');
    // the reason decides first, then the event name
    expect(ownerFor('ready', 'plan-draft', p)).toBe('founder');
    expect(ownerFor('ready', 'plan-draft', profile({ owns: ['plan'], held_for_founder: ['ready'] }))).toBe('seat');
  });
});

describe('leg running (live fact)', () => {
  it('running iff leg_started_at set and (no end, or start after end)', () => {
    const iso = (d: number) => new Date(T0 + d).toISOString();
    expect(legRunning(ticket(1, { conduction: conduction({ leg_started_at: iso(0), last_leg_ended_at: null }) }))).toBe(true);
    expect(legRunning(ticket(1, { conduction: conduction({ leg_started_at: iso(10), last_leg_ended_at: iso(0) }) }))).toBe(true);
    expect(legRunning(ticket(1, { conduction: conduction({ leg_started_at: iso(0), last_leg_ended_at: iso(10) }) }))).toBe(false);
    expect(legRunning(ticket(1, { conduction: conduction({ leg_started_at: null }) }))).toBe(false);
    expect(legRunning(ticket(1))).toBe(false);
  });

  it('without the column, a pause counts as ended once it has held unchanged for 90 s', () => {
    const t = paused(1, 'plan-draft', { updated_at: new Date(T0 - 60_000).toISOString() });
    delete t.conduction!.last_leg_ended_at;
    t.conduction!.leg_started_at = new Date(T0 - 1_000_000).toISOString();
    expect(legEnded(t, { now: T0, legEndKnown: false })).toBe(false);
    expect(legEnded(t, { now: T0 + 30_000, legEndKnown: false })).toBe(true);
  });
});

describe('classify', () => {
  it('ready only once the leg has ended', () => {
    const running = paused(1, 'plan-draft');
    running.conduction!.last_leg_ended_at = null;
    expect(names(classify(undefined, running, ctx({ initial: true })))).toEqual([]);
    expect(names(classify(undefined, paused(1), ctx({ initial: true })))).toEqual(['ready']);
  });

  it('question replaces ready for an elicitation round', () => {
    const t = paused(1, 'elicitation-round', { awaiting_human_ref: { kind: 'elicitation', exchange_id: 'ex1', round: 2 } });
    const evs = classify(undefined, t, ctx({ initial: true }));
    expect(names(evs)).toEqual(['question']);
    expect(evs[0].ref).toEqual({ type: 'elicitation', id: 'ex1', iteration: 2 });
  });

  it('reports a pause once per (ref id, iteration)', () => {
    const prev = prevOf({ awaiting: true, reason: 'plan-draft', ref_id: 'br-1', iteration: 1, last_reported: new Date(T0 - 1000).toISOString() });
    expect(names(classify(prev, paused(1), ctx()))).toEqual([]);
    const next = paused(1, 'plan-draft', { meta: { active_brief_iteration: 2, active_exchange: null } });
    expect(names(classify(prev, next, ctx()))).toEqual(['ready']);
  });

  it('a pause seen while the leg was running is reported when the leg ends', () => {
    const prev = prevOf({ awaiting: true, reason: 'plan-draft', ref_id: 'br-1', iteration: 1, last_reported: null });
    expect(names(classify(prev, paused(1), ctx()))).toEqual(['ready']);
  });

  it('acted: awaiting true → false (info)', () => {
    const prev = prevOf({ awaiting: true, reason: 'plan-draft', ref_id: 'br-1', iteration: 1, last_reported: new Date(T0).toISOString() });
    const evs = classify(prev, ticket(1, { conduction: conduction() }), ctx());
    expect(names(evs)).toEqual(['acted']);
    expect(evs[0].owner).toBe('info');
    expect(evs[0].reason).toBe('plan-draft');
  });

  it('state and waiting are info edges, never replayed on a first run', () => {
    const t = ticket(1, { workflow_state: 'Built', waiting_on: { kind: 'ci', ref: 'pr#9' } });
    expect(names(classify(prevOf(), t, ctx()))).toEqual(['state', 'waiting']);
    expect(names(classify(undefined, t, ctx({ initial: true })))).toEqual([]);
    expect(names(classify(prevOf({ waiting_on: { kind: 'ci', ref: 'pr#9' } }), ticket(1), ctx()))).toEqual(['waiting']); // cleared
  });

  it('park: conduction became parked; reported once', () => {
    const t = ticket(1, { conduction: conduction({ status: 'parked', last_worker_exit_class: 'no-progress' }) });
    const evs = classify(prevOf(), t, ctx());
    expect(names(evs)).toEqual(['park']);
    expect(evs[0].reason).toBe('no-progress');
    const prev = prevOf({ conduction_status: 'parked', last_reported: new Date(T0).toISOString() });
    expect(names(classify(prev, t, ctx()))).toEqual([]);
  });

  it('park: ticket became Parked', () => {
    const t = ticket(1, { workflow_state: 'Parked', conduction: conduction({ status: 'completed' }) });
    expect(names(classify(prevOf(), t, ctx()))).toEqual(['state', 'park']);
  });

  it('dirty-exit when a leg ends with a dirty class', () => {
    const ended = new Date(T0 - 1000).toISOString();
    const t = ticket(1, { conduction: conduction({ leg_started_at: new Date(T0 - 9000).toISOString(), last_leg_ended_at: ended, last_worker_exit_class: 'dirty-exit' }) });
    expect(names(classify(prevOf(), t, ctx()))).toEqual(['dirty-exit']);
    expect(names(classify(prevOf({ leg_ended_at: ended }), t, ctx()))).toEqual([]);
  });

  it('dirty exit classes', () => {
    expect(isDirtyExitClass('dirty-exit')).toBe(true);
    expect(isDirtyExitClass('dirty-something')).toBe(true);
    expect(isDirtyExitClass('brand-new-failure')).toBe(true);
    for (const c of ['clean-pause', 'terminal', 'complete', 'split-umbrella', null, 'waiting-on', 'no-progress']) expect(isDirtyExitClass(c)).toBe(false);
  });

  it('added on a new ticket mid-run, not on a first run', () => {
    expect(names(classify(undefined, ticket(1), ctx()))).toEqual(['added']);
    expect(names(classify(undefined, ticket(1), ctx({ initial: true })))).toEqual([]);
  });

  it('idle once per spell: live conduction, no leg, no human, no wait, quiet ≥ 30 min', () => {
    const t = ticket(1, { updated_at: new Date(T0 - 31 * 60_000).toISOString(), conduction: conduction() });
    expect(names(classify(prevOf(), t, ctx()))).toEqual(['idle']);
    expect(names(classify(prevOf({ last_reported: new Date(T0 - 1000).toISOString() }), t, ctx()))).toEqual([]);
    // not idle: a leg running, a human holding the ball, a waiting_on, or no conduction
    const running = ticket(1, { updated_at: t.updated_at, conduction: conduction({ leg_started_at: new Date(T0 - 40 * 60_000).toISOString() }) });
    expect(names(classify(prevOf(), running, ctx()))).toEqual([]);
    const waiting = ticket(1, { updated_at: t.updated_at, conduction: conduction(), waiting_on: { kind: 'ci' } });
    expect(names(classify(prevOf({ waiting_on: { kind: 'ci' } }), waiting, ctx()))).toEqual([]);
    expect(names(classify(prevOf(), ticket(1, { updated_at: t.updated_at }), ctx()))).toEqual([]);
  });

  it('every event carries the full field set', () => {
    const [e] = classify(undefined, paused(7), ctx({ initial: true, profile: profile({ owns: ['plan'] }) }));
    expect(Object.keys(e)).toEqual(
      expect.arrayContaining(['ts', 'event', 'owner', 'key', 'title', 'state', 'reason', 'ref', 'conduction', 'leg', 'waiting_on', 'first_seen', 'reminder', 'cursor']),
    );
    expect(e).toMatchObject({ event: 'ready', owner: 'seat', key: 'B-7', reason: 'plan-draft', ref: { type: 'brief', id: 'br-7', iteration: 1 }, conduction: 'cond-7', leg: { ended: true, exit: 'clean-pause' }, reminder: 0 });
  });
});
