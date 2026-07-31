import { describe, it, expect } from 'vitest';
import { captureBaseline, detectWake, type WatchBaseline } from './watch.js';
import type { Taskish } from '../conductor/poll-loop.js';

describe('captureBaseline', () => {
  it('captures the awaiting flag and the active exchange from the row', () => {
    const row: Taskish = {
      workflow_state: 'Built',
      awaiting_human_input: true,
      active_exchange: { exchange_id: 'ex-1', status: 'active' },
    };
    expect(captureBaseline(row)).toEqual({
      awaitingHumanInput: true,
      activeExchange: { exchange_id: 'ex-1', status: 'active' },
    });
  });

  it('normalizes absent fields to null', () => {
    expect(captureBaseline({})).toEqual({ awaitingHumanInput: null, activeExchange: null });
  });
});

describe('detectWake', () => {
  it("wakes 'agent-ball' on the canonical flag flip true→false", () => {
    const baseline = captureBaseline({ awaiting_human_input: true });
    expect(detectWake(baseline, { awaiting_human_input: false })).toBe('agent-ball');
  });

  it("wakes 'agent-ball' immediately when the flag is already false at baseline with no active brief/exchange (first pickup — the ball starts with the agent)", () => {
    const row: Taskish = {
      workflow_state: 'Proposed',
      awaiting_human_input: false,
      pending_resolution: null,
      active_exchange: null,
    };
    expect(detectWake(captureBaseline(row), row)).toBe('agent-ball');
  });

  it("B-611 edge: wakes 'discussion-cancelled' when the baseline's ACTIVE exchange goes inactive with NO flag transition (row gone)", () => {
    // The mechanical cancel restores awaiting_human_input = true DIRECTLY, so the canonical
    // true→false transition never happens — the flag stays true in BOTH reads. This test must
    // pass independently of the flag-flip case.
    const baseline = captureBaseline({
      awaiting_human_input: true,
      active_exchange: { exchange_id: 'ex-1', status: 'active' },
    });
    expect(
      detectWake(baseline, { awaiting_human_input: true, active_exchange: null }),
    ).toBe('discussion-cancelled');
  });

  it("B-611 edge: wakes 'discussion-cancelled' when the baseline's ACTIVE exchange status changed (still no flag transition)", () => {
    const baseline = captureBaseline({
      awaiting_human_input: true,
      active_exchange: { exchange_id: 'ex-1', status: 'active' },
    });
    expect(
      detectWake(baseline, {
        awaiting_human_input: true,
        active_exchange: { exchange_id: 'ex-1', status: 'abandoned' },
      }),
    ).toBe('discussion-cancelled');
  });

  it('stays asleep (null) while the flag is true and the exchange is still active', () => {
    const baseline = captureBaseline({
      awaiting_human_input: true,
      active_exchange: { exchange_id: 'ex-1', status: 'active' },
    });
    expect(
      detectWake(baseline, {
        awaiting_human_input: true,
        active_exchange: { exchange_id: 'ex-1', status: 'active' },
      }),
    ).toBeNull();
  });

  it('stays asleep (null) while the flag is true with no exchange anywhere', () => {
    const baseline = captureBaseline({ awaiting_human_input: true, active_exchange: null });
    expect(detectWake(baseline, { awaiting_human_input: true, active_exchange: null })).toBeNull();
  });

  it('does NOT treat an INDETERMINATE current read (same exchange, status absent) as a cancel', () => {
    const baseline: WatchBaseline = {
      awaitingHumanInput: true,
      activeExchange: { exchange_id: 'ex-1', status: 'active' },
    };
    expect(
      detectWake(baseline, {
        awaiting_human_input: true,
        active_exchange: { exchange_id: 'ex-1' },
      }),
    ).toBeNull();
  });

  // ── B-691: the first-sight variant ──────────────────────────────────────────────────────────────
  // First pickup used to require the absence of an active exchange AND of a pending_resolution. Those
  // are AGENT-side markers, so requiring their absence made a flag-down row carrying one unwakeable:
  // a conduction first seen with an already-answered exchange sat forever. Whose turn it is is
  // decided by the flag alone; the fired worker consumes whatever is waiting at its own step 1.

  it('B-691: wakes on a first sight with the ball at rest and an ALREADY-ANSWERED exchange', () => {
    const answered = {
      exchange_id: 'ex-1',
      status: 'active',
      round: 1,
      answers_submitted_at: '2026-07-31T09:50:18.398Z',
    };
    const baseline = captureBaseline({ awaiting_human_input: false, active_exchange: answered });
    expect(detectWake(baseline, { awaiting_human_input: false, active_exchange: answered })).toBe(
      'agent-ball',
    );
  });

  it('B-691: wakes on a first sight with the ball at rest and an unconsumed browser reshape', () => {
    const baseline = captureBaseline({ awaiting_human_input: false });
    expect(
      detectWake(baseline, {
        awaiting_human_input: false,
        pending_resolution: { command: 'iterate', detail: 'tighten it' },
      }),
    ).toBe('agent-ball');
  });

  it('B-691: a pause that appears AFTER the baseline still wakes once the human resolves it', () => {
    // The daemon rolls its baseline every no-wake pass, so by the time the human resolves, the
    // previous read is the paused one — the transition is visible. This mirrors the poll's fix.
    const atRest = captureBaseline({ awaiting_human_input: false, active_exchange: null });
    // Pass 1: a pause has appeared; the human holds the ball, so no wake.
    const paused = { awaiting_human_input: true, active_exchange: { exchange_id: 'ex-1', status: 'active' } };
    expect(detectWake(atRest, paused)).toBeNull();
    // Pass 2: baseline rolled to the paused read; the human resolves.
    expect(detectWake(captureBaseline(paused), { awaiting_human_input: false })).toBe('agent-ball');
  });
});
