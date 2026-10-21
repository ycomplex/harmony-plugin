// B-1173: the remote (Kubernetes) lifecycle: the in-pod restarter and `start|stop --remote`.
// kubectl and gcloud are stubbed, and BOTH stubs REJECT UNKNOWN FLAGS (the real tools do), so a made-up flag or
// subcommand cannot pass for a real call.

import { describe, expect, it } from 'vitest';
import type { CompleteOutcome, RegistryClient, RegistryStatus, StatusOutcome } from '../../daemon/conductor-registry.js';
import type { ExecResult, LifecycleDeps } from './conductor-lifecycle-deps.js';
import { runRestart, runStart, runStatus, runStop } from './conductor-lifecycle.js';
import { compareVersionTags, newestVersionTag } from './conductor-kube.js';

const IMAGE = 'us-central1-docker.pkg.dev/proj/harmony-workers/harmony-conductor';
const T0 = Date.parse('2026-10-20T12:00:00Z');

interface Call { file: string; args: string[] }

// kubectl: verb path -> flags it accepts (flag -> takes a value)
const KUBECTL: Array<{ verb: string[]; flags: Record<string, boolean> }> = [
  { verb: ['get'], flags: { '-n': true, '--context': true, '-o': true } },
  { verb: ['set', 'image'], flags: { '-n': true, '--context': true } },
  { verb: ['rollout', 'restart'], flags: { '-n': true, '--context': true } },
  { verb: ['rollout', 'status'], flags: { '-n': true, '--context': true, '--timeout': true } },
  { verb: ['rollout', 'undo'], flags: { '-n': true, '--context': true } },
  { verb: ['scale'], flags: { '-n': true, '--context': true, '--replicas': true } },
];
const GCLOUD = [{ verb: ['artifacts', 'docker', 'tags', 'list'], flags: { '--format': true } }];

/** Validate argv against a table; returns the positional args after the verb, or throws like the real CLI. */
function validate(tool: string, table: Array<{ verb: string[]; flags: Record<string, boolean> }>, args: string[]): string[] {
  const entry = table.find((e) => e.verb.every((v, i) => args[i] === v));
  if (!entry) throw new Error(`${tool}: unknown command "${args.join(' ')}"`);
  const positional: string[] = [];
  const rest = args.slice(entry.verb.length);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-')) {
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (!(name in entry.flags)) throw new Error(`${tool}: unknown flag "${name}" for "${entry.verb.join(' ')}"`);
      if (!a.includes('=') && entry.flags[name]) i++;
    } else positional.push(a);
  }
  return positional;
}

interface World {
  image?: string;
  tags?: unknown;
  statusFails?: boolean; // rollout status times out
  failOn?: string; // a verb (joined) that fails
  podEnv?: boolean;
  env?: Record<string, string>;
  statuses?: StatusOutcome[];
  complete?: CompleteOutcome;
}

const deployJson = (image: string) => JSON.stringify({ spec: { template: { spec: { containers: [{ name: 'conductor', image }] } } } });
const tag = (name: string, digest: string) => ({ name: `projects/proj/locations/us-central1/repositories/harmony-workers/packages/harmony-conductor/tags/${name}`, version: `projects/proj/locations/us-central1/repositories/harmony-workers/packages/harmony-conductor/versions/${digest}` });
const regStatus = (over: Partial<RegistryStatus> = {}): StatusOutcome => ({
  kind: 'status',
  status: { is_owner: true, state: 'running', location: 'remote', profile: 'gke', channel: 'staging', plugin_version: '0.15.65', started_at: null, last_heartbeat_at: null, heartbeat_age_seconds: 4, host: 'harmony-conductor-abc', holder_id: 'h1', log_url: null, request: null, events: [], running_legs: [], now: 'n', ...over },
});

