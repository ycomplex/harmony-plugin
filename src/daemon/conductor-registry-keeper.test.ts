// B-1172: the registry keeper against a fake clock, a fake timer world and a scripted registry.
// The four safety rules are tested here; same-host dead-pid takeover; boot refusal; registry-absent fallback.

import { describe, it, expect } from 'vitest';
import {
  bootRegistry,
  createRegistryKeeper,
  refusalMessage,
  type RegistryKeeperDeps,
} from './conductor-registry-keeper.js';
import {
  createRegistryClient,
  type AcquireOutcome,
  type HeartbeatOutcome,
  type PendingRequest,
  type RegistryClient,
  type RpcFn,
} from './conductor-registry.js';

const T0 = 1_000_000_000;
const HOST = 'macmini';
const OWN = `${HOST}:4242:aaaa1111`;

interface Script {
  acquire: AcquireOutcome[];
  heartbeat: HeartbeatOutcome[];
}

function scripted(script: Partial<Script> = {}) {
  const calls: Array<{ fn: string; takeover?: boolean }> = [];
  const acquire = [...(script.acquire ?? [])];
  const heartbeat = [...(script.heartbeat ?? [])];
  const client = {
    async acquire(_id, opts) {
      calls.push({ fn: 'acquire', takeover: opts?.takeoverDeadPid === true });
      return acquire.shift() ?? { kind: 'unknown', detail: 'script exhausted' };
    },
    async heartbeat() {
      calls.push({ fn: 'heartbeat' });
      return heartbeat.shift() ?? { kind: 'unknown', detail: 'script exhausted' };
    },
    async release() {
      calls.push({ fn: 'release' });
      return { kind: 'ok' };
    },
  } as unknown as RegistryClient;
  return { client, calls };
}

const ACQUIRED: AcquireOutcome = { kind: 'acquired', reason: null, previousHolderId: null, previousHost: null, previousPluginVersion: null, request: null };
const refused = (holderId: string, holderHost: string, age = 12): AcquireOutcome => ({
  kind: 'refused',
  reason: 'held-fresh',
  holderId,
  holderHost,
  holderPluginVersion: '1.0.0',
  heartbeatAgeSeconds: age,
});
const HELD: HeartbeatOutcome = { kind: 'held', reasserted: false, request: null };
const UNKNOWN: HeartbeatOutcome = { kind: 'unknown', detail: 'fetch failed' };

function harness(client: RegistryClient, over: Partial<RegistryKeeperDeps> = {}) {
  let clock = T0;
  const logs: string[] = [];
  const lost: Array<{ holderHost: string | null }> = [];
  const ticks: Array<() => void> = [];
  const stopped: number[] = [];
  const deps: RegistryKeeperDeps = {
    client,
    identity: { holderId: OWN, host: HOST, location: 'local', profile: 'gke', channel: 'staging', pluginVersion: '1.2.3', logUrl: null },
    now: () => clock,
    startInterval: (_ms, fn) => {
      const i = ticks.push(fn) - 1;
      return () => stopped.push(i);
    },
    heartbeatMs: 30_000,
    isPidAlive: () => true,
    ownPid: 4242,
    log: (l) => logs.push(l),
    onLost: (info) => lost.push(info),
    ...over,
  };
  const keeper = createRegistryKeeper(deps);
  return { keeper, logs, lost, ticks, stopped, advance: (ms: number) => (clock += ms) };
}

