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
  };

  return { deps, ticks, stopped, logs, writes, keeper: createHeartbeatKeeper(deps) };
}

/** Let the beat's promise chain settle (the tick itself is fire-and-forget). */
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
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
  it('does NOT stop on a thrown operational error — a blip is not lease loss', async () => {
    const h = harness({ results: [new Error('JWT expired')] });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();

    expect(h.keeper.running()).toEqual(['cond-1']);
    expect(h.stopped).toEqual([]);
    expect(h.logs.join(' ')).toMatch(/JWT expired/);
  });

  it('recovers on the next tick after a transient failure', async () => {
    const h = harness({ results: [new Error('network down'), null] });
    h.keeper.ensure('cond-1');
    h.ticks[0]();
    await settle();
    expect(h.keeper.running()).toEqual(['cond-1']); // survived the blip

    h.ticks[0]();
    await settle();
    expect(h.keeper.running()).toEqual([]); // then a real no-row-matched stops it
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
