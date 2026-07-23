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
});
