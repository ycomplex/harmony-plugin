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

describe('detectChange — answers-landed (B-645 elicitation exchange)', () => {
  // The watch is armed right after a round is filed: awaiting flag up, exchange active, marker clear.
  const baseline: PollBaseline = {
    workflowState: 'Proposed',
    pendingResolution: null,
    awaitingHumanInput: true,
    activeExchange: { exchange_id: 'ex-1', status: 'active', round: 2, answers_submitted_at: null, force_quit_requested_at: null },
  };

  it('classifies answers-landed when the human submits a round (marker set, flag cleared, state unchanged)', () => {
    const ex = { exchange_id: 'ex-1', status: 'active', round: 2, answers_submitted_at: '2026-07-02T10:00:00Z', force_quit_requested_at: null };
    expect(
      detectChange(baseline, { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: ex }),
    ).toEqual({ trigger: 'answers-landed', workflow_state: 'Proposed', active_exchange: ex });
  });

  it('classifies answers-landed on a force-quit request too', () => {
    const ex = { exchange_id: 'ex-1', status: 'active', round: 2, answers_submitted_at: null, force_quit_requested_at: '2026-07-02T10:05:00Z' };
    const change = detectChange(baseline, { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: ex });
    expect(change?.trigger).toBe('answers-landed');
  });

  it('ORDERING (the B-611 cousin): an exchange answer must NOT classify as `resolved`', () => {
    // A round-submit clears the flag with NO state advance / reshape / park — exactly the shape of the
    // B-611 non-advancing accept. answers-landed is checked BEFORE resolved so the answers get consumed.
    const change = detectChange(baseline, {
      workflow_state: 'Proposed',
      awaiting_human_input: false,
      active_exchange: { exchange_id: 'ex-1', answers_submitted_at: '2026-07-02T10:00:00Z' },
    });
    expect(change?.trigger).not.toBe('resolved');
    expect(change?.trigger).toBe('answers-landed');
  });

  it('a state advance still wins over an exchange marker (priority order preserved)', () => {
    const change = detectChange(baseline, {
      workflow_state: 'Clarified',
      awaiting_human_input: false,
      active_exchange: { exchange_id: 'ex-1', answers_submitted_at: '2026-07-02T10:00:00Z' },
    });
    expect(change?.trigger).toBe('state-advanced');
  });

  it('a fresh pending_resolution still wins over an exchange marker (priority order preserved)', () => {
    const change = detectChange(baseline, {
      workflow_state: 'Proposed',
      awaiting_human_input: false,
      pending_resolution: { command: 'iterate', detail: 'reshape' },
      active_exchange: { exchange_id: 'ex-1', answers_submitted_at: '2026-07-02T10:00:00Z' },
    });
    expect(change?.trigger).toBe('pending_resolution');
  });

  it('a marker identical to the baseline is STALE — falls through to `resolved`, not answers-landed', () => {
    const stale = { exchange_id: 'ex-1', status: 'active', round: 2, answers_submitted_at: '2026-07-02T09:00:00Z', force_quit_requested_at: null };
    const change = detectChange(
      { ...baseline, activeExchange: stale },
      { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: stale },
    );
    expect(change?.trigger).toBe('resolved');
  });

  it('GATE unchanged: an exchange marker with the flag still up is NOT an exit', () => {
    expect(
      detectChange(baseline, {
        workflow_state: 'Proposed',
        awaiting_human_input: true,
        active_exchange: { exchange_id: 'ex-1', answers_submitted_at: '2026-07-02T10:00:00Z' },
      }),
    ).toBeNull();
  });

  it('an active exchange with NO marker does not classify answers-landed (falls to resolved)', () => {
    const change = detectChange(baseline, {
      workflow_state: 'Proposed',
      awaiting_human_input: false,
      active_exchange: { exchange_id: 'ex-1', status: 'active', round: 2, answers_submitted_at: null, force_quit_requested_at: null },
    });
    expect(change?.trigger).toBe('resolved');
  });
});

describe('detectChange — discuss-requested (B-461 discuss verb)', () => {
  const baseline: PollBaseline = { workflowState: 'Built', pendingResolution: null, awaitingHumanInput: true };

  it("classifies discuss-requested when the flag clears with a { command: 'discuss' } marker", () => {
    const pr = { command: 'discuss', detail: 'why not the simpler option?' };
    expect(
      detectChange(baseline, { workflow_state: 'Built', pending_resolution: pr, awaiting_human_input: false }),
    ).toEqual({ trigger: 'discuss-requested', workflow_state: 'Built', pending_resolution: pr });
  });

  it("a reshape marker still classifies pending_resolution (only command === 'discuss' re-routes)", () => {
    const change = detectChange(baseline, {
      workflow_state: 'Built',
      pending_resolution: { command: 'iterate', detail: 'tighten the scope' },
      awaiting_human_input: false,
    });
    expect(change?.trigger).toBe('pending_resolution');
  });

  it('GATE unchanged: a discuss marker with the flag still up is NOT an exit', () => {
    expect(
      detectChange(baseline, {
        workflow_state: 'Built',
        pending_resolution: { command: 'discuss', detail: 'x' },
        awaiting_human_input: true,
      }),
    ).toBeNull();
  });

  it('a discuss marker identical to the baseline is STALE — never a fresh discuss-requested', () => {
    const pr = { command: 'discuss', detail: 'x' };
    const change = detectChange(
      { workflowState: 'Built', pendingResolution: pr, awaitingHumanInput: true },
      { workflow_state: 'Built', pending_resolution: pr, awaiting_human_input: false },
    );
    expect(change?.trigger).toBe('resolved');
  });
});