describe('boot', () => {
  it('acquired: proceeds and logs', async () => {
    const { client } = scripted({ acquire: [ACQUIRED] });
    const h = harness(client);
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.join('\n')).toContain('acquired the conductor row');
  });

  it('refused (other host): message names the holder host and heartbeat age; does not proceed; no takeover retry', async () => {
    const { client, calls } = scripted({ acquire: [refused('other:77:zzzz', 'other', 12)] });
    const h = harness(client);
    const d = await h.keeper.boot();
    expect(d).toEqual({ proceed: false, message: 'a conductor for this project is already running on other (last heartbeat 12s ago); refusing to start' });
    expect(calls).toEqual([{ fn: 'acquire', takeover: false }]);
  });

  it('same-host holder whose pid is DEAD: retries with the dead-pid takeover, logs it, proceeds', async () => {
    const { client, calls } = scripted({ acquire: [refused(`${HOST}:5555:old00000`, HOST, 3), { ...ACQUIRED, kind: 'taken_over', reason: 'same-host-dead-pid', previousHolderId: `${HOST}:5555:old00000` }] });
    const h = harness(client, { isPidAlive: (pid) => pid !== 5555 });
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    expect(calls).toEqual([
      { fn: 'acquire', takeover: false },
      { fn: 'acquire', takeover: true },
    ]);
    expect(h.logs.join('\n')).toContain('pid 5555 is not running');
    expect(h.logs.join('\n')).toContain('took over');
  });

  it('same-host holder whose pid is ALIVE: refused, no takeover', async () => {
    const { client, calls } = scripted({ acquire: [refused(`${HOST}:5555:old00000`, HOST, 3)] });
    const h = harness(client, { isPidAlive: () => true });
    const d = await h.keeper.boot();
    expect(d.proceed).toBe(false);
    expect(calls.every((c) => c.takeover === false)).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('same-host holder with OUR pid but another uuid is a previous incarnation (container pid reuse): takeover', async () => {
    const { client, calls } = scripted({ acquire: [refused(`${HOST}:4242:older000`, HOST), { ...ACQUIRED, kind: 'taken_over' }] });
    const h = harness(client, { isPidAlive: () => true });
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    expect(calls[1]).toEqual({ fn: 'acquire', takeover: true });
  });

  it('OTHER host holder counts only by staleness: a dead-looking pid number never triggers a takeover', async () => {
    const { client, calls } = scripted({ acquire: [refused('other:5555:zzzz0000', 'other', 40)] });
    const h = harness(client, { isPidAlive: () => false });
    expect((await h.keeper.boot()).proceed).toBe(false);
    expect(calls).toEqual([{ fn: 'acquire', takeover: false }]);
  });

  it('a stale other-host holder is taken over by the DATABASE (taken_over), not the client', async () => {
    const { client, calls } = scripted({ acquire: [{ ...ACQUIRED, kind: 'taken_over', reason: 'stale', previousHolderId: 'other:1:x', previousHost: 'other' }] });
    const h = harness(client);
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    expect(calls).toEqual([{ fn: 'acquire', takeover: false }]);
    expect(h.logs.join('\n')).toContain('previous holder other:1:x on other, stale');
  });

  it('refusal message copes with an unknown host / age', () => {
    expect(refusalMessage({ kind: 'refused', reason: null, holderId: null, holderHost: null, holderPluginVersion: null, heartbeatAgeSeconds: null })).toBe(
      'a conductor for this project is already running on another host (age unknown); refusing to start',
    );
  });
});

describe('bootRegistry (the daemon boot step)', () => {
  it('a refusal exits NON-ZERO, writes host + age to stderr, and the scheduler never starts', async () => {
    const { client } = scripted({ acquire: [refused('other:77:zzzz', 'other', 12)] });
    const h = harness(client);
    const stderr: string[] = [];
    const exits: number[] = [];
    let schedulerStarted = false;
    const ok = await bootRegistry(h.keeper, { writeStderr: (t) => stderr.push(t), log: h.logs.push.bind(h.logs), exit: (c) => exits.push(c) });
    if (ok) schedulerStarted = true; // what daemon.ts does next
    expect(ok).toBe(false);
    expect(exits).toEqual([1]);
    expect(stderr.join('')).toBe('a conductor for this project is already running on other (last heartbeat 12s ago); refusing to start\n');
    expect(schedulerStarted).toBe(false);
    expect(h.ticks.length).toBe(0); // no heartbeat timer either
  });

  it('proceeds without exiting when acquired', async () => {
    const { client } = scripted({ acquire: [ACQUIRED] });
    const h = harness(client);
    const exits: number[] = [];
    expect(await bootRegistry(h.keeper, { writeStderr: () => {}, log: () => {}, exit: (c) => exits.push(c) })).toBe(true);
    expect(exits).toEqual([]);
  });
});

describe('registry absent / transient at boot', () => {
  it('unavailable: ONE log line, proceeds, and later ticks inside the re-probe window stay silent and call nothing', async () => {
    const { client, calls } = scripted({ acquire: [{ kind: 'unavailable', detail: '42883: function does not exist' }] });
    const h = harness(client);
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    expect(h.logs.length).toBe(1);
    expect(h.logs[0]).toContain('registry unavailable');
    h.keeper.start();
    for (let i = 0; i < 5; i++) {
      h.advance(30_000);
      await h.keeper.tick();
    }
    expect(calls.length).toBe(1); // only the boot acquire: 2.5 minutes < 5 minute re-probe
    expect(h.logs.length).toBe(1);
  });

  it('unavailable: re-probes after 5 minutes (silently if still absent); begins using the registry once the functions appear', async () => {
    const { client, calls } = scripted({
      acquire: [{ kind: 'unavailable', detail: 'x' }, { kind: 'unavailable', detail: 'x' }, ACQUIRED],
      heartbeat: [HELD],
    });
    const h = harness(client);
    await h.keeper.boot();
    h.advance(5 * 60_000);
    await h.keeper.tick(); // still absent
    expect(h.keeper.state()).toBe('unacquired');
    expect(h.logs.length).toBe(1);
    h.advance(5 * 60_000);
    await h.keeper.tick(); // appeared
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.join('\n')).toContain('now reachable');
    h.advance(30_000);
    await h.keeper.tick();
    expect(calls.map((c) => c.fn)).toEqual(['acquire', 'acquire', 'acquire', 'heartbeat']);
  });

  it('unknown at boot: does NOT exit, logs once, retries EVERY tick until it acquires', async () => {
    const { client, calls } = scripted({
      acquire: [{ kind: 'unknown', detail: 'fetch failed' }, { kind: 'unknown', detail: 'fetch failed' }, { kind: 'unknown', detail: 'fetch failed' }, ACQUIRED],
    });
    const h = harness(client);
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    for (let i = 0; i < 3; i++) {
      h.advance(30_000);
      await h.keeper.tick();
    }
    expect(h.keeper.state()).toBe('held');
    expect(calls.filter((c) => c.fn === 'acquire').length).toBe(4);
    expect(h.logs.filter((l) => l.includes('fetch failed')).length).toBe(1);
  });

  it('a later-tick refusal (another conductor registered meanwhile) does NOT exit this running conductor', async () => {
    const { client } = scripted({ acquire: [{ kind: 'unavailable', detail: 'x' }, refused('other:9:zzzz', 'other', 5)] });
    const h = harness(client);
    await h.keeper.boot();
    h.advance(5 * 60_000);
    await h.keeper.tick();
    expect(h.lost).toEqual([]);
    expect(h.keeper.state()).toBe('unacquired');
    expect(h.logs.join('\n')).toContain('continues unregistered');
  });
});

