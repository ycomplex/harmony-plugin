import { describe, it, expect } from 'vitest';
import {
  runPollLoop,
  detectChange,
  baselineReadFallback,
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
  // The poll is armed while the conductor is awaiting the human, so the baseline is "awaiting" (flag true).
  const baseline: PollBaseline = { workflowState: 'Built', pendingResolution: null, awaitingHumanInput: true };

  it('returns null when nothing changed (flag still set — still awaiting)', () => {
    expect(
      detectChange(baseline, { workflow_state: 'Built', pending_resolution: null, awaiting_human_input: true }),
    ).toBeNull();
  });

  it('GATE (B-611): returns null until awaiting_human_input clears, even if other fields look different', () => {
    // The flag is the SOLE exit gate: a state/marker difference WITHOUT the flag clearing is not an exit.
    expect(
      detectChange(
        { workflowState: 'Decomposed', awaitingHumanInput: true },
        { workflow_state: 'Designed', awaiting_human_input: true },
      ),
    ).toBeNull();
  });

  it('reports a forward state advance (gate fires true→false)', () => {
    expect(
      detectChange(
        { workflowState: 'Clarified', awaitingHumanInput: true },
        { workflow_state: 'Decomposed', awaiting_human_input: false },
      ),
    ).toEqual({
      trigger: 'state-advanced',
      workflow_state: 'Decomposed',
    });
  });

  it('reports Parked (browser defer/deny) with the parked trigger, not a generic advance', () => {
    expect(
      detectChange(
        { workflowState: 'Designed', awaitingHumanInput: true },
        { workflow_state: 'Parked', awaiting_human_input: false },
      ),
    ).toEqual({
      trigger: 'parked',
      workflow_state: 'Parked',
    });
  });

  it('reports a newly-present pending_resolution (browser reshape) when state is unchanged', () => {
    const change = detectChange(baseline, {
      workflow_state: 'Built',
      pending_resolution: { command: 'iterate', detail: 'tighten the scope' },
      awaiting_human_input: false,
    });
    expect(change).toEqual({
      trigger: 'pending_resolution',
      workflow_state: 'Built',
      pending_resolution: { command: 'iterate', detail: 'tighten the scope' },
    });
  });

  it('B-611: reports `resolved` on a non-advancing accept (flag cleared, state unchanged, no pending_resolution)', () => {
    // The B-611 case: a design sub-track brief composed with `pending_activity: null` clears the flag
    // without advancing state / reshaping / parking. This is a real resolution, not a timeout.
    expect(
      detectChange(
        { workflowState: 'Decomposed', awaitingHumanInput: true },
        { workflow_state: 'Decomposed', awaiting_human_input: false },
      ),
    ).toEqual({ trigger: 'resolved', workflow_state: 'Decomposed' });
  });

  it('does NOT classify a pending_resolution identical to the baseline marker as a fresh reshape (flag still set)', () => {
    const pr = { command: 'iterate', detail: 'x' };
    expect(
      detectChange(
        { workflowState: 'Built', pendingResolution: pr, awaitingHumanInput: true },
        { workflow_state: 'Built', pending_resolution: pr, awaiting_human_input: true },
      ),
    ).toBeNull();
  });

  it('triggers when the pending_resolution detail changes from the baseline', () => {
    const change = detectChange(
      { workflowState: 'Built', pendingResolution: { command: 'iterate', detail: 'a' }, awaitingHumanInput: true },
      { workflow_state: 'Built', pending_resolution: { command: 'iterate', detail: 'b' }, awaiting_human_input: false },
    );
    expect(change?.trigger).toBe('pending_resolution');
  });
});

