import { describe, it, expect } from 'vitest';
import {
  runPollLoop,
  detectChange,
  defaultCadence,
  POLL_CADENCE,
  WATCH_WINDOW_MS,
  type PollBaseline,
  type Taskish,
} from './poll-loop.js';

// A deterministic fake clock: `now()` advances by exactly the slept duration, so the loop's
// elapsed = now() - launchStamp is fully driven by the (fake) sleeps — no real timers, no wall clock.
function makeClock(start = 0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

// Build a readTask that returns `before` until the Nth call, then `after` (1-indexed N).
function readTaskAfter(n: number, before: Taskish, after: Taskish): { read: () => Promise<Taskish>; count: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return calls >= n ? after : before;
    },
    count: () => calls,
  };
}

describe('detectChange', () => {
  const baseline: PollBaseline = { workflowState: 'Built', pendingResolution: null };

  it('returns null when nothing changed', () => {
    expect(detectChange(baseline, { workflow_state: 'Built', pending_resolution: null })).toBeNull();
  });

  it('reports a forward state advance', () => {
    expect(detectChange({ workflowState: 'Clarified' }, { workflow_state: 'Decomposed' })).toEqual({
      trigger: 'state-advanced',
      workflow_state: 'Decomposed',
    });
  });

  it('reports Parked (browser defer/deny) with the parked trigger, not a generic advance', () => {
    expect(detectChange({ workflowState: 'Designed' }, { workflow_state: 'Parked' })).toEqual({
      trigger: 'parked',
      workflow_state: 'Parked',
    });
  });

  it('reports a newly-present pending_resolution (browser reshape) when state is unchanged', () => {
    const change = detectChange(baseline, {
      workflow_state: 'Built',
      pending_resolution: { command: 'iterate', detail: 'tighten the scope' },
    });
    expect(change).toEqual({
      trigger: 'pending_resolution',
      workflow_state: 'Built',
      pending_resolution: { command: 'iterate', detail: 'tighten the scope' },
    });
  });

  it('does NOT re-trigger on a pending_resolution identical to the baseline marker', () => {
    const pr = { command: 'iterate', detail: 'x' };
    expect(detectChange({ workflowState: 'Built', pendingResolution: pr }, { workflow_state: 'Built', pending_resolution: pr })).toBeNull();
  });

  it('triggers when the pending_resolution detail changes from the baseline', () => {
    const change = detectChange(
      { workflowState: 'Built', pendingResolution: { command: 'iterate', detail: 'a' } },
      { workflow_state: 'Built', pending_resolution: { command: 'iterate', detail: 'b' } },
    );
    expect(change?.trigger).toBe('pending_resolution');
  });
});

describe('defaultCadence', () => {
  it('ramps first(~120s) → steady(<300s) → coarse tail(~900s)', () => {
    expect(defaultCadence(0)).toBe(POLL_CADENCE.firstDelayMs);
    expect(defaultCadence(60_000)).toBe(POLL_CADENCE.firstDelayMs);
    expect(defaultCadence(POLL_CADENCE.steadyAfterMs)).toBe(POLL_CADENCE.steadyDelayMs);
    expect(defaultCadence(20 * 60_000)).toBe(POLL_CADENCE.steadyDelayMs);
    expect(defaultCadence(POLL_CADENCE.tailAfterMs)).toBe(POLL_CADENCE.tailDelayMs);
    expect(defaultCadence(80 * 60_000)).toBe(POLL_CADENCE.tailDelayMs);
  });

  it('keeps the steady delay under ~300s and the tail at ~900s+', () => {
    expect(POLL_CADENCE.firstDelayMs).toBe(120_000);
    expect(POLL_CADENCE.steadyDelayMs).toBeLessThan(300_000);
    expect(POLL_CADENCE.tailDelayMs).toBeGreaterThanOrEqual(900_000);
  });
});