describe('SAFETY RULES for the heartbeat', () => {
  it('rule 1: failed heartbeats (network / timeout / 5xx / missing function) are NEVER lost; one log per outage, one on recovery', async () => {
    const { client } = scripted({
      acquire: [ACQUIRED],
      heartbeat: [UNKNOWN, { kind: 'unknown', detail: 'timed out' }, { kind: 'unknown', detail: 'HTTP 503' }, { kind: 'unknown', detail: '42883' }, HELD, UNKNOWN, HELD],
    });
    const h = harness(client);
    await h.keeper.boot();
    h.keeper.start();
    for (let i = 0; i < 7; i++) {
      h.advance(30_000);
      await h.keeper.tick();
    }
    expect(h.lost).toEqual([]);
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.filter((l) => l.includes('heartbeat failed')).length).toBe(2); // outage 1 and outage 2, once each
    expect(h.logs.filter((l) => l.includes('heartbeat recovered')).length).toBe(2);
    expect(h.logs.find((l) => l.includes('heartbeat recovered'))).toContain('after 4 failed attempts');
  });

  it('rule 2: LOST (a different holder, fresh heartbeat) calls onLost once, stops ticking, and never calls the registry again', async () => {
    const { client, calls } = scripted({
      acquire: [ACQUIRED],
      heartbeat: [HELD, { kind: 'lost', holderId: 'other:9:zzzz', holderHost: 'other' }, HELD],
    });
    const h = harness(client);
    await h.keeper.boot();
    h.keeper.start();
    await h.keeper.tick();
    await h.keeper.tick();
    await h.keeper.tick();
    expect(h.lost).toEqual([{ holderId: 'other:9:zzzz', holderHost: 'other' }]);
    expect(h.keeper.state()).toBe('lost');
    expect(h.stopped).toEqual([0]);
    expect(calls.filter((c) => c.fn === 'heartbeat').length).toBe(2);
    expect(h.logs.join('\n')).toContain('held by other (other:9:zzzz) with a fresh heartbeat');
  });

  it('rule 2b: a lost keeper does not call release at shutdown (the row is not ours)', async () => {
    const { client, calls } = scripted({ acquire: [ACQUIRED], heartbeat: [{ kind: 'lost', holderId: 'o:1:x', holderHost: 'o' }] });
    const h = harness(client);
    await h.keeper.boot();
    await h.keeper.tick();
    await h.keeper.release();
    expect(calls.some((c) => c.fn === 'release')).toBe(false);
  });

  it('rule 3: our own lease went stale and nobody took it: the heartbeat re-asserts it, no exit', async () => {
    const { client } = scripted({ acquire: [ACQUIRED], heartbeat: [{ kind: 'held', reasserted: true, request: null }, HELD] });
    const h = harness(client);
    await h.keeper.boot();
    h.keeper.start();
    h.advance(10 * 60_000);
    await h.keeper.tick();
    expect(h.lost).toEqual([]);
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.join('\n')).toContain('re-asserted');
  });
});