describe('detectChange — discussion-cancelled (B-461, the one no-flag-transition exit)', () => {
  // The watch is armed mid-discussion: awaiting flag up, discuss exchange active on the brief.
  const activeEx = { exchange_id: 'ex-1', status: 'active', round: 1, answers_submitted_at: null, force_quit_requested_at: null };
  const baseline: PollBaseline = {
    workflowState: 'Proposed', pendingResolution: null, awaitingHumanInput: true, activeExchange: activeEx,
  };

  it('classifies discussion-cancelled when the active exchange row is GONE without a flag true→false', () => {
    // A mechanical cancel restores awaiting=true DIRECTLY (no true→false transition — the B-611
    // blind-spot class), and get_task's active-only projection now reads null for the exchange.
    expect(
      detectChange(baseline, { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: null }),
    ).toEqual({ trigger: 'discussion-cancelled', workflow_state: 'Proposed' });
  });

  it('classifies discussion-cancelled when the exchange status changed without a flag true→false', () => {
    expect(
      detectChange(baseline, {
        workflow_state: 'Proposed',
        awaiting_human_input: true,
        active_exchange: { ...activeEx, status: 'abandoned' },
      }),
    ).toEqual({ trigger: 'discussion-cancelled', workflow_state: 'Proposed' });
  });

  it('does NOT fire when the flag transition happened — the post-gate classification owns that read', () => {
    const change = detectChange(baseline, { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: null });
    expect(change?.trigger).toBe('resolved');
  });

  it('does NOT fire while the baseline exchange is still active (keeps polling)', () => {
    expect(
      detectChange(baseline, { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: activeEx }),
    ).toBeNull();
  });

  it('does NOT fire when the baseline had no ACTIVE exchange', () => {
    expect(
      detectChange(
        { workflowState: 'Proposed', pendingResolution: null, awaitingHumanInput: true },
        { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: null },
      ),
    ).toBeNull();
  });

  it('a degraded read (baselineReadFallback) can never false-trip discussion-cancelled', () => {
    expect(detectChange(baseline, baselineReadFallback(baseline))).toBeNull();
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

  it('carries the baseline active_exchange (B-645) so a degraded poll cannot false-trip answers-landed', () => {
    const baseline: PollBaseline = {
      workflowState: 'Proposed',
      pendingResolution: null,
      awaitingHumanInput: true,
      activeExchange: { exchange_id: 'ex-1', answers_submitted_at: '2026-07-02T09:00:00Z', force_quit_requested_at: null },
    };
    expect(baselineReadFallback(baseline).active_exchange).toEqual(baseline.activeExchange);
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

  it('exits changed with answers-landed when the human submits an elicitation round (B-645)', async () => {
    const clock = makeClock();
    const exBaseline = { exchange_id: 'ex-1', status: 'active', round: 1, answers_submitted_at: null, force_quit_requested_at: null };
    const exAnswered = { ...exBaseline, answers_submitted_at: '2026-07-02T10:00:00Z' };
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: exBaseline },
      { workflow_state: 'Proposed', awaiting_human_input: false, active_exchange: exAnswered },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Proposed', awaitingHumanInput: true, activeExchange: exBaseline },
    });
    expect(res).toEqual({
      reason: 'changed',
      detail: { trigger: 'answers-landed', workflow_state: 'Proposed', active_exchange: exAnswered },
    });
  });

  it('exits changed with discuss-requested when the human clicks Discuss in the browser (B-461)', async () => {
    const clock = makeClock();
    const pr = { command: 'discuss', detail: 'talk me through the trade-off' };
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Built', pending_resolution: null, awaiting_human_input: true },
      { workflow_state: 'Built', pending_resolution: pr, awaiting_human_input: false },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Built', pendingResolution: null, awaitingHumanInput: true },
    });
    expect(res).toEqual({
      reason: 'changed',
      detail: { trigger: 'discuss-requested', workflow_state: 'Built', pending_resolution: pr },
    });
  });

  it('exits changed with discussion-cancelled when a mechanical cancel lands mid-watch (B-461)', async () => {
    const clock = makeClock();
    const activeEx = { exchange_id: 'ex-1', status: 'active', round: 1, answers_submitted_at: null, force_quit_requested_at: null };
    const reader = readTaskAfter(
      2,
      { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: activeEx },
      // The cancel restores awaiting=true directly; the active exchange is gone from the projection.
      { workflow_state: 'Proposed', awaiting_human_input: true, active_exchange: null },
    );
    const res = await runPollLoop({
      readTask: reader.read,
      now: clock.now,
      sleep: clock.sleep,
      launchStamp: 0,
      baseline: { workflowState: 'Proposed', awaitingHumanInput: true, activeExchange: activeEx },
    });
    expect(res).toEqual({ reason: 'changed', detail: { trigger: 'discussion-cancelled', workflow_state: 'Proposed' } });
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