describe('runPollLoop', () => {
  const baseline: PollBaseline = { workflowState: 'Clarified', pendingResolution: null };

  it('exits changed when workflow_state advances', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(3, { workflow_state: 'Clarified' }, { workflow_state: 'Decomposed' });
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline,
    });
    expect(res).toEqual({ reason: 'changed', detail: { trigger: 'state-advanced', workflow_state: 'Decomposed' } });
    expect(reader.count()).toBe(3);
  });

  it('exits changed when a browser reshape leaves a pending_resolution', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Clarified', pending_resolution: null },
      { workflow_state: 'Clarified', pending_resolution: { command: 'iterate', detail: 'broaden' } },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline,
    });
    expect(res.reason).toBe('changed');
    if (res.reason === 'changed') {
      expect(res.detail.trigger).toBe('pending_resolution');
      expect(res.detail.pending_resolution).toEqual({ command: 'iterate', detail: 'broaden' });
    }
  });

  it('exits changed when the ticket is Parked (browser defer/deny)', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(2, { workflow_state: 'Designed' }, { workflow_state: 'Parked' });
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Designed' },
    });
    expect(res).toEqual({ reason: 'changed', detail: { trigger: 'parked', workflow_state: 'Parked' } });
  });

  it('catches a change on the FIRST read, before any sleep', async () => {
    const clock = makeClock();
    const res = await runPollLoop({
      readTask: async () => ({ workflow_state: 'Decomposed' }),
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline,
    });
    expect(res.reason).toBe('changed');
    expect(clock.sleeps).toHaveLength(0);
  });

  it('times out at ~90 minutes, anchored to the launch stamp (B-548 regression)', async () => {
    const clock = makeClock();
    let reads = 0;
    const res = await runPollLoop({
      readTask: async () => {
        reads += 1;
        return { workflow_state: 'Built' }; // never changes
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built' },
    });
    expect(res).toEqual({ reason: 'timeout' });
    // The window is elapsed-anchored: the clock advanced to EXACTLY one window, never overshooting.
    expect(clock.now()).toBe(WATCH_WINDOW_MS);
    // Bounded — not an infinite spin, but more than a couple of polls.
    expect(reads).toBeGreaterThan(3);
    expect(reads).toBeLessThan(60);
  });

  it('anchors elapsed to launchStamp, not to a zero clock (B-548 regression)', async () => {
    // A realistic non-zero launch stamp: elapsed must be (now - launchStamp), so exactly one window
    // passes regardless of the absolute clock value. A regression that conflated elapsed with the raw
    // clock value would time out immediately (clock already >> windowMs) or never.
    const launchStamp = 1_700_000_000_000;
    let t = launchStamp;
    const res = await runPollLoop({
      readTask: async () => ({ workflow_state: 'Built' }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      launchStamp,
      baseline: { workflowState: 'Built' },
    });
    expect(res.reason).toBe('timeout');
    expect(t - launchStamp).toBe(WATCH_WINDOW_MS);
  });

  it('follows the backoff schedule: first ~120s, a steady <300s middle, a coarse ~900s tail', async () => {
    const clock = makeClock();
    await runPollLoop({
      readTask: async () => ({ workflow_state: 'Built' }), // never changes → runs the full schedule
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built' },
    });
    // First delay is the tight early poll.
    expect(clock.sleeps[0]).toBe(POLL_CADENCE.firstDelayMs);
    // The steady middle and the coarse tail both occur.
    expect(clock.sleeps).toContain(POLL_CADENCE.steadyDelayMs);
    expect(clock.sleeps).toContain(POLL_CADENCE.tailDelayMs);
    // Backoff is monotonic non-decreasing until the final cap to the remaining window.
    const uncapped = clock.sleeps.slice(0, -1);
    for (let i = 1; i < uncapped.length; i++) {
      expect(uncapped[i]).toBeGreaterThanOrEqual(uncapped[i - 1]);
    }
    // The total of all sleeps equals exactly one window (the cap lands the last wake on the boundary).
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(WATCH_WINDOW_MS);
  });

  it('honors an injected cadence + custom window (full injection, no real time)', async () => {
    const clock = makeClock();
    let reads = 0;
    const res = await runPollLoop({
      readTask: async () => {
        reads += 1;
        return { workflow_state: 'Built' };
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built' },
      windowMs: 1_000,
      cadence: () => 100,
    });
    expect(res.reason).toBe('timeout');
    expect(clock.now()).toBe(1_000);
    expect(reads).toBe(11); // reads at 0,100,...,1000 → 11 reads, last one trips the timeout
  });
});
