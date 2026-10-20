// B-1173: standby boot, the readiness file and the carried-over request of the remote conductor.

import { describe, it, expect } from 'vitest';
import {
  bootRemoteRegistry,
  channelFromPosture,
  createCarriedRequestCompleter,
  createReadiness,
  DEFAULT_READY_FILE,
  isRemoteConductor,
  readyFilePath,
} from './conductor-remote.js';
import type { BootDecision } from './conductor-registry-keeper.js';

describe('mode and paths', () => {
  it('is remote only for HARMONY_CONDUCTOR_REMOTE=1', () => {
    expect(isRemoteConductor({ HARMONY_CONDUCTOR_REMOTE: '1' })).toBe(true);
    expect(isRemoteConductor({ HARMONY_CONDUCTOR_REMOTE: '0' })).toBe(false);
    expect(isRemoteConductor({ KUBERNETES_SERVICE_HOST: '10.0.0.1' })).toBe(false);
    expect(isRemoteConductor({})).toBe(false);
  });
  it('the ready file defaults to /tmp/harmony-ready and follows HARMONY_READY_FILE', () => {
    expect(readyFilePath({})).toBe(DEFAULT_READY_FILE);
    expect(DEFAULT_READY_FILE).toBe('/tmp/harmony-ready');
    expect(readyFilePath({ HARMONY_READY_FILE: '/run/ready' })).toBe('/run/ready');
    expect(readyFilePath({ HARMONY_READY_FILE: '' })).toBe(DEFAULT_READY_FILE);
  });
  it('maps the posture to the registry channel', () => {
    expect(channelFromPosture('prod')).toBe('prod');
    expect(channelFromPosture('ack:staging')).toBe('staging');
    expect(channelFromPosture('staging')).toBe('staging');
    expect(channelFromPosture(undefined)).toBeNull();
  });
});

describe('readiness file', () => {
  it('writes once and removes on clear; failures are logged, never thrown', () => {
    const files = new Set<string>();
    const logs: string[] = [];
    const r = createReadiness({ path: '/tmp/x', writeFile: (p) => void files.add(p), removeFile: (p) => void files.delete(p), log: (l) => logs.push(l) });
    r.markReady();
    expect(files.has('/tmp/x')).toBe(true);
    r.clear();
    expect(files.has('/tmp/x')).toBe(false);
    const bad = createReadiness({
      path: '/ro/x',
      writeFile: () => {
        throw new Error('EROFS');
      },
      removeFile: () => {
        throw new Error('ENOENT');
      },
      log: (l) => logs.push(l),
    });
    expect(() => bad.markReady()).not.toThrow();
    expect(() => bad.clear()).not.toThrow();
    expect(logs.join('\n')).toContain('stays NotReady');
  });
});

describe('standby boot', () => {
  const REFUSED: BootDecision = { proceed: false, message: 'a conductor for this project is already running on pod-old (last heartbeat 3s ago); refusing to start' };
  const script = (...decisions: BootDecision[]) => {
    const q = [...decisions];
    let calls = 0;
    return { boot: async () => (calls++, q.shift() ?? REFUSED), calls: () => calls };
  };

  it('an immediate acquire proceeds without standing by', async () => {
    const k = script({ proceed: true });
    const logs: string[] = [];
    let standby = 0;
    const r = await bootRemoteRegistry(k, { log: (l) => logs.push(l), sleep: async () => {}, retryMs: 10, isStopped: () => false, onStandby: () => void standby++ });
    expect(r).toBe('acquired');
    expect(standby).toBe(0);
    expect(logs).toEqual([]);
  });

  it('a refusal logs ONCE, does not exit, retries on the cadence and proceeds when the lease is acquired', async () => {
    const k = script(REFUSED, REFUSED, REFUSED, { proceed: true });
    const logs: string[] = [];
    const sleeps: number[] = [];
    let standby = 0;
    const r = await bootRemoteRegistry(k, { log: (l) => logs.push(l), sleep: async (ms) => void sleeps.push(ms), retryMs: 10_000, isStopped: () => false, onStandby: () => void standby++ });
    expect(r).toBe('acquired');
    expect(k.calls()).toBe(4);
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(standby).toBe(1);
    expect(logs.filter((l) => l.startsWith('standby:') && l.includes('already running'))).toHaveLength(1);
    expect(logs.at(-1)).toContain('booting normally');
  });

  it('stops standing by when a shutdown signal arrives', async () => {
    const k = script(REFUSED);
    let stopped = false;
    const r = await bootRemoteRegistry(k, {
      log: () => {},
      sleep: async () => {
        stopped = true;
      },
      retryMs: 5,
      isStopped: () => stopped,
    });
    expect(r).toBe('stopped');
    expect(k.calls()).toBe(1);
  });
});

describe('carried-over request completion', () => {
  const setup = (over: { state?: string; action?: string; version?: string | null } = {}) => {
    const calls: Array<{ holder: string; args: Record<string, unknown> }> = [];
    const logs: string[] = [];
    const complete = createCarriedRequestCompleter({
      client: {
        async completeRequest(holder, args) {
          calls.push({ holder, args: args as unknown as Record<string, unknown> });
          return { kind: 'ok' };
        },
      },
      holderId: 'pod-new:1:bbbb0000',
      pluginVersion: over.version === undefined ? '0.15.65' : over.version,
      log: (l) => logs.push(l),
    });
    const run = (prev: string | null) => complete({ request: { id: 'req-1', action: over.action ?? 'update', state: over.state ?? 'claimed' }, previousHolderId: 'pod-old:1:aaaa0000', previousPluginVersion: prev });
    return { calls, logs, run };
  };

  it('completes done as the NEW holder with the version before and after in the reason', async () => {
    const t = setup();
    await t.run('0.15.64');
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].holder).toBe('pod-new:1:bbbb0000');
    expect(t.calls[0].args).toMatchObject({ requestId: 'req-1', result: 'done', versionBefore: '0.15.64', versionAfter: '0.15.65' });
    expect(String(t.calls[0].args.reason)).toContain('0.15.64 -> 0.15.65');
  });

  it('records unknown when the previous holder reported no version', async () => {
    const t = setup();
    await t.run(null);
    expect(String(t.calls[0].args.reason)).toContain('unknown -> 0.15.65');
  });

  it('a restart onto the same version says unchanged', async () => {
    const t = setup({ action: 'restart' });
    await t.run('0.15.65');
    expect(String(t.calls[0].args.reason)).toContain('0.15.65 (unchanged)');
  });

  it('an unrecognised action completes failed with the reason', async () => {
    const t = setup({ action: 'reboot' });
    await t.run('0.15.64');
    expect(t.calls[0].args).toMatchObject({ result: 'failed' });
    expect(String(t.calls[0].args.reason)).toContain('unrecognised request action "reboot"');
  });

  it('leaves a request that is not claimed alone', async () => {
    const t = setup({ state: 'done' });
    await t.run('0.15.64');
    expect(t.calls).toHaveLength(0);
  });
});
