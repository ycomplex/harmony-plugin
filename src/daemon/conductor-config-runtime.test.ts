import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConductorConfigError, resetConductorWarningDedupe } from '../config/conductor-config.js';
import type { DeploymentConfig } from '../config/deployment-config.js';
import { startConductorConfigRuntime } from './conductor-config-runtime.js';

const project = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    channel: 'staging',
    profile: 'cloud',
    gcp: { project: 'proj', region: 'us-east1' },
    cloud_run: { job: 'job-a' },
    concurrency: { max_workers: 4 },
    ...over,
  });
// The host file's github_app block is the daemon's App identity, so the refresh mints an installation token
// through the (injected) fetch with a throwaway key generated here.
const KEY_PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
let keyPath = '';
const host = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    config_repo: 'o/r',
    plugin_dir: '/plug',
    github_app: { app_id: '1', installation_id: '2', private_key_path: keyPath },
    ...over,
  });

let dir: string;
let logs: string[];
let env: NodeJS.ProcessEnv;
let config: { maxConcurrentWorkers: number };
beforeEach(() => {
  resetConductorWarningDedupe();
  dir = mkdtempSync(join(tmpdir(), 'conductor-rt-'));
  logs = [];
  keyPath = join(dir, 'app.pem');
  writeFileSync(keyPath, KEY_PEM);
  env = { HARMONY_HOME: dir };
  config = { maxConcurrentWorkers: 4 }; // what loadDaemonConfig derives from the project file's max_workers
});

const hostPath = () => join(dir, 'conductor-host.json');
const snapPath = () => join(dir, 'conductor-snapshot.json');

/** A fetch that serves whatever `serve.body` currently holds (and 304s a matching etag). */
function server(initial: string) {
  const serve = { body: initial, status: 200 };
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/access_tokens')) {
      return new Response(JSON.stringify({ token: 'tok', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), { status: 201 });
    }
    const inm = (init?.headers as Record<string, string> | undefined)?.['If-None-Match'];
    const etag = `W/"${createHash('sha1').update(serve.body).digest('hex')}"`;
    if (serve.status === 200 && inm === etag) return new Response(null, { status: 304 });
    if (serve.status !== 200) return new Response('x', { status: serve.status });
    return new Response(serve.body, { status: 200, headers: { etag } });
  });
  return { serve, impl };
}

const contentsCalls = (impl: ReturnType<typeof server>['impl']) =>
  impl.mock.calls.filter(([u]) => String(u).includes('/contents/')).length;

function timers() {
  const t = { fn: undefined as undefined | (() => void), ms: 0, unref: vi.fn(), cleared: [] as unknown[] };
  const handle = { unref: t.unref };
  return {
    t,
    setIntervalImpl: (fn: () => void, ms: number) => {
      t.fn = fn;
      t.ms = ms;
      return handle;
    },
    clearIntervalImpl: (h: unknown) => t.cleared.push(h),
    handle,
  };
}

const start = (fetchImpl: ReturnType<typeof server>['impl'], tm = timers(), legacy: DeploymentConfig | null = null) =>
  startConductorConfigRuntime({
    env,
    log: (l) => logs.push(l),
    config,
    loadLegacy: () => legacy,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    setIntervalImpl: tm.setIntervalImpl,
    clearIntervalImpl: tm.clearIntervalImpl,
  }).then((rt) => ({ rt, tm }));

describe('startConductorConfigRuntime: legacy-only host', () => {
  it('returns an inert runtime: no deploymentConfig, no timer, no network, env untouched', async () => {
    const before = { ...env };
    const { impl } = server(project());
    const tm = timers();
    const rt = await startConductorConfigRuntime({
      env,
      log: (l) => logs.push(l),
      config,
      loadLegacy: () => ({ worker_image: 'x' }),
      fetchImpl: impl as unknown as typeof fetch,
      setIntervalImpl: () => {
        throw new Error('no timer may start');
      },
    });
    expect(rt.deploymentConfig).toBeNull();
    expect(rt.defaultProfile).toBeUndefined();
    expect(rt.getModelPolicy()).toBeUndefined();
    expect(env).toEqual(before);
    expect(config.maxConcurrentWorkers).toBe(4);
    expect(impl).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    await rt.applyNow();
    rt.stop();
    void tm;
  });
});

