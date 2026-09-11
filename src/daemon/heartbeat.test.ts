import { describe, it, expect } from 'vitest';
import { createHeartbeatKeeper, type HeartbeatDeps } from './heartbeat.js';
import type { ConductionPatch, ConductionRecord } from '../tools/conduction-record.js';

const T0 = 1_000_000_000; // fake epoch origin (nonzero so a zero-based bug is visible)

interface HarnessOpts {
  /** Per-call results, consumed in order: a row (held), null (lease gone), or an Error (thrown). */
  results?: Array<ConductionRecord | null | Error>;
}

// A fake timer world: startInterval records the callback so a test can fire ticks by hand, and
// records which timers were stopped. No real setInterval anywhere.
function harness(opts: HarnessOpts = {}) {
  const ticks: Array<() => void> = [];
  const stopped: number[] = [];
  const logs: string[] = [];
  const writes: Array<{ id: string; patch: ConductionPatch }> = [];
  const sleeps: number[] = [];
  let refreshCalls = 0;
  let call = 0;

  const deps: HeartbeatDeps = {
    now: () => T0,
    startInterval: (_ms, fn) => {
      const idx = ticks.push(fn) - 1;
      return () => stopped.push(idx);
    },
    updateConductionIfHeld: async (id, patch) => {
      writes.push({ id, patch });
      const result = opts.results?.[call++];
      if (result instanceof Error) throw result;
      return result === undefined ? ({} as ConductionRecord) : result;
    },
    log: (line) => logs.push(line),
    heartbeatMs: 30_000,
    // B-845: immediate-resolving fakes — real backoff TIMING is write-retry.test.ts's job; this
    // harness only needs the retry LOOP itself to be exercisable without a real delay.
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    forceRefresh: async () => {
      refreshCalls += 1;
    },
  };

  return {
    deps,
    ticks,
    stopped,
    logs,
    writes,
    sleeps,
    refreshCalls: () => refreshCalls,
    keeper: createHeartbeatKeeper(deps),
  };
}

/** Let the beat's promise chain settle (the tick itself is fire-and-forget). B-845: beat() may now
 *  run withWriteRetry's internal retry loop (each round: an awaited write + an awaited sleep), so a
 *  fixed handful of microtask flushes is generous enough to cover every round, not just a single
 *  unwrapped write. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe('createHeartbeatKeeper — liveness independent of pass progress (B-739)', () => {
  it('stamps only last_heartbeat_at, from the injected clock', async () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();

    expect(h.writes).toEqual([
      { id: 'cond-1', patch: { last_heartbeat_at: new Date(T0).toISOString() } },
    ]);
  });

  it('arms one timer per lease and is idempotent — ensure twice does not double-stamp', () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.keeper.ensure('cond-1');

    expect(h.ticks).toHaveLength(1);
    expect(h.keeper.running()).toEqual(['cond-1']);
  });

  // The defect this module exists for: the pass loop is strictly serial, so ONE blocked worker
  // used to starve the stamp for EVERY lease the daemon holds — including idle queued ones, which
  // then advertised themselves as reapable despite doing nothing wrong.
  it('keeps a SECOND held lease stamping — one blocked worker never starves the others', async () => {
    const h = harness();
    h.keeper.ensure('cond-blocked');
    h.keeper.ensure('cond-idle');

    h.ticks[1](); // the idle lease ticks on its own timer, regardless of cond-blocked
    await settle();

    expect(h.writes.map((w) => w.id)).toEqual(['cond-idle']);
    expect(h.keeper.running()).toEqual(['cond-blocked', 'cond-idle']);
  });

  it('keeps stamping across repeated ticks while a pass is blocked', async () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();
    h.ticks[0]();
    await settle();
    h.ticks[0]();
    await settle();

    expect(h.writes).toHaveLength(3);
    expect(h.keeper.running()).toEqual(['cond-1']);
  });

  it('STOPS the lease when the guarded write reports no row matched — the lease is gone', async () => {
    const h = harness({ results: [null] });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();

    expect(h.keeper.running()).toEqual([]);
    expect(h.stopped).toEqual([0]);
    expect(h.logs.join(' ')).toMatch(/lease no longer held/);
  });

  // Invariant 3, and the sharpest edge in this module: conflating a transient failure with lease
  // loss would stop the heartbeat during exactly the blip that makes a healthy daemon look dead.
  //
  // B-845: this write is now wrapped in withWriteRetry('idempotent'), which retries an
  // unrecognized-code error (the conservative default bucket) TWICE (250ms then 750ms backoff)
  // before giving up — so a persistent (not self-healing) blip needs three queued failures to
  // outlast every retry and still reach this module's own catch/log/keep-running path unchanged.
  it('does NOT stop on a thrown operational error that outlasts every internal retry — a blip is not lease loss', async () => {
    const h = harness({
      results: [new Error('JWT expired'), new Error('JWT expired'), new Error('JWT expired')],
    });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();

    expect(h.keeper.running()).toEqual(['cond-1']);
    expect(h.stopped).toEqual([]);
    expect(h.logs.join(' ')).toMatch(/JWT expired/);
    // All three attempts were made (the initial write plus both bounded network-error retries),
    // backing off 250ms then 750ms in between — never a forced refresh (no PGRST303 code here).
    expect(h.writes).toHaveLength(3);
    expect(h.sleeps).toEqual([250, 750]);
    expect(h.refreshCalls()).toBe(0);
  });

  it('recovers on the next tick after a failure that outlasts this ticks own retries', async () => {
    const h = harness({
      results: [new Error('network down'), new Error('network down'), new Error('network down'), null],
    });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();
    expect(h.keeper.running()).toEqual(['cond-1']); // survived the blip (still failing after retries)

    h.ticks[0]();
    await settle();
    expect(h.keeper.running()).toEqual([]); // then a real no-row-matched stops it
  });

  // B-845 checklist item 11: a retry that itself SUCCEEDS but returns null (lease no longer held)
  // must still stop the keeper immediately — success-with-null is invariant 3's OTHER branch, not
  // a reason to keep looping the retry.
  it('a null row after a SUCCESSFUL internal retry stops the keeper and never retries again', async () => {
    const h = harness({ results: [new Error('network down'), null] });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();

    expect(h.keeper.running()).toEqual([]);
    expect(h.stopped).toEqual([0]);
    expect(h.logs.join(' ')).toMatch(/lease no longer held/);
    // Only ONE retry was needed (the second write succeeded, with a null result) — no second
    // backoff, and no PGRST303 forced refresh.
    expect(h.writes).toHaveLength(2);
    expect(h.sleeps).toEqual([250]);
    expect(h.refreshCalls()).toBe(0);
  });

  it('retain() stops only the leases that left the active set', () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.keeper.ensure('cond-2');
    h.keeper.retain(new Set(['cond-2']));

    expect(h.keeper.running()).toEqual(['cond-2']);
  });

  it('stopAll() clears everything — a lease goes quiet the moment the process leaves', () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.keeper.ensure('cond-2');
    h.keeper.stopAll();

    expect(h.keeper.running()).toEqual([]);
    expect(h.stopped).toEqual([0, 1]);
  });

  it('stop() is idempotent for an unknown or already-stopped lease', () => {
    const h = harness();
    h.keeper.ensure('cond-1');
    h.keeper.stop('cond-1');
    h.keeper.stop('cond-1');
    h.keeper.stop('never-started');

    expect(h.keeper.running()).toEqual([]);
    expect(h.stopped).toEqual([0]);
  });
});