function world(o: World = {}) {
  const calls: Call[] = [];
  const completes: Array<Record<string, unknown>> = [];
  let now = T0;
  const statuses = [...(o.statuses ?? [])];
  const exec: LifecycleDeps['exec'] = async (file, args) => {
    calls.push({ file, args });
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const no = (stderr: string): ExecResult => ({ code: 1, stdout: '', stderr });
    if (file === 'kubectl') {
      const pos = validate('kubectl', KUBECTL, args);
      const verb = args[0] === 'rollout' || args[0] === 'set' ? args.slice(0, 2).join(' ') : args[0];
      if (!pos.every((p) => p === 'deployment/harmony-conductor' || p.startsWith('conductor='))) throw new Error(`kubectl: unexpected argument ${pos.join(' ')}`);
      if (o.failOn && verb === o.failOn) return no(`error: ${verb} failed`);
      if (verb === 'get') return ok(deployJson(o.image ?? `${IMAGE}:staging`));
      if (verb === 'rollout status') {
        // the FIRST status (after the patch) may time out; after an undo it settles
        const undone = calls.some((c) => c.args[1] === 'undo');
        return o.statusFails && !undone ? no('error: timed out waiting for the condition') : ok('deployment "harmony-conductor" successfully rolled out');
      }
      return ok();
    }
    if (file === 'gcloud') {
      validate('gcloud', GCLOUD, args);
      if (o.failOn === 'gcloud') return no('ERROR: (gcloud.artifacts) PERMISSION_DENIED');
      return ok(JSON.stringify(o.tags ?? [tag('staging', 'sha256:aaa'), tag('0.15.64', 'sha256:old'), tag('0.15.65', 'sha256:aaa'), tag('0.15.66-rc1', 'sha256:aaa'), tag('0.15.7', 'sha256:aaa'), tag('prod', 'sha256:old')]));
    }
    return { code: 127, stdout: '', stderr: 'not found' };
  };
  const client = {
    status: async () => (statuses.length > 1 ? (statuses.shift() as StatusOutcome) : (statuses[0] ?? { kind: 'unavailable', detail: 'x' })),
    completeRequest: async (_h: string, a: Record<string, unknown>) => {
      completes.push(a);
      return o.complete ?? { kind: 'ok' };
    },
  } as unknown as RegistryClient;
  const files: Record<string, string> = { '/plugin/.claude-plugin/plugin.json': JSON.stringify({ version: '0.15.64' }) };
  const deps: LifecycleDeps = {
    env: {
      HARMONY_API_TOKEN: 'tok',
      HARMONY_HOME: '/home/.harmony',
      ...(o.podEnv === false ? {} : { HARMONY_CONDUCTOR_REMOTE: '1', HARMONY_CONDUCTOR_IMAGE: IMAGE, HARMONY_PLUGIN_POSTURE: 'ack:staging' }),
      ...(o.env ?? {}),
    } as NodeJS.ProcessEnv,
    platform: 'linux', uid: 1000, username: 'worker', home: '/home', cliPluginDir: '/plugin',
    hostname: () => 'pod-old', now: () => now, sleep: async (ms) => { now += ms; },
    exec,
    listProcesses: async () => [], cwdOf: async () => null, signal: () => false,
    spawnDetached: () => { throw new Error('must not spawn'); },
    existsSync: (p) => p in files, readFileSync: (p) => { if (!(p in files)) throw new Error(`ENOENT ${p}`); return files[p]; },
    writeFileSync: () => { throw new Error('must not write'); }, mkdirSync: () => {}, rmSync: () => {},
    readBoard: async () => [], registryClient: async () => client,
  };
  return { deps, calls, completes, kubectl: () => calls.filter((c) => c.file === 'kubectl').map((c) => c.args.join(' ')) };
}

describe('version tag selection', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersionTags('0.15.7', '0.15.65')).toBeLessThan(0);
    expect(compareVersionTags('v1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersionTags('0.16.0', '0.15.99')).toBeGreaterThan(0); // B-1211: a version-floor minor bump outranks the last patch

  });
  it('picks the newest release tag on the SAME image as the channel tag; ignores pre-releases and other images', () => {
    const list = JSON.stringify([tag('staging', 'sha256:aaa'), tag('0.15.64', 'sha256:old'), tag('0.15.65', 'sha256:aaa'), tag('0.15.66-rc1', 'sha256:aaa'), tag('0.15.7', 'sha256:aaa')]);
    expect(newestVersionTag(list, 'staging')).toBe('0.15.65');
  });
  it('never falls back to a moving tag', () => {
    expect(() => newestVersionTag(JSON.stringify([tag('staging', 'sha256:aaa'), tag('latest', 'sha256:aaa')]), 'staging')).toThrow(/no plugin version tag/);
    expect(() => newestVersionTag(JSON.stringify([tag('prod', 'sha256:aaa')]), 'staging')).toThrow(/does not exist/);
    expect(() => newestVersionTag('nope', 'staging')).toThrow(/not valid JSON/);
  });
});