describe('startConductorConfigRuntime: start', () => {
  it('refreshes the snapshot once, loads the merged config, applies launch env and starts an unref-ed 5 minute timer', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt, tm } = await start(s.impl);
    expect(s.impl).toHaveBeenCalledTimes(2); // token mint + contents GET
    expect(JSON.parse(readFileSync(snapPath(), 'utf8')).content).toBe(project());
    expect(rt.defaultProfile).toBe('cloud');
    expect(rt.deploymentConfig?.profiles?.cloud?.maxConcurrentWorkers).toBe(4);
    expect(env.HARMONY_CLOUD_RUN_REGION).toBe('us-east1');
    expect(env.HARMONY_CLOUD_RUN_JOB).toBe('job-a');
    expect(env.CLOUDSDK_CORE_PROJECT).toBe('proj');
    expect(logs.some((l) => l.startsWith('conductor config: sources=['))).toBe(true);
    expect(tm.t.ms).toBe(5 * 60_000);
    expect(tm.t.unref).toHaveBeenCalledTimes(1);
  });

  it('an explicit operator env value is not overwritten', async () => {
    writeFileSync(hostPath(), host());
    env.HARMONY_CLOUD_RUN_JOB = 'operator-job';
    await start(server(project()).impl);
    expect(env.HARMONY_CLOUD_RUN_JOB).toBe('operator-job');
  });

  it('a failed first refresh only logs: the existing snapshot is used', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    await start(s.impl); // writes the snapshot
    resetConductorWarningDedupe();
    logs.length = 0;
    s.serve.status = 500;
    const { rt } = await start(s.impl);
    expect(rt.deploymentConfig).not.toBeNull();
    expect(logs.some((l) => l.includes('conductor config refresh failed'))).toBe(true);
  });

  it('does not refresh without a config_repo (host file only), and loads via legacy fallback', async () => {
    writeFileSync(hostPath(), host({ config_repo: undefined }));
    const s = server(project());
    const legacy: DeploymentConfig = { worker_image: 'x', env: { HARMONY_PLUGIN_POSTURE: 'ack:staging' }, profiles: { cloud: { launch: 'l', reap: 'r', gcloud_project: 'old' } } };
    const { rt } = await start(s.impl, timers(), legacy);
    expect(s.impl).not.toHaveBeenCalled();
    expect(rt.defaultProfile).toBe('cloud');
  });

  it('a ConductorConfigError at start propagates (bad host file)', async () => {
    writeFileSync(hostPath(), JSON.stringify({ version: 1, bogus: true }));
    await expect(start(server(project()).impl)).rejects.toBeInstanceOf(ConductorConfigError);
  });

  it('a malformed config_repo propagates', async () => {
    writeFileSync(hostPath(), host({ config_repo: 'not a repo' }));
    await expect(start(server(project()).impl)).rejects.toBeInstanceOf(ConductorConfigError);
  });
});

