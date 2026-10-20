// B-1172: acting on a registry restart/update request: claim, stop launching, spawn the detached restarter.

import { describe, it, expect } from 'vitest';
import { createRequestHandler, restarterArgs, RESTART_RESUME_AFTER_MS, type RequestHandlerDeps } from './conductor-request.js';
import type { ClaimOutcome, CompleteOutcome, PendingRequest } from './conductor-registry.js';

const REQ_UPDATE: PendingRequest = { id: 'req-1', action: 'update', requestedBy: 'u1', requestedAt: 't' };
const REQ_RESTART: PendingRequest = { id: 'req-2', action: 'restart', requestedBy: 'u1', requestedAt: 't' };

function world(o: { claim?: ClaimOutcome; spawnThrows?: string; config?: string } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const spawned: string[][] = [];
  const completed: Array<{ requestId: string; result: string; reason?: string | null }> = [];
  const exitCbs: Array<(code: number | null) => void> = [];
  const fallbacks: Array<() => void> = [];
  const fallbackMs: number[] = [];
  const deps: RequestHandlerDeps = {
    client: {
      claimRequest: async () => o.claim ?? { kind: 'claimed', action: 'update' },
      completeRequest: async (_h, a): Promise<CompleteOutcome> => {
        completed.push(a);
        events.push('complete');
        return { kind: 'ok' };
      },
    },
    holderId: 'macmini:1:aaaa',
    configPath: o.config,
    spawnRestarter: (args) => {
      if (o.spawnThrows) throw new Error(o.spawnThrows);
      spawned.push(args);
      events.push('spawn');
      return { onExit: (cb) => void exitCbs.push(cb) };
    },
    pauseLaunching: () => events.push('pause'),
    resumeLaunching: () => events.push('resume'),
    startTimeout: (ms, fn) => {
      fallbackMs.push(ms);
      fallbacks.push(fn);
      return () => {};
    },
    log: (l) => logs.push(l),
  };
  return { handler: createRequestHandler(deps), events, logs, spawned, completed, exitCbs, fallbacks, fallbackMs };
}

describe('restarterArgs', () => {
  it("'restart' passes --no-pull; 'update' does not", () => {
    expect(restarterArgs(REQ_RESTART)).toEqual(['conductor', 'restart', '--no-pull', '--request', 'req-2']);
    expect(restarterArgs(REQ_UPDATE)).toEqual(['conductor', 'restart', '--request', 'req-1']);
  });
  it('forwards an explicit --config', () => {
    expect(restarterArgs(REQ_UPDATE, '/c/deployment.json')).toEqual(['conductor', 'restart', '--request', 'req-1', '--config', '/c/deployment.json']);
  });
});

describe('request handling', () => {
  it('claimed: stops launching FIRST, then spawns the restarter (update = no --no-pull)', async () => {
    const w = world({ config: '/c/d.json' });
    expect(await w.handler(REQ_UPDATE)).toBe('handled');
    expect(w.events).toEqual(['pause', 'spawn']);
    expect(w.spawned).toEqual([['conductor', 'restart', '--request', 'req-1', '--config', '/c/d.json']]);
    expect(w.completed).toEqual([]);
  });

  it("claimed 'restart': spawns with --no-pull", async () => {
    const w = world();
    await w.handler(REQ_RESTART);
    expect(w.spawned).toEqual([['conductor', 'restart', '--no-pull', '--request', 'req-2']]);
  });

  it.each([
    ['expired', { kind: 'expired', reason: 'too old' }],
    ['refused', { kind: 'refused', reason: 'not holder' }],
  ] as Array<[string, ClaimOutcome]>)('%s claim: nothing paused, nothing spawned, handled', async (_n, claim) => {
    const w = world({ claim });
    expect(await w.handler(REQ_UPDATE)).toBe('handled');
    expect(w.events).toEqual([]);
  });

  it('a transient claim failure asks to retry and does nothing else', async () => {
    const w = world({ claim: { kind: 'unknown', detail: 'fetch failed' } });
    expect(await w.handler(REQ_UPDATE)).toBe('retry');
    expect(w.events).toEqual([]);
  });

  it("a spawn failure completes the request 'failed' with the reason and RESUMES launching", async () => {
    const w = world({ spawnThrows: 'ENOENT harmony.js' });
    expect(await w.handler(REQ_UPDATE)).toBe('handled');
    expect(w.events).toEqual(['pause', 'resume', 'complete']);
    expect(w.completed).toEqual([{ requestId: 'req-1', result: 'failed', reason: 'could not spawn the restarter: ENOENT harmony.js' }]);
  });

  it('the restarter exiting while this conductor is still alive means the restart did not happen: launching resumes', async () => {
    const w = world();
    await w.handler(REQ_UPDATE);
    w.exitCbs[0](1);
    expect(w.events).toEqual(['pause', 'spawn', 'resume']);
    w.fallbacks[0](); // the fallback timer firing later is a no-op
    expect(w.events.filter((e) => e === 'resume').length).toBe(1);
  });

  it('a restarter that never exits and never stops us: the fallback timer resumes launching', async () => {
    const w = world();
    await w.handler(REQ_UPDATE);
    expect(w.fallbackMs).toEqual([RESTART_RESUME_AFTER_MS]);
    w.fallbacks[0]();
    expect(w.events).toEqual(['pause', 'spawn', 'resume']);
  });
});