describe('restart --request inside a remote conductor pod', () => {
  it('update: sets a PINNED version tag, waits for the rollout, does NOT pull, signal or complete the request', async () => {
    const w = world();
    const r = await runRestart(w.deps, { request: 'req-1' });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl()).toEqual([
      'get deployment/harmony-conductor -o json -n harmony-conductor',
      `set image deployment/harmony-conductor conductor=${IMAGE}:0.15.65 -n harmony-conductor`,
      'rollout status deployment/harmony-conductor --timeout=300s -n harmony-conductor',
    ]);
    expect(w.calls.some((c) => c.file === 'git')).toBe(false);
    expect(w.calls.find((c) => c.file === 'gcloud')?.args).toEqual(['artifacts', 'docker', 'tags', 'list', IMAGE, '--format=json']);
    expect(w.completes).toEqual([]); // the NEW pod completes it
    expect(r.data).toMatchObject({ remote_kube: true, action: 'update', plugin_version_before: '0.15.64', plugin_version_after: '0.15.65', image: `${IMAGE}:0.15.65` });
    expect(w.kubectl().join('\n')).not.toMatch(/:staging|:latest/);
  });

  it('restart (--no-pull): keeps the current image and runs rollout restart; no gcloud call', async () => {
    const w = world();
    const r = await runRestart(w.deps, { request: 'req-1', noPull: true });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl().some((k) => k.startsWith('rollout restart deployment/harmony-conductor -n harmony-conductor'))).toBe(true);
    expect(w.kubectl().some((k) => k.startsWith('set image'))).toBe(false);
    expect(w.calls.some((c) => c.file === 'gcloud')).toBe(false);
    expect(w.completes).toEqual([]);
  });

  it('a missed rollout deadline: rollout undo, request completed FAILED with the reason, non-zero exit', async () => {
    const w = world({ statusFails: true });
    const r = await runRestart(w.deps, { request: 'req-1' });
    expect(r.exitCode).toBe(1);
    expect(w.kubectl().some((k) => k.startsWith('rollout undo deployment/harmony-conductor -n harmony-conductor'))).toBe(true);
    expect(w.completes).toHaveLength(1);
    expect(w.completes[0]).toMatchObject({ requestId: 'req-1', result: 'failed' });
    expect(String(w.completes[0].reason)).toContain('progress deadline');
    expect(String(w.completes[0].reason)).toContain('rolled back to the previous revision');
    expect(r.data.rolled_back).toBe(true);
  });

  it('already at the latest: nothing to roll out, so the restarter itself completes the request done', async () => {
    const w = world({ image: `${IMAGE}:0.15.65` });
    const r = await runRestart(w.deps, { request: 'req-1' });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl().some((k) => k.startsWith('set image') || k.startsWith('rollout'))).toBe(false);
    expect(w.completes[0]).toMatchObject({ result: 'done' });
    expect(String(w.completes[0].reason)).toContain('already at the channel');
  });

  it('failures before the patch fail the request and leave the Deployment alone', async () => {
    for (const failOn of ['get', 'gcloud']) {
      const w = world({ failOn });
      const r = await runRestart(w.deps, { request: 'req-1' });
      expect(r.exitCode).toBe(1);
      expect(w.completes[0]).toMatchObject({ result: 'failed' });
      expect(w.kubectl().some((k) => k.startsWith('set image') || k.startsWith('rollout'))).toBe(false);
    }
  });

  it('update with no HARMONY_CONDUCTOR_IMAGE or no channel fails clearly instead of guessing a tag', async () => {
    const a = world({ env: { HARMONY_CONDUCTOR_IMAGE: '' } });
    expect((await runRestart(a.deps, { request: 'r' })).errLines.join('\n')).toContain('HARMONY_CONDUCTOR_IMAGE is not set');
    const b = world({ env: { HARMONY_PLUGIN_POSTURE: '' } });
    expect((await runRestart(b.deps, { request: 'r' })).errLines.join('\n')).toContain('cannot tell the update channel');
  });

  it('a failed set image fails the request without rolling anything back', async () => {
    const w = world({ failOn: 'set image' });
    const r = await runRestart(w.deps, { request: 'req-1' });
    expect(r.exitCode).toBe(1);
    expect(w.kubectl().some((k) => k.startsWith('rollout undo'))).toBe(false);
    expect(w.completes[0]).toMatchObject({ result: 'failed' });
  });

  it('dry run changes nothing', async () => {
    const w = world();
    const r = await runRestart(w.deps, { request: 'req-1', dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl()).toEqual(['get deployment/harmony-conductor -o json -n harmony-conductor']);
  });

  it('without HARMONY_CONDUCTOR_REMOTE=1 the request path is the local one (no kubectl)', async () => {
    const w = world({ podEnv: false });
    const r = await runRestart(w.deps, { request: 'req-1' });
    expect(w.calls.filter((c) => c.file === 'kubectl')).toEqual([]);
    expect(r.exitCode).toBe(1); // no local conductor -> the existing "nothing to restart for this request"
  });
});