describe('the refresh timer', () => {
  it('unchanged (304) changes nothing and logs nothing new', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt } = await start(s.impl);
    logs.length = 0;
    await rt.applyNow();
    expect(contentsCalls(s.impl)).toBe(2);
    expect(logs).toEqual([]);
  });

  it('applies hot keys immediately: max_workers, model_policy, log_shipping and launch env', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt, tm } = await start(s.impl);
    s.serve.body = project({ concurrency: { max_workers: 7 }, model_policy: { default: 'm1', per_gate: { build: 'm2' } }, log_shipping: false, cloud_run: { job: 'job-b' } });
    tm.t.fn!(); // the real timer callback is fire-and-forget
    await rt.applyNow();
    expect(config.maxConcurrentWorkers).toBe(7);
    expect(rt.getModelPolicy()).toEqual({ default: 'm1', per_gate: { build: 'm2' } });
    expect(rt.getLogShipping()).toBe(false);
    expect(env.HARMONY_CLOUD_RUN_JOB).toBe('job-b'); // a key WE set is updated on refresh
    // cloud_run.job is restart-only for the RUNNING process (logged), though the env the launch scripts read follows it
    expect(logs.filter((l) => l.includes('restart needed'))).toEqual(['conductor config: restart needed — cloud_run.job']);
  });

  it('HARMONY_DAEMON_MAX_CONCURRENT_WORKERS pins the cap against a hot change', async () => {
    writeFileSync(hostPath(), host());
    env.HARMONY_DAEMON_MAX_CONCURRENT_WORKERS = '1';
    const s = server(project());
    const { rt } = await start(s.impl);
    s.serve.body = project({ concurrency: { max_workers: 9 } });
    await rt.applyNow();
    expect(config.maxConcurrentWorkers).toBe(4);
  });

  it('logs restart-only keys once and does not apply them', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt } = await start(s.impl);
    s.serve.body = project({ gcp: { project: 'other', region: 'us-east1' }, channel: 'prod' });
    await rt.applyNow();
    const lines = logs.filter((l) => l.includes('restart needed'));
    expect(lines).toEqual(['conductor config: restart needed — channel, gcp.project']);
    s.serve.body = project({ gcp: { project: 'other', region: 'us-east1' }, channel: 'prod', concurrency: { max_workers: 5 } });
    await rt.applyNow();
    expect(logs.filter((l) => l.includes('restart needed'))).toHaveLength(1); // same pending set: not repeated
    expect(config.maxConcurrentWorkers).toBe(5); // hot key still applied
    expect(rt.deploymentConfig?.profiles?.cloud?.gcloud_project).toBe('proj'); // the booted value is unchanged
  });

  it('an invalid project file keeps the last good config and warns', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt } = await start(s.impl);
    s.serve.body = '{ "version": 1, "channel": "nope" }';
    await rt.applyNow();
    expect(logs.some((l) => l.includes('is invalid') && l.includes('keeping the last-good snapshot'))).toBe(true);
    expect(JSON.parse(readFileSync(snapPath(), 'utf8')).content).toBe(project());
    expect(config.maxConcurrentWorkers).toBe(4);
  });

  it('an invalid reload keeps the previous config and is logged ONCE per distinct message', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt } = await start(s.impl);
    writeFileSync(hostPath(), JSON.stringify({ version: 1, bogus: 1 }));
    await rt.applyNow();
    await rt.applyNow();
    expect(logs.filter((l) => l.includes('reload failed'))).toHaveLength(1);
    expect(logs.find((l) => l.includes('reload failed'))).toContain('bogus');
    // a different breakage is a new message
    writeFileSync(hostPath(), JSON.stringify({ version: 1, other: 1 }));
    await rt.applyNow();
    expect(logs.filter((l) => l.includes('reload failed'))).toHaveLength(2);
    // recovery applies again
    writeFileSync(hostPath(), host());
    s.serve.body = project({ concurrency: { max_workers: 6 } });
    await rt.applyNow();
    expect(config.maxConcurrentWorkers).toBe(6);
    expect(rt.deploymentConfig?.profiles?.cloud?.maxConcurrentWorkers).toBe(4); // boot-time projection is stable
  });

  it('the tick never throws even when the fetch explodes', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt, tm } = await start(s.impl);
    s.impl.mockImplementation(async () => {
      throw new Error('boom');
    });
    await expect(rt.applyNow()).resolves.toBeUndefined();
    expect(() => tm.t.fn!()).not.toThrow();
  });

  it('stop() clears the timer once and later ticks do nothing', async () => {
    writeFileSync(hostPath(), host());
    const s = server(project());
    const { rt, tm } = await start(s.impl);
    rt.stop();
    rt.stop();
    expect(tm.t.cleared).toEqual([tm.handle]);
    const calls = s.impl.mock.calls.length;
    await rt.applyNow();
    expect(s.impl.mock.calls.length).toBe(calls);
    expect(() => tm.t.fn!()).not.toThrow();
  });
});

describe('B-1174: gcp.project / gcloud.account getters for the log shipper', () => {
  it('follow the merged config hot, and are undefined on a legacy-only host', async () => {
    writeFileSync(hostPath(), host({ gcloud: { account: 'ops@example.com' } }));
    const s = server(project());
    const { rt, tm } = await start(s.impl);
    expect(rt.getGcpProject()).toBe('proj');
    expect(rt.getGcloudAccount()).toBe('ops@example.com');
    s.serve.body = project({ gcp: { project: 'proj-2' } });
    tm.t.fn!();
    await rt.applyNow();
    expect(rt.getGcpProject()).toBe('proj-2');
    expect(rt.getGcloudAccount()).toBe('ops@example.com');
  });
});