describe('baselineReadFallback (B-611 — a transient read error must not false-trip the exit gate)', () => {
  it('projects the baseline back as a fresh read, carrying awaiting_human_input', () => {
    const baseline: PollBaseline = {
      workflowState: 'Decomposed',
      pendingResolution: { command: 'iterate', detail: 'x' },
      awaitingHumanInput: true,
    };
    expect(baselineReadFallback(baseline)).toEqual({
      workflow_state: 'Decomposed',
      pending_resolution: { command: 'iterate', detail: 'x' },
      awaiting_human_input: true,
    });
  });

  it('detectChange returns null for the fallback shape — a degraded poll never reads as a resolution', () => {
    const baseline: PollBaseline = { workflowState: 'Decomposed', pendingResolution: null, awaitingHumanInput: true };
    expect(detectChange(baseline, baselineReadFallback(baseline))).toBeNull();
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
  const baseline: PollBaseline = { workflowState: 'Clarified', pendingResolution: null, awaitingHumanInput: true };

  it('exits changed when workflow_state advances', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(
      3,
      { workflow_state: 'Clarified', awaiting_human_input: true },
      { workflow_state: 'Decomposed', awaiting_human_input: false },
    );
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

  it('B-611: exits changed with `resolved` on a non-advancing accept (flag cleared, state unchanged)', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(
      3,
      { workflow_state: 'Decomposed', awaiting_human_input: true },
      { workflow_state: 'Decomposed', awaiting_human_input: false },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Decomposed', awaitingHumanInput: true },
    });
    expect(res).toEqual({ reason: 'changed', detail: { trigger: 'resolved', workflow_state: 'Decomposed' } });
    expect(reader.count()).toBe(3);
  });

  it('B-611 no false exit: keeps watching to timeout while awaiting_human_input stays true', async () => {
    const clock = makeClock();
    let reads = 0;
    const res = await runPollLoop({
      readTask: async () => {
        reads += 1;
        return { workflow_state: 'Decomposed', awaiting_human_input: true }; // never resolved
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Decomposed', awaitingHumanInput: true },
    });
    expect(res).toEqual({ reason: 'timeout' });
    expect(reads).toBeGreaterThan(3);
  });

  it('B-611 read-error path: a reader that always degrades to the fallback runs to timeout, never false-exits', async () => {
    const clock = makeClock();
    const base: PollBaseline = { workflowState: 'Decomposed', pendingResolution: null, awaitingHumanInput: true };
    let reads = 0;
    const res = await runPollLoop({
      readTask: async () => {
        reads += 1;
        return baselineReadFallback(base); // every poll degraded to the transient-error fallback
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: base,
    });
    expect(res).toEqual({ reason: 'timeout' });
    expect(reads).toBeGreaterThan(3);
  });

  it('exits changed when a browser reshape leaves a pending_resolution', async () => {
    const clock = makeClock();
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Clarified', pending_resolution: null, awaiting_human_input: true },
      { workflow_state: 'Clarified', pending_resolution: { command: 'iterate', detail: 'broaden' }, awaiting_human_input: false },
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
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Designed', awaiting_human_input: true },
      { workflow_state: 'Parked', awaiting_human_input: false },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Designed', awaitingHumanInput: true },
    });
    expect(res).toEqual({ reason: 'changed', detail: { trigger: 'parked', workflow_state: 'Parked' } });
  });

  it('catches a change on the FIRST read, before any sleep', async () => {
    const clock = makeClock();
    const res = await runPollLoop({
      readTask: async () => ({ workflow_state: 'Decomposed', awaiting_human_input: false }),
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
        return { workflow_state: 'Built', awaiting_human_input: true }; // never resolves
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built', awaitingHumanInput: true },
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
      readTask: async () => ({ workflow_state: 'Built', awaiting_human_input: true }),
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
      launchStamp,
      baseline: { workflowState: 'Built', awaitingHumanInput: true },
    });
    expect(res.reason).toBe('timeout');
    expect(t - launchStamp).toBe(WATCH_WINDOW_MS);
  });

  it('follows the backoff schedule: first ~120s, a steady <300s middle, a coarse ~900s tail', async () => {
    const clock = makeClock();
    await runPollLoop({
      readTask: async () => ({ workflow_state: 'Built', awaiting_human_input: true }), // never changes → runs the full schedule
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built', awaitingHumanInput: true },
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
        return { workflow_state: 'Built', awaiting_human_input: true };
      },
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built', awaitingHumanInput: true },
      windowMs: 1_000,
      cadence: () => 100,
    });
    expect(res.reason).toBe('timeout');
    expect(clock.now()).toBe(1_000);
    expect(reads).toBe(11); // reads at 0,100,...,1000 → 11 reads, last one trips the timeout
  });
});