describe('start --remote / stop --remote (the caller\'s own kubectl credentials)', () => {
  const callerEnv = { HARMONY_GKE_CONTEXT: 'gke_proj_us-east1-b_cl' };
  const remoteWorld = (o: World = {}) => world({ podEnv: false, env: callerEnv, ...o });

  it('start --remote: scales to 1 with the caller\'s context, then waits for location remote + running', async () => {
    const w = remoteWorld({ statuses: [regStatus({ state: 'not_running' }), regStatus({ state: 'not_running' }), regStatus()] });
    const r = await runStart(w.deps, { remote: true });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl()).toEqual(['scale deployment/harmony-conductor --replicas=1 -n harmony-conductor --context gke_proj_us-east1-b_cl']);
    expect(r.lines.join('\n')).toContain('Conductor started in the cluster');
    expect(r.data).toMatchObject({ started: true, remote: true });
  });

  it('start --remote: a local conductor already holds the row -> refuses and scales nothing', async () => {
    const w = remoteWorld({ statuses: [regStatus({ location: 'local', host: 'macmini' })] });
    const r = await runStart(w.deps, { remote: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('already running');
    expect(w.kubectl()).toEqual([]);
  });

  it('start --remote: never confirmed -> exit 4 naming where to look; the Deployment stays scaled to 1', async () => {
    const w = remoteWorld({ statuses: [regStatus({ state: 'not_running' })] });
    const r = await runStart(w.deps, { remote: true });
    expect(r.exitCode).toBe(4);
    expect(r.errLines.join('\n')).toContain('NOT confirmed');
  });

  it('start --remote: registry absent -> refuses before touching the cluster', async () => {
    const w = remoteWorld({ statuses: [] });
    const r = await runStart(w.deps, { remote: true });
    expect(r.exitCode).toBe(1);
    expect(w.kubectl()).toEqual([]);
  });

  it('start --remote: a kubectl failure is reported and nothing is claimed started', async () => {
    const w = remoteWorld({ statuses: [regStatus({ state: 'not_running' })], failOn: 'scale' });
    const r = await runStart(w.deps, { remote: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('kubectl scale failed');
  });

  it('start: --remote is still exclusive with --local and --at-boot', async () => {
    const w = remoteWorld();
    expect((await runStart(w.deps, { remote: true, local: true })).exitCode).toBe(2);
    expect((await runStart(w.deps, { remote: true, atBoot: true })).exitCode).toBe(2);
    expect(w.calls).toEqual([]);
  });

  it('stop --remote: scales to 0, leaves legs, reports the row released', async () => {
    const w = remoteWorld({ statuses: [regStatus(), regStatus({ state: 'not_running' })] });
    const r = await runStop(w.deps, { remote: true });
    expect(r.exitCode).toBe(0);
    expect(w.kubectl()).toEqual(['scale deployment/harmony-conductor --replicas=0 -n harmony-conductor --context gke_proj_us-east1-b_cl']);
    expect(r.lines.join('\n')).toContain('Running legs keep running');
    expect(r.data).toMatchObject({ stopped: true, registry_released: true });
  });

  it('stop --remote without a context uses the current kubectl context (no --context flag)', async () => {
    const w = world({ podEnv: false, statuses: [regStatus({ state: 'not_running' })] });
    await runStop(w.deps, { remote: true });
    expect(w.kubectl()).toEqual(['scale deployment/harmony-conductor --replicas=0 -n harmony-conductor']);
  });

  it('stop --remote: kubectl failure -> exit 1, nothing claimed stopped', async () => {
    const w = remoteWorld({ failOn: 'scale' });
    const r = await runStop(w.deps, { remote: true });
    expect(r.exitCode).toBe(1);
    expect(r.data.stopped).toBe(false);
  });
});

describe('status shows a remote conductor', () => {
  it('names the cluster and the location', async () => {
    const w = world({ podEnv: false, statuses: [regStatus()] });
    const r = await runStatus(w.deps);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('Registry: the conductor is running remotely, in the cluster (a Kubernetes pod)');
    expect(r.lines.join('\n')).toContain('location:        remote');
    expect(r.data.state).toBe('running-elsewhere');
  });
});