// Rule 4 end to end through the REAL client over a fake Supabase: an outage LONGER than the stale window, then
// recovery in which the database re-asserts our own lease. No exit at any point.
describe('rule 4: a Supabase outage longer than the stale window', () => {
  it('never exits; the first heartbeat after recovery re-asserts our own lease', async () => {
    let outage = true;
    const rpc: RpcFn = async (fn) => {
      if (fn === 'conductor_acquire') return { data: { status: 'acquired', reason: null }, error: null };
      if (outage) return { data: null, error: { code: '', message: 'upstream connect error (HTTP 503)' } };
      return { data: { status: 'ok', reasserted: true, request: null }, error: null };
    };
    const client = createRegistryClient({
      rpc,
      projectId: 'p',
      startTimeout: () => () => {},
      forceRefresh: async () => {},
      sleep: async () => {},
    });
    const h = harness(client);
    expect(await h.keeper.boot()).toEqual({ proceed: true });
    h.keeper.start();
    // 12 ticks of 30s = 6 minutes of outage > the 5 minute stale window
    for (let i = 0; i < 12; i++) {
      h.advance(30_000);
      await h.keeper.tick();
    }
    expect(h.lost).toEqual([]);
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.filter((l) => l.includes('heartbeat failed')).length).toBe(1);
    outage = false;
    h.advance(30_000);
    await h.keeper.tick();
    expect(h.lost).toEqual([]);
    expect(h.keeper.state()).toBe('held');
    expect(h.logs.some((l) => l.includes('heartbeat recovered after 12 failed attempts'))).toBe(true);
    expect(h.logs.some((l) => l.includes('re-asserted'))).toBe(true);
  });
});

describe('ticks do not overlap', () => {
  it('a slow heartbeat in flight makes the next tick a no-op', async () => {
    let release!: () => void;
    let beats = 0;
    const client = {
      async acquire() {
        return ACQUIRED;
      },
      async heartbeat() {
        beats += 1;
        await new Promise<void>((r) => (release = r));
        return HELD;
      },
    } as unknown as RegistryClient;
    const h = harness(client);
    await h.keeper.boot();
    const first = h.keeper.tick();
    await h.keeper.tick(); // returns at once: one is in flight
    expect(beats).toBe(1);
    release();
    await first;
  });
});

describe('requests on the heartbeat', () => {
  const REQ: PendingRequest = { id: 'req-1', action: 'update', requestedBy: 'u1', requestedAt: 't' };

  it('hands a pending request to onRequest once; retries only when told to', async () => {
    const seen: string[] = [];
    const verdicts: Array<'handled' | 'retry'> = ['retry', 'handled'];
    const { client } = scripted({
      acquire: [ACQUIRED],
      heartbeat: [1, 2, 3, 4].map(() => ({ kind: 'held', reasserted: false, request: REQ }) as HeartbeatOutcome),
    });
    const h = harness(client, {
      onRequest: async (r) => {
        seen.push(r.id);
        return verdicts.shift() ?? 'handled';
      },
    });
    await h.keeper.boot();
    for (let i = 0; i < 4; i++) await h.keeper.tick();
    expect(seen).toEqual(['req-1', 'req-1']); // first said retry, second handled, then never again
  });
});

describe('release on shutdown', () => {
  it('releases the row when held; a release failure is logged and ignored', async () => {
    const calls: string[] = [];
    const client = {
      async acquire() {
        return ACQUIRED;
      },
      async release(_id: string, o?: { timeoutMs?: number }) {
        calls.push(`release:${o?.timeoutMs}`);
        return { kind: 'unknown', detail: 'network down' };
      },
    } as unknown as RegistryClient;
    const h = harness(client);
    await h.keeper.boot();
    h.keeper.start();
    await expect(h.keeper.release()).resolves.toBeUndefined();
    expect(calls).toEqual(['release:2000']);
    expect(h.stopped).toEqual([0]);
    expect(h.logs.join('\n')).toContain('release failed (network down)');
  });

  it('does not call release when never registered', async () => {
    const { client, calls } = scripted({ acquire: [{ kind: 'unavailable', detail: 'x' }] });
    const h = harness(client);
    await h.keeper.boot();
    await h.keeper.release();
    expect(calls.some((c) => c.fn === 'release')).toBe(false);
  });

  it('a hung release is bounded by the client timeout (shutdown never blocks)', async () => {
    // real client: release uses the 2s bound passed by the keeper
    const timeouts: number[] = [];
    const rpc: RpcFn = (fn) => (fn === 'conductor_acquire' ? Promise.resolve({ data: { status: 'acquired' }, error: null }) : new Promise(() => {}));
    const client = createRegistryClient({
      rpc,
      projectId: 'p',
      startTimeout: (ms, fn) => {
        timeouts.push(ms);
        if (ms === 2_000) queueMicrotask(fn); // only the release bound fires (the hung call)
        return () => {};
      },
      forceRefresh: async () => {},
      sleep: async () => {},
    });
    const h = harness(client);
    await h.keeper.boot();
    await h.keeper.release();
    expect(timeouts).toContain(2_000);
    expect(h.logs.join('\n')).toContain('release failed');
  });
});
