// B-691 regression suite: a watch armed BEFORE the pause it waits on must still fire.
//
// The original report (B-685, 2026-07-10) recorded `{"reason":"timeout","elapsed_ms":5400187}` from a
// watch that was armed inside the 16-second gap between opening an elicitation exchange and filing its
// first round. The human answered 60 minutes in; the watch never noticed and ran the full ~90-minute
// window. These tests pin the behaviour that makes that impossible.

import { describe, it, expect } from 'vitest';
import {
  runPollLoop,
  captureBaseline,
  detectChange,
  WATCH_WINDOW_MS,
  UNWATCHABLE_AFTER_POLLS,
  type Taskish,
  type PollBaseline,
} from './poll-loop.js';

const AT_REST: Taskish = { workflow_state: 'Proposed', awaiting_human_input: false };
const PAUSED: Taskish = {
  workflow_state: 'Proposed',
  awaiting_human_input: true,
  active_exchange: { exchange_id: 'ex-1', status: 'active', round: 1 },
};
const ANSWERED: Taskish = {
  workflow_state: 'Proposed',
  awaiting_human_input: false,
  active_exchange: {
    exchange_id: 'ex-1',
    status: 'active',
    round: 1,
    answers_submitted_at: '2026-07-10T09:50:18.398Z',
  },
};

/** Drive the real loop with a fake clock over a time-indexed sequence of reads. */
async function drive(
  seq: (t: number) => Taskish,
  baseline: PollBaseline,
  opts: { unwatchableAfterPolls?: number } = {},
) {
  let clock = 0;
  let reads = 0;
  const result = await runPollLoop({
    readTask: async () => {
      reads += 1;
      return seq(clock);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    launchStamp: 0,
    windowMs: WATCH_WINDOW_MS,
    baseline,
    ...opts,
  });
  return { result, reads, elapsed: clock };
}

describe('B-691 — a watch armed before its pause was filed', () => {
  it('fires when the human answers, instead of running the full window (the B-685 repro)', async () => {
    // Armed at rest; the round is filed at 60s; the human answers at 3600s.
    const seq = (t: number) => (t < 60_000 ? AT_REST : t < 3_600_000 ? PAUSED : ANSWERED);

    const { result, elapsed } = await drive(seq, captureBaseline(AT_REST));

    expect(result.reason).toBe('changed');
    expect(result.reason === 'changed' && result.detail.trigger).toBe('answers-landed');
    // The whole point: it resolves when the human acted, NOT at the ~90-minute window boundary.
    expect(elapsed).toBeLessThan(WATCH_WINDOW_MS);
  });

  it('a pinned baseline is what used to break it — the transition is invisible from a stale snapshot', () => {
    // Direct statement of the defect: comparing the ANSWERED read against the AT-REST snapshot the
    // watch was armed with yields nothing, because no true->false transition is visible from there.
    expect(detectChange(captureBaseline(AT_REST), ANSWERED)).toBeNull();
    // Against the immediately preceding read, the same answer is unmissable.
    expect(detectChange(captureBaseline(PAUSED), ANSWERED)?.trigger).toBe('answers-landed');
  });

  it('still fires normally when armed correctly, at the pause', async () => {
    const seq = (t: number) => (t < 3_600_000 ? PAUSED : ANSWERED);
    const { result } = await drive(seq, captureBaseline(PAUSED));
    expect(result.reason === 'changed' && result.detail.trigger).toBe('answers-landed');
  });
});

describe('B-691 — an unwatchable watch says so instead of waiting out the window', () => {
  it('exits `unwatchable`, not `timeout`, when the ball is never with the human', async () => {
    const { result, elapsed } = await drive(() => AT_REST, captureBaseline(AT_REST));

    expect(result.reason).toBe('unwatchable');
    expect(result.reason === 'unwatchable' && result.polls).toBe(UNWATCHABLE_AFTER_POLLS);
    // It must give up early — waiting the full window IS the defect being fixed.
    expect(elapsed).toBeLessThan(WATCH_WINDOW_MS);
  });

  it('does NOT declare unwatchable when the pause simply arrives late — that case self-recovers', async () => {
    // At rest for the first two polls, then a pause appears and is resolved.
    const seq = (t: number) => (t < 300_000 ? AT_REST : t < 600_000 ? PAUSED : ANSWERED);
    const { result } = await drive(seq, captureBaseline(AT_REST), { unwatchableAfterPolls: 99 });
    expect(result.reason).toBe('changed');
  });

  it('a real pause the human never resolves still exits `timeout`, not `unwatchable`', async () => {
    const { result } = await drive(() => PAUSED, captureBaseline(PAUSED));
    expect(result.reason).toBe('timeout');
  });
});

describe('B-691 — rolling the baseline does not corrupt marker freshness', () => {
  it('a marker already present when the watch was armed stays stale', async () => {
    // Armed while an unconsumed answers marker is already sitting there, with the flag still up.
    const armedWithMarker: Taskish = { ...PAUSED, active_exchange: ANSWERED.active_exchange };
    const seq = (t: number) => (t < 300_000 ? armedWithMarker : { ...ANSWERED });
    const { result } = await drive(seq, captureBaseline(armedWithMarker));
    // The flag clears, but the marker is the same one that was there at arm time — so it is NOT
    // reported as freshly landed answers; it falls through to the non-advancing-accept case.
    expect(result.reason === 'changed' && result.detail.trigger).toBe('resolved');
  });

  it('a transient read error cannot manufacture a resolution', async () => {
    // The degraded read must be compared against the CURRENT baseline. If it were compared against
    // the LAUNCH baseline after the flag had risen, the substituted stale flag would look like a
    // true->false transition and fire the gate on a failed read.
    let reads = 0;
    let clock = 0;
    const result = await runPollLoop({
      readTask: async () => {
        reads += 1;
        if (reads === 1) return AT_REST; // armed at rest
        if (reads === 2) return PAUSED; // the pause appears
        if (reads === 3) throw new Error('transient network failure');
        return PAUSED; // still paused; nobody has resolved anything
      },
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      launchStamp: 0,
      windowMs: 1_000_000,
      baseline: captureBaseline(AT_REST),
    });

    expect(result.reason).toBe('timeout');
  });
});
