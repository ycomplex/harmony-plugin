// B-1171: the start / stop / restart / status cores against a FAKE machine: a virtual filesystem, a process
// table, a launchctl/systemctl/git/kubectl/gcloud that record every call, a board that follows the process
// table, and a fake clock that sleep() advances. Nothing here runs launchctl, systemctl, git or a signal.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BoardRow } from '../../daemon/conductor-board.js';
import type { ProcessEntry } from '../../daemon/conductor-process.js';
import { LAUNCHD_LABEL, SYSTEMD_UNIT } from '../../daemon/supervisor-control.js';
import type { ExecResult, LifecycleDeps } from './conductor-lifecycle-deps.js';
import type { RegistryClient } from '../../daemon/conductor-registry.js';
import { runRestart, runStart, runStatus, runStop } from './conductor-lifecycle.js';

const repo = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const real = (rel: string) => readFileSync(repo(rel), 'utf8');

const PLUGIN = '/plugin';
const HOME = '/home/op';
const HOST = 'macmini';
const DAEMON_JS = `${PLUGIN}/dist/bin/daemon.js`;
const T0 = Date.parse('2026-10-20T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

interface Call { file: string; args: string[] }

interface Opts {
  platform?: NodeJS.Platform;
  /** launchd targets / systemd state the fake supervisor reports as loaded */
  loaded?: string[];
  systemdState?: 'active' | 'inactive';
  unitInstalled?: boolean;
  /** the running conductor(s): pid -> argv tail */
  procs?: Array<{ pid: number; tail?: string }>;
  held?: Array<[id: string, ticket: string]>;
  profile?: 'gke' | 'cloud';
  /** the project file names no `profile`, and neither does anything else */
  noProfile?: boolean;
  env?: Record<string, string>;
  envFile?: Record<string, string>;
  noToken?: boolean;
  failExec?: (file: string, args: string[]) => ExecResult | undefined;
  noAdopt?: boolean;
  staleAfterAdopt?: boolean;
  ignoreTerm?: boolean;
  gkeJobs?: string;
  cloudExecs?: string;
  pullFails?: boolean;
  lingerOff?: boolean;
  autoLoginOff?: boolean;
  keyMissing?: boolean;
  branch?: string;
  registry?: RegistryClient;
}

/** A registry whose functions are not on the database (the pre-promote state). */
function unavailableRegistry(): RegistryClient {
  const unavailable = async () => ({ kind: 'unavailable' as const, detail: 'function does not exist' });
  return { acquire: unavailable, heartbeat: async () => ({ kind: 'unknown' as const, detail: 'x' }), release: unavailable, claimRequest: unavailable, completeRequest: unavailable, request: unavailable, status: unavailable };
}

function makeWorld(o: Opts = {}) {
  const platform = o.platform ?? 'darwin';
  const vfs = new Map<string, string>();
  const written: Array<{ path: string; text: string; mode: number }> = [];
  const calls: Call[] = [];
  const order: string[] = [];
  const w = { now: T0, nextPid: 9000, procs: [] as ProcessEntry[], loaded: new Set(o.loaded ?? []), systemd: o.systemdState ?? 'inactive', unit: !!o.unitInstalled };
  const profile = o.profile ?? 'gke';

  vfs.set('/cfg/project.json', JSON.stringify({
    version: 1, channel: 'staging', ...(o.noProfile ? {} : { profile }),
    gcp: { project: 'proj', region: 'us-east1' },
    ...(profile === 'gke' ? { gke: { cluster: 'c', location: 'us-east1-b', namespace: 'harmony-legs' } } : { cloud_run: { job: 'crjob' } }),
  }));
  vfs.set(`${HOME}/.harmony/conductor-host.json`, JSON.stringify({
    version: 1, plugin_dir: PLUGIN,
    github_app: { app_id: '1', installation_id: '2', private_key_path: '/keys/app.pem' },
  }));
  if (!o.keyMissing) vfs.set('/keys/app.pem', 'PEM');
  vfs.set(`${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.0' }));
  vfs.set(DAEMON_JS, 'bundle');
  vfs.set(`${PLUGIN}/container/launchd/com.ycomplex.harmony-conductor.plist.template`, real('container/launchd/com.ycomplex.harmony-conductor.plist.template'));
  vfs.set(`${PLUGIN}/container/systemd/harmony-conductor.service.template`, real('container/systemd/harmony-conductor.service.template'));
  if (o.envFile) vfs.set(`${HOME}/.harmony/conductor.env`, 'x');

  const addProc = (pid: number, tail = `--profile ${profile}`) => {
    w.procs.push({ pid, args: `node ${DAEMON_JS} ${tail}`.trim() });
    // the board follows the process table: a NEW process adopts every lease on this host
    if (!o.noAdopt && board.length > 0 && !board.some((b) => b.lease_holder?.startsWith(`${HOST}:${pid}:`)) && w.procs.length > 0) {
      for (const b of board) if (b.lease_holder?.startsWith(`${HOST}:`) && !(o.procs ?? []).some((p) => p.pid === pid)) {
        b.lease_holder = `${HOST}:${pid}:new`;
        b.last_heartbeat_at = iso(o.staleAfterAdopt ? w.now - 3_600_000 : w.now);
      }
    }
  };
  const board: BoardRow[] = (o.held ?? []).map(([id, ticket]) => ({
    id, ticket, status: 'active',
    lease_holder: `${HOST}:${(o.procs ?? [{ pid: 4242 }])[0].pid}:old`,
    last_heartbeat_at: iso(T0 - 10_000),
  }));
  for (const p of o.procs ?? []) w.procs.push({ pid: p.pid, args: `node ${DAEMON_JS} ${p.tail ?? `--profile ${profile}`}`.trim() });

  const env: Record<string, string> = {
    HARMONY_HOME: `${HOME}/.harmony`,
    HARMONY_CONDUCTOR_PROJECT_FILE: '/cfg/project.json',
    PATH: '/opt/homebrew/bin:/usr/bin',
    ...(o.noToken ? {} : { HARMONY_API_TOKEN: 'tok-s3cret' }),
    ...(o.env ?? {}),
  };

  const exec: LifecycleDeps['exec'] = async (file, args) => {
    calls.push({ file, args });
    order.push(`${file} ${args.join(' ')}`);
    const forced = o.failExec?.(file, args);
    if (forced) return forced;
    const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
    const no = (code = 1, stderr = ''): ExecResult => ({ code, stdout: '', stderr });
    const joined = `${file} ${args.join(' ')}`;
    if (file === 'sh') return ok('/usr/bin/tool');
    if (file === 'launchctl' && args[0] === 'print') return w.loaded.has(args[1]) ? ok('state = running') : no(113);
    if (file === 'launchctl' && args[0] === 'bootout') { w.loaded.delete(args[1]); w.procs = []; return ok(); }
    if (file === 'launchctl' && args[0] === 'kickstart') { w.procs = []; addProc(w.nextPid++, ''); return ok(); }
    if (file === 'launchctl' && args[0] === 'bootstrap') { w.loaded.add(`gui/501/${LAUNCHD_LABEL}`); addProc(w.nextPid++, ''); return ok(); }
    if (file === 'sudo' && args[0] === 'launchctl' && args[1] === 'bootstrap') { w.loaded.add(`system/${LAUNCHD_LABEL}`); addProc(w.nextPid++, ''); return ok(); }
    if (file === 'sudo' && args[0] === 'launchctl' && args[1] === 'bootout') { w.loaded.delete(`system/${LAUNCHD_LABEL}`); w.procs = []; return ok(); }
    if (file === 'sudo') return ok();
    if (file === 'systemctl' && args[1] === 'is-active') return { code: w.systemd === 'active' ? 0 : 3, stdout: `${w.systemd}\n`, stderr: '' };
    if (file === 'systemctl' && args[1] === 'stop') { w.systemd = 'inactive'; w.procs = []; return ok(); }
    if (file === 'systemctl' && args[1] === 'restart') { w.systemd = 'active'; w.procs = []; addProc(w.nextPid++, ''); return ok(); }
    if (file === 'systemctl' && args[1] === 'enable') { w.systemd = 'active'; addProc(w.nextPid++, ''); return ok(); }
    if (file === 'systemctl') return ok();
    if (file === 'git' && args.includes('rev-parse')) return ok(`${o.branch ?? 'staging'}\n`);
    if (file === 'git' && args.includes('pull')) {
      if (o.pullFails) return no(1, 'fatal: Not possible to fast-forward, aborting.');
      vfs.set(`${PLUGIN}/.claude-plugin/plugin.json`, JSON.stringify({ version: '1.0.1' }));
      return ok();
    }
    if (file === 'kubectl' && joined.includes('get secret')) return ok();
    if (file === 'kubectl' && joined.includes('get jobs')) return ok(o.gkeJobs ?? '{"items":[]}');
    if (file === 'gcloud' && joined.includes('jobs describe')) return ok('crjob');
    if (file === 'gcloud' && joined.includes('executions list')) return ok(o.cloudExecs ?? '[]');
    if (file === 'bash') return ok(JSON.stringify({ ...env, ...(o.envFile ?? {}) }));
    if (file === 'defaults') return o.autoLoginOff ? no(1) : ok('op');
    if (file === 'loginctl') return ok(o.lingerOff ? 'Linger=no\n' : 'Linger=yes\n');
    return no(127);
  };

  const sleepHooks: Array<() => void> = [];
  const deps: LifecycleDeps = {
    env: env as NodeJS.ProcessEnv,
    platform,
    uid: 501,
    username: 'op',
    home: HOME,
    cliPluginDir: PLUGIN,
    hostname: () => HOST,
    now: () => w.now,
    sleep: async (ms) => { w.now += ms; for (const h of sleepHooks) h(); },
    exec,
    listProcesses: async () => [...w.procs],
    cwdOf: async () => null,
    signal: (pid, sig) => {
      const exists = w.procs.some((p) => p.pid === pid);
      if (sig === 'SIGTERM') {
        order.push(`SIGTERM ${pid}`);
        calls.push({ file: 'kill', args: ['-TERM', String(pid)] });
        if (exists && !o.ignoreTerm) w.procs = w.procs.filter((p) => p.pid !== pid);
      }
      return exists;
    },
    spawnDetached: (file, args) => {
      calls.push({ file, args });
      order.push(`spawn ${file} ${args.join(' ')}`);
      const pid = w.nextPid++;
      // the launcher execs node: the process table shows node with the passthrough args
      const passthrough = args.slice(2).join(' ');
      addProc(pid, passthrough);
      return pid;
    },
    existsSync: (p) => vfs.has(p),
    readFileSync: (p) => {
      const v = vfs.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFileSync: (p, text, mode) => { vfs.set(p, text); written.push({ path: p, text, mode }); },
    mkdirSync: () => {},
    rmSync: (p) => { vfs.delete(p); },
    readBoard: async () => board.map((b) => ({ ...b })),
    registryClient: async () => (o.registry ?? unavailableRegistry()),
  };
  return { deps, calls, order, written, vfs, board, w, addProc };
}

const HELD: Array<[string, string]> = [['c-111', 'B-1001'], ['c-222', 'B-1002']];
const callsOf = (calls: Call[], file: string) => calls.filter((c) => c.file === file);
const signalled = (calls: Call[]) => calls.some((c) => c.file === 'kill');

// ---------------------------------------------------------------------------------------------------

describe('status', () => {
  it('with no conductor here: says so, points at the registry, exits 0', async () => {
    const m = makeWorld();
    const r = await runStatus(m.deps);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toBe('No conductor is running here.');
    expect(r.data.state).toBe('stopped');
  });

  it('after a stop: reports stopped and lists the legs still running (held by the stopped process)', async () => {
    const m = makeWorld({ held: HELD });
    const r = await runStatus(m.deps);
    expect(r.exitCode).toBe(0);
    const text = r.lines.join('\n');
    expect(text).toContain('Conductor stopped; 2 leg(s) still running');
    expect(text).toContain('B-1001  conduction c-111');
    expect(text).toContain('next `harmony conductor start` adopts them');
  });

  it('running: host, pid, profile, plugin version, last heartbeat, legs, supervisor; confirms adoption', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD });
    const r = await runStatus(m.deps);
    const text = r.lines.join('\n');
    expect(text).toContain('Conductor: running');
    expect(text).toContain(`host:            ${HOST}`);
    expect(text).toContain('pid:             4242');
    expect(text).toContain('profile:         gke');
    expect(text).toContain('plugin version:  1.0.0 (channel staging)');
    expect(text).toContain('supervisor:      none (unsupervised)');
    expect(text).toContain('last heartbeat:  2026-10-20T11:59:50.000Z (10s ago)');
    expect(text).toContain('B-1001  conduction c-111  heartbeat 10s ago');
    expect(text).toContain('Adoption: every lease on this host is held by pid 4242 with a fresh heartbeat.');
    expect(r.data.adoption_complete).toBe(true);
    expect(JSON.stringify(r.data)).not.toContain('tok-s3cret');
  });

  it('reports the supervisor kind and flags leases still held by an earlier process', async () => {
    const m = makeWorld({ procs: [{ pid: 5000, tail: '' }], loaded: [`gui/501/${LAUNCHD_LABEL}`], held: HELD });
    for (const b of m.board) b.lease_holder = `${HOST}:4242:old`; // still held by the process this one replaced
    const r = await runStatus(m.deps);
    const text = r.lines.join('\n');
    expect(text).toContain(`launchd-agent (gui/501/${LAUNCHD_LABEL})`);
    expect(text).toContain('NOT YET ADOPTED: 2 lease(s)');
    expect(r.data.adoption_complete).toBe(false);
  });

  it('ignores a daemon of ANOTHER checkout', async () => {
    const m = makeWorld();
    m.w.procs.push({ pid: 77, args: 'node /other/dist/bin/daemon.js --profile gke' });
    expect((await runStatus(m.deps)).data.state).toBe('stopped');
  });
});

describe('stop', () => {
  it('unsupervised: SIGTERM, wait for exit, leaves legs, says the next start adopts them', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD });
    const r = await runStop(m.deps);
    expect(r.exitCode).toBe(0);
    expect(m.calls.filter((c) => c.file === 'kill')).toEqual([{ file: 'kill', args: ['-TERM', '4242'] }]);
    expect(callsOf(m.calls, 'launchctl').filter((c) => c.args[0] !== 'print')).toEqual([]);
    expect(r.lines.join('\n')).toContain('2 leg(s) still running as their own jobs');
    expect(r.lines.join('\n')).toContain('B-1002  conduction c-222');
    expect(r.data.state).toBe('stopped');
  });

  it('launchd agent: bootout (unload, so KeepAlive cannot restart it), no bare kill', async () => {
    const m = makeWorld({ procs: [{ pid: 4242, tail: '' }], loaded: [`gui/501/${LAUNCHD_LABEL}`] });
    const r = await runStop(m.deps);
    expect(r.exitCode).toBe(0);
    expect(callsOf(m.calls, 'launchctl').find((c) => c.args[0] === 'bootout')?.args).toEqual(['bootout', `gui/501/${LAUNCHD_LABEL}`]);
    expect(signalled(m.calls)).toBe(false);
  });

  it('launchd daemon (system domain): sudo launchctl bootout system/<label>', async () => {
    const m = makeWorld({ procs: [{ pid: 4242, tail: '' }], loaded: [`system/${LAUNCHD_LABEL}`] });
    await runStop(m.deps);
    expect(callsOf(m.calls, 'sudo')[0].args).toEqual(['launchctl', 'bootout', `system/${LAUNCHD_LABEL}`]);
  });

  it('systemd user unit: systemctl --user stop', async () => {
    const m = makeWorld({ platform: 'linux', procs: [{ pid: 4242, tail: '' }], systemdState: 'active', unitInstalled: true });
    const r = await runStop(m.deps);
    expect(r.exitCode).toBe(0);
    expect(callsOf(m.calls, 'systemctl').find((c) => c.args[1] === 'stop')?.args).toEqual(['--user', 'stop', SYSTEMD_UNIT]);
  });

  it('nothing running: exits 0 without signalling anything', async () => {
    const m = makeWorld();
    const r = await runStop(m.deps);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toContain('No conductor is running here');
    expect(signalled(m.calls)).toBe(false);
  });

  it('a conductor that ignores SIGTERM: exit 1, says it is still running', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], ignoreTerm: true });
    const r = await runStop(m.deps);
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('did not exit');
  });
});

describe('start', () => {
  it('refuses when a conductor for this project already runs here: names where, starts nothing', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }] });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).not.toBe(0);
    expect(r.errLines.join('\n')).toContain(`host ${HOST}, pid 4242`);
    expect(r.errLines.join('\n')).toContain('already running on this machine');
    expect(m.written).toEqual([]);
    expect(callsOf(m.calls, 'launchctl').filter((c) => c.args[0] === 'bootstrap')).toEqual([]);
  });

  it.each([
    ['--local', { local: true }],
    ['--at-boot', { atBoot: true }],
    ['plain start', {}],
  ])('B-1183: %s with no profile from --profile or the config files refuses before any supervisor job is written', async (_n, o) => {
    const m = makeWorld({ noProfile: true });
    const r = await runStart(m.deps, o);
    expect(r.exitCode).toBe(1);
    const err = r.errLines.join('\n');
    expect(err).toContain('--profile');
    expect(err).toContain('"profile" in .harmony/conductor.json');
    expect(err).toContain('Nothing was started');
    expect(m.written).toEqual([]);
    expect(callsOf(m.calls, 'launchctl')).toEqual([]);
    expect(callsOf(m.calls, 'sudo')).toEqual([]);
    expect(r.data).toMatchObject({ started: false });
  });

  it('B-1183: --profile on the command line is enough when the config files name none', async () => {
    const m = makeWorld({ noProfile: true });
    const r = await runStart(m.deps, { local: true, profile: 'gke' });
    expect(r.errLines.join('\n')).not.toContain('no launch profile');
  });

  it('--remote (B-1173): no registry client token -> refuses before touching the cluster', async () => {
    const m = makeWorld({ noToken: true });
    const r = await runStart(m.deps, { remote: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('Nothing was started');
    expect(m.written).toEqual([]);
    expect(callsOf(m.calls, 'kubectl')).toEqual([]);
  });

  it('--local on macOS: renders the LaunchAgent, bootstraps it into gui/$UID, reports the pid', async () => {
    const m = makeWorld();
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(0);
    const plist = m.written.find((x) => x.path === `${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(plist).toBeDefined();
    expect(plist!.text).toContain(`<string>${PLUGIN}/container/conductor-launch.sh</string>`);
    expect(plist!.text).not.toContain('UserName');
    expect(plist!.text).not.toContain('tok-s3cret');
    expect(callsOf(m.calls, 'launchctl').find((c) => c.args[0] === 'bootstrap')?.args).toEqual(['bootstrap', 'gui/501', `${HOME}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`]);
    expect(r.lines.join('\n')).toContain('Conductor started');
    expect(r.data).toMatchObject({ started: true, supervisor: 'launchd-agent' });
  });

  it('plain `start` behaves as --local', async () => {
    const m = makeWorld();
    expect((await runStart(m.deps, {})).data).toMatchObject({ started: true, supervisor: 'launchd-agent' });
  });

  it('--local on macOS warns when automatic login is off', async () => {
    const m = makeWorld({ autoLoginOff: true });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('WARNING: macOS automatic login is off');
  });

  it('--local on Linux: writes the systemd user unit, daemon-reload, enable --now; warns when lingering is off', async () => {
    const m = makeWorld({ platform: 'linux', lingerOff: true });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(0);
    expect(m.written.find((x) => x.path === `${HOME}/.config/systemd/user/${SYSTEMD_UNIT}`)?.text).toContain('conductor-launch.sh');
    const sc = callsOf(m.calls, 'systemctl').map((c) => c.args.join(' '));
    expect(sc.indexOf('--user daemon-reload')).toBeGreaterThan(-1);
    expect(sc.indexOf(`--user enable --now ${SYSTEMD_UNIT}`)).toBeGreaterThan(sc.indexOf('--user daemon-reload'));
    expect(r.lines.join('\n')).toContain('lingering is off for op');
    expect(r.lines.join('\n')).toContain('loginctl enable-linger');
  });

  it('--at-boot on macOS: a LaunchDaemon with UserName, installed root-owned through sudo, bootstrapped into the system domain', async () => {
    const m = makeWorld();
    const r = await runStart(m.deps, { atBoot: true });
    expect(r.exitCode).toBe(0);
    const staged = m.written.find((x) => x.path.endsWith('conductor-launchd.plist.staged'));
    expect(staged?.text).toContain('<key>UserName</key>\n    <string>op</string>');
    expect(staged?.text).toContain(`<key>HOME</key>\n        <string>${HOME}</string>`);
    const sudo = callsOf(m.calls, 'sudo').map((c) => c.args);
    expect(sudo[0].slice(0, 6)).toEqual(['install', '-m', '644', '-o', 'root', '-g']);
    expect(sudo[1]).toEqual(['launchctl', 'bootstrap', 'system', `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`]);
    expect(r.data.supervisor).toBe('launchd-daemon');
    expect(m.vfs.has(staged!.path)).toBe(false); // the staging copy is removed
  });

  it('--at-boot off macOS is a usage error', async () => {
    const m = makeWorld({ platform: 'linux' });
    const r = await runStart(m.deps, { atBoot: true });
    expect(r.exitCode).toBe(2);
    expect(m.written).toEqual([]);
  });

  it('--local with --remote is a usage error', async () => {
    expect((await runStart(makeWorld().deps, { local: true, atBoot: true })).exitCode).toBe(2);
  });

  it('a failed pre-flight check exits non-zero NAMING it and installs nothing', async () => {
    const m = makeWorld({ noToken: true });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('cred:HARMONY_API_TOKEN');
    expect(m.written).toEqual([]);
    expect(callsOf(m.calls, 'launchctl').filter((c) => c.args[0] === 'bootstrap')).toEqual([]);
  });

  it('a supervisor job already loaded with no process behind it: refuses and points at restart', async () => {
    const m = makeWorld({ loaded: [`gui/501/${LAUNCHD_LABEL}`] });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('harmony conductor restart');
    expect(m.written).toEqual([]);
  });
});

describe('pre-flight (shared by start and restart)', () => {
  const failed = (r: { errLines: string[] }) => r.errLines.join('\n');

  it('a gke profile needs kubectl and the base Secret; a cloud profile needs gcloud and the Cloud Run job', async () => {
    const gke = makeWorld({ profile: 'gke' });
    await runStart(gke.deps, { local: true });
    expect(gke.calls.filter((c) => c.file === 'sh').map((c) => c.args[3])).toEqual(['git', 'node', 'kubectl']);
    expect(callsOf(gke.calls, 'kubectl')[0].args).toEqual(['-n', 'harmony-legs', '--context', 'gke_proj_us-east1-b_c', 'get', 'secret', 'harmony-worker-secrets']);
    const cloud = makeWorld({ profile: 'cloud', env: { HARMONY_CLOUD_RUN_REGION: 'us-east1' } });
    await runStart(cloud.deps, { local: true });
    expect(cloud.calls.filter((c) => c.file === 'sh').map((c) => c.args[3])).toEqual(['git', 'node', 'gcloud']);
    expect(callsOf(cloud.calls, 'gcloud')[0].args.slice(0, 4)).toEqual(['run', 'jobs', 'describe', 'crjob']);
  });

  it('a missing tool fails the named check', async () => {
    const m = makeWorld({ failExec: (f, a) => (f === 'sh' && a[3] === 'kubectl' ? { code: 1, stdout: '', stderr: '' } : undefined) });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(1);
    expect(failed(r)).toContain('tool:kubectl');
  });

  it('an unreachable base Secret fails reach:gke-base-secret', async () => {
    const m = makeWorld({ failExec: (f) => (f === 'kubectl' ? { code: 1, stdout: '', stderr: 'Unable to connect' } : undefined) });
    expect(failed(await runStart(m.deps, { local: true }))).toContain('reach:gke-base-secret');
  });

  it('an unreadable GitHub App key fails cred:github-app-key, by NAME', async () => {
    const m = makeWorld({ keyMissing: true });
    const r = await runStart(m.deps, { local: true });
    expect(failed(r)).toContain('cred:github-app-key');
    expect(m.written).toEqual([]);
  });

  it('an unreadable board fails cred:board', async () => {
    const m = makeWorld();
    m.deps.readBoard = async () => { throw new Error('boom'); };
    expect(failed(await runStart(m.deps, { local: true }))).toContain('cred:board');
  });

  it('a conductor env file is sourced through a real shell, its values never appear in the output', async () => {
    const m = makeWorld({ noToken: true, envFile: { HARMONY_API_TOKEN: 'tok-from-file-s3cret' } });
    const r = await runStart(m.deps, { local: true });
    expect(r.exitCode).toBe(0);
    expect(callsOf(m.calls, 'bash')).toHaveLength(1);
    expect(r.lines.join('\n') + JSON.stringify(r.data) + m.written.map((x) => x.text).join('')).not.toContain('tok-from-file-s3cret');
  });
});

describe('restart', () => {
  it('unsupervised: pre-flight, then pull the channel, THEN SIGTERM, relaunch under nohup, confirm adoption from the board', async () => {
    const m = makeWorld({ procs: [{ pid: 4242, tail: '--config /x/deployment.json --profile gke' }], held: HELD });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(0);
    const pull = m.order.findIndex((x) => x.startsWith('git') && x.includes('pull'));
    const term = m.order.indexOf('SIGTERM 4242');
    const spawn = m.order.findIndex((x) => x.startsWith('spawn nohup'));
    expect(pull).toBeGreaterThan(-1);
    expect(pull).toBeLessThan(term);
    expect(term).toBeLessThan(spawn);
    expect(m.order[pull]).toBe(`git -C ${PLUGIN} pull --ff-only origin staging`);
    // the launcher gets the old process's own --config/--profile
    expect(m.order[spawn]).toBe(`spawn nohup bash ${PLUGIN}/container/conductor-launch.sh --config /x/deployment.json --profile gke`);
    const text = r.lines.join('\n');
    expect(text).toContain('plugin 1.0.0 -> 1.0.1');
    expect(text).toContain('adopted: B-1001  conduction c-111');
    expect(text).toContain('adopted: B-1002  conduction c-222');
    expect(r.data).toMatchObject({ restarted: true, plugin_version_before: '1.0.0', plugin_version_after: '1.0.1' });
  });

  it('pre-flight runs BEFORE any signal: a failed check exits 1 naming it and touches nothing', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, failExec: (f) => (f === 'kubectl' ? { code: 1, stdout: '', stderr: '' } : undefined) });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('reach:gke-base-secret');
    expect(r.errLines.join('\n')).toContain('left untouched');
    expect(signalled(m.calls)).toBe(false);
    expect(m.order.some((x) => x.includes('pull'))).toBe(false);
    expect(m.w.procs.map((p) => p.pid)).toEqual([4242]);
  });

  it('refuses a checkout that is not on the configured channel branch, before any signal', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], branch: 'main' });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('channel-branch');
    expect(signalled(m.calls)).toBe(false);
  });

  it('a pull that is not a fast-forward exits 1 and leaves the running conductor alone', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, pullFails: true });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('--ff-only');
    expect(signalled(m.calls)).toBe(false);
  });

  it('exit 4 when the new conductor never takes the leases (names them)', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, noAdopt: true });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(4);
    expect(r.errLines.join('\n')).toContain('adoption NOT confirmed');
    expect(r.errLines.join('\n')).toContain('B-1001  conduction c-111');
    expect(r.errLines.join('\n')).toContain('lease holder is');
  });

  it('exit 4 when the lease is adopted but the heartbeat is stale', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, staleAfterAdopt: true });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(4);
    expect(r.errLines.join('\n')).toContain('not fresh');
  });

  it('a conductor that ignores SIGTERM: exit 1 and no new one is started', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, ignoreTerm: true });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('did not exit');
    expect(m.order.some((x) => x.startsWith('spawn'))).toBe(false);
  });

  it('launchd agent: kickstart -k, after the pull; finds the new pid and confirms adoption', async () => {
    const m = makeWorld({ procs: [{ pid: 4242, tail: '' }], loaded: [`gui/501/${LAUNCHD_LABEL}`], held: HELD });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(0);
    const pull = m.order.findIndex((x) => x.includes('pull'));
    const kick = m.order.findIndex((x) => x.startsWith('launchctl kickstart'));
    expect(m.order[kick]).toBe(`launchctl kickstart -k gui/501/${LAUNCHD_LABEL}`);
    expect(pull).toBeLessThan(kick);
    expect(signalled(m.calls)).toBe(false);
    expect(r.data.new_pid).not.toBe(4242);
  });

  it('systemd user unit: systemctl --user restart', async () => {
    const m = makeWorld({ platform: 'linux', procs: [{ pid: 4242, tail: '' }], systemdState: 'active', unitInstalled: true, held: HELD });
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(0);
    expect(m.order).toContain(`systemctl --user restart ${SYSTEMD_UNIT}`);
  });

  it('a supervised conductor cannot be pointed at another profile with --profile (the config files decide)', async () => {
    const m = makeWorld({ procs: [{ pid: 4242, tail: '' }], loaded: [`gui/501/${LAUNCHD_LABEL}`] });
    const r = await runRestart(m.deps, { profile: 'cloud' });
    expect(r.exitCode).toBe(2);
    expect(m.order.some((x) => x.includes('kickstart'))).toBe(false);
  });

  it('nothing running and no supervisor: exit 1 pointing at start', async () => {
    const r = await runRestart(makeWorld().deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('harmony conductor start');
  });

  describe('profile-changing restart: the in-flight guard (ported from switch-daemon-profile.sh)', () => {
    const GKE_JOBS = JSON.stringify({
      items: [
        { metadata: { labels: { 'harmony-ticket': 'B-1001', 'conduction-id': 'c-111' } }, status: {} },
        { metadata: { labels: { 'harmony-ticket': 'B-9', 'conduction-id': 'c-9' } }, status: { conditions: [{ type: 'Complete', status: 'True' }] } },
      ],
    });
    const CLOUD_EXECS = JSON.stringify([
      { metadata: { name: 'exec-1', labels: { 'conduction-id': 'c-222' } }, status: {} },
      { metadata: { name: 'exec-old', labels: { 'conduction-id': 'c-7' } }, status: { completionTime: '2026-10-19T00:00:00Z' } },
    ]);
    const cloudEnv = { HARMONY_CLOUD_RUN_JOB: 'crjob', HARMONY_CLOUD_RUN_REGION: 'us-east1' };

    it('cloud -> gke with a leg still running on cloud: exit 3, names ticket and conduction, nothing touched', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '--profile cloud' }], held: HELD, env: cloudEnv, cloudExecs: CLOUD_EXECS });
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(3);
      expect(r.errLines.join('\n')).toContain('REFUSING');
      expect(r.errLines.join('\n')).toContain('B-1002  conduction c-222');
      expect(r.errLines.join('\n')).not.toContain('c-7');
      expect(signalled(m.calls)).toBe(false);
      expect(m.order.some((x) => x.includes('pull'))).toBe(false);
    });

    it('gke -> cloud with a Job running on gke: exit 3', async () => {
      const m = makeWorld({ profile: 'cloud', procs: [{ pid: 4242, tail: '--profile gke' }], held: HELD, gkeJobs: GKE_JOBS, env: { HARMONY_GKE_NAMESPACE: 'harmony-legs' } });
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(3);
      expect(r.errLines.join('\n')).toContain('B-1001  conduction c-111');
      expect(r.errLines.join('\n')).not.toContain('c-9');
      expect(signalled(m.calls)).toBe(false);
    });

    it('no gcp.project configured: nothing is listed or signalled against an invented project', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '--profile cloud' }], held: HELD, env: cloudEnv, cloudExecs: CLOUD_EXECS });
      m.vfs.set('/cfg/project.json', JSON.stringify({ version: 1, channel: 'staging', profile: 'gke', gke: { cluster: 'c', location: 'us-east1-b' } }));
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(1);
      expect(callsOf(m.calls, 'gcloud').some((c) => c.args.some((a) => a.startsWith('--project=')))).toBe(false);
      expect(signalled(m.calls)).toBe(false);
    });

    it('--force proceeds past the guard with a warning', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '--profile cloud' }], held: HELD, env: cloudEnv, cloudExecs: CLOUD_EXECS });
      const r = await runRestart(m.deps, { force: true });
      expect(r.exitCode).toBe(0);
      expect(r.lines.join('\n')).toContain('--force');
      expect(signalled(m.calls)).toBe(true);
    });

    it('the same profile as the running one: no guard at all', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '--profile gke' }], held: HELD, env: cloudEnv, cloudExecs: CLOUD_EXECS });
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(0);
      expect(callsOf(m.calls, 'gcloud').some((c) => c.args.includes('executions'))).toBe(false);
    });

    it('cannot tell (the listing fails): does not proceed', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '--profile cloud' }], held: HELD, env: cloudEnv, cloudExecs: 'not json' });
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(1);
      expect(signalled(m.calls)).toBe(false);
    });

    it('the other backend is not used from this machine (no tool/vars) and the profile did not visibly change: guard is skipped', async () => {
      const m = makeWorld({ procs: [{ pid: 4242, tail: '' }], held: HELD });
      const r = await runRestart(m.deps, {});
      expect(r.exitCode).toBe(0);
      expect(r.lines.join('\n')).toContain('skipped');
    });
  });

  it('--dry-run runs pre-flight and the guard, prints the plan, signals and pulls nothing', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD });
    const r = await runRestart(m.deps, { dryRun: true });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('Dry run: nothing changed');
    expect(r.lines.join('\n')).toContain('git -C /plugin pull --ff-only origin staging');
    expect(signalled(m.calls)).toBe(false);
    expect(m.order.some((x) => x.includes('pull'))).toBe(false);
  });
});

describe('the Mac mini adoption sequence (nohup conductor -> launchd)', () => {
  it('stop, start --local, status: every lease ends up held by the new process with a fresh heartbeat', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD });
    const stop = await runStop(m.deps);
    expect(stop.exitCode).toBe(0);
    expect(m.w.procs).toEqual([]);
    const start = await runStart(m.deps, { local: true });
    expect(start.exitCode).toBe(0);
    const status = await runStatus(m.deps);
    expect(status.exitCode).toBe(0);
    const text = status.lines.join('\n');
    expect(text).toContain('supervisor:      launchd-agent');
    expect(text).toMatch(/Adoption: every lease on this host is held by pid 900\d with a fresh heartbeat\./);
    expect(status.data.adoption_complete).toBe(true);
    expect(status.data.legs).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------------
// B-1172: the registry — remote status/restart (no conductor here), --no-pull, --request
// ---------------------------------------------------------------------------------------------------

import type { CompleteOutcome, RegistryStatus, RequestOutcome, StatusOutcome } from '../../daemon/conductor-registry.js';
import { REMOTE_RESTART_BUDGET_MS, REMOTE_RESTART_POLL_MS } from './conductor-lifecycle.js';

const regStatus = (over: Partial<RegistryStatus> = {}): StatusOutcome => ({
  kind: 'status',
  status: {
    is_owner: true, state: 'running', location: 'local', profile: 'gke', channel: 'staging', plugin_version: '1.0.0',
    started_at: '2026-10-20T10:00:00Z', last_heartbeat_at: '2026-10-20T11:59:50Z', heartbeat_age_seconds: 10,
    host: 'macmini', holder_id: 'macmini:1:old', log_url: null, request: null, events: [], running_legs: [], now: 'n', ...over,
  },
});

function fakeRegistry(o: { statuses?: StatusOutcome[]; request?: RequestOutcome; complete?: CompleteOutcome } = {}) {
  const statuses = [...(o.statuses ?? [])];
  const requests: string[] = [];
  const completes: Array<Record<string, unknown>> = [];
  let statusCalls = 0;
  const client = {
    status: async () => {
      statusCalls += 1;
      return statuses.length > 1 ? (statuses.shift() as StatusOutcome) : (statuses[0] ?? { kind: 'unavailable', detail: 'x' });
    },
    request: async (action: string) => {
      requests.push(action);
      return o.request ?? { kind: 'queued', requestId: 'req-1', action };
    },
    completeRequest: async (_h: string, a: Record<string, unknown>) => {
      completes.push(a);
      return o.complete ?? { kind: 'ok' };
    },
  } as unknown as RegistryClient;
  return { client, requests, completes, statusCalls: () => statusCalls };
}

describe('status with no local conductor (registry)', () => {
  it('prints the registered conductor elsewhere; host as returned', async () => {
    const reg = fakeRegistry({ statuses: [regStatus()] });
    const m = makeWorld({ registry: reg.client });
    const r = await runStatus(m.deps);
    const text = r.lines.join('\n');
    expect(r.exitCode).toBe(0);
    expect(text).toContain('Registry: a conductor is running elsewhere');
    expect(text).toContain('host:            macmini');
    expect(text).toContain('plugin version:  1.0.0 (channel staging)');
    expect(text).toContain('last heartbeat:  2026-10-20T11:59:50Z (10s ago)');
    expect(r.data.state).toBe('running-elsewhere');
  });

  it('a non-owner sees the host redacted (null from the registry)', async () => {
    const reg = fakeRegistry({ statuses: [regStatus({ is_owner: false, host: null, holder_id: null })] });
    const r = await runStatus(makeWorld({ registry: reg.client }).deps);
    expect(r.lines.join('\n')).toContain('(hidden: only the project owner sees the host)');
  });

  it('a stale row is flagged; not_running says so', async () => {
    const stale = await runStatus(makeWorld({ registry: fakeRegistry({ statuses: [regStatus({ state: 'stale', heartbeat_age_seconds: 900 })] }).client }).deps);
    expect(stale.lines.join('\n')).toContain('heartbeat is STALE');
    expect(stale.data.state).toBe('stale-elsewhere');
    const none = await runStatus(makeWorld({ registry: fakeRegistry({ statuses: [regStatus({ state: 'not_running' })] }).client }).deps);
    expect(none.lines.join('\n')).toContain('no conductor is registered for this project');
    expect(none.data.state).toBe('stopped');
  });

  it('registry not deployed: says so, still exits 0', async () => {
    const r = await runStatus(makeWorld().deps);
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('registry not deployed on this project');
  });

  it('with a LOCAL conductor the registry is not consulted', async () => {
    const reg = fakeRegistry({ statuses: [regStatus()] });
    await runStatus(makeWorld({ procs: [{ pid: 4242 }], held: HELD, registry: reg.client }).deps);
    expect(reg.statusCalls()).toBe(0);
  });
});

describe('restart with no local conductor (registry)', () => {
  const NEW = { holder_id: 'macmini:2:new' };
  const done = (over: Partial<RegistryStatus> = {}) => regStatus({ request: { id: 'req-1', action: 'update', state: 'done', reason: null, requested_by: 'u', requested_at: 't' }, ...NEW, ...over });
  const pending = regStatus({ request: { id: 'req-1', action: 'update', state: 'claimed', reason: null, requested_by: 'u', requested_at: 't' } });

  it("queues an 'update', polls every 2s and exits 0 once the request is done and a NEW holder heartbeats", async () => {
    const reg = fakeRegistry({ statuses: [regStatus(), pending, pending, done()] });
    const m = makeWorld({ registry: reg.client });
    const t0 = m.w.now;
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(0);
    expect(reg.requests).toEqual(['update']);
    expect(r.data.restarted).toBe(true);
    expect(r.data.new_holder_id).toBe('macmini:2:new');
    expect(m.w.now - t0).toBe(2 * REMOTE_RESTART_POLL_MS + 0); // three polls: pending, pending, done
    expect(signalled(m.calls)).toBe(false);
  });

  it("--no-pull maps to the 'restart' action", async () => {
    const reg = fakeRegistry({ statuses: [regStatus(), done()] });
    await runRestart(makeWorld({ registry: reg.client }).deps, { noPull: true });
    expect(reg.requests).toEqual(['restart']);
  });

  it('done but the SAME holder is still registered: not yet adopted, so it keeps waiting then exits 4 at the 90s budget', async () => {
    const reg = fakeRegistry({ statuses: [regStatus(), regStatus({ request: { id: 'req-1', action: 'update', state: 'done', reason: null, requested_by: 'u', requested_at: 't' } })] });
    const m = makeWorld({ registry: reg.client });
    const t0 = m.w.now;
    const r = await runRestart(m.deps, {});
    expect(r.exitCode).toBe(4);
    expect(m.w.now - t0).toBeGreaterThanOrEqual(REMOTE_RESTART_BUDGET_MS);
    expect(r.errLines.join('\n')).toContain('NOT confirmed within 90s');
  });

  it('a request that never leaves pending: exit 4', async () => {
    const reg = fakeRegistry({ statuses: [regStatus(), pending] });
    expect((await runRestart(makeWorld({ registry: reg.client }).deps, {})).exitCode).toBe(4);
  });

  it('a failed request: exit 1 with the reason', async () => {
    const failed = regStatus({ request: { id: 'req-1', action: 'update', state: 'failed', reason: 'git pull --ff-only failed', requested_by: 'u', requested_at: 't' } });
    const r = await runRestart(makeWorld({ registry: fakeRegistry({ statuses: [regStatus(), failed] }).client }).deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('git pull --ff-only failed');
  });

  it('refused: no live conductor -> exit 1 with the message', async () => {
    const reg = fakeRegistry({ statuses: [regStatus({ state: 'not_running' })], request: { kind: 'refused', reason: 'no_live_conductor', message: 'no live conductor is registered for this project', pending: null } });
    const r = await runRestart(makeWorld({ registry: reg.client }).deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('no live conductor is registered for this project');
  });

  it('refused: request pending names who and when', async () => {
    const reg = fakeRegistry({
      statuses: [regStatus()],
      request: { kind: 'refused', reason: 'request_pending', message: 'a request is already pending', pending: { id: 'r0', action: 'update', state: 'pending', requested_by: 'u9', requested_by_name: 'Ada', requested_at: '2026-10-20T11:58:00Z' } },
    });
    const r = await runRestart(makeWorld({ registry: reg.client }).deps, {});
    expect(r.exitCode).toBe(1);
    const err = r.errLines.join('\n');
    expect(err).toContain('already pending');
    expect(err).toContain('Ada');
    expect(err).toContain('2026-10-20T11:58:00Z');
  });

  it('registry not deployed: exit 1 with a clear message, nothing requested', async () => {
    const r = await runRestart(makeWorld().deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('registry not deployed on this project');
  });

  it('a non-owner is told only the owner may request', async () => {
    const reg = fakeRegistry({ statuses: [regStatus()], request: { kind: 'forbidden', detail: '42501: only the project owner' } });
    const r = await runRestart(makeWorld({ registry: reg.client }).deps, {});
    expect(r.exitCode).toBe(1);
    expect(r.errLines.join('\n')).toContain('only the project owner');
  });
});

describe('local restart: --no-pull and --request', () => {
  it('--no-pull restarts without any git pull and keeps the version', async () => {
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD });
    const r = await runRestart(m.deps, { noPull: true });
    expect(r.exitCode).toBe(0);
    expect(m.order.some((x) => x.includes('pull'))).toBe(false);
    expect(r.data.plugin_version_before).toBe('1.0.0');
    expect(r.data.plugin_version_after).toBe('1.0.0');
    expect(signalled(m.calls)).toBe(true);
  });

  it('--request: after adoption the request is completed DONE with the version pair', async () => {
    const reg = fakeRegistry();
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, registry: reg.client });
    const r = await runRestart(m.deps, { request: 'req-9' });
    expect(r.exitCode).toBe(0);
    expect(reg.completes).toEqual([{ requestId: 'req-9', result: 'done', reason: null, versionBefore: '1.0.0', versionAfter: '1.0.1' }]);
    expect(r.lines.join('\n')).toContain('Registry request req-9 completed as done');
  });

  it('--request with --no-pull completes done without a version change', async () => {
    const reg = fakeRegistry();
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, registry: reg.client });
    await runRestart(m.deps, { request: 'req-9', noPull: true });
    expect(reg.completes[0]).toMatchObject({ result: 'done', versionBefore: '1.0.0', versionAfter: '1.0.0' });
  });

  it('--request, pull fails: the OLD conductor stays running (never signalled) and the request is completed FAILED with the reason', async () => {
    const reg = fakeRegistry();
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, pullFails: true, registry: reg.client });
    const r = await runRestart(m.deps, { request: 'req-9' });
    expect(r.exitCode).toBe(1);
    expect(signalled(m.calls)).toBe(false);
    expect(m.w.procs.map((p) => p.pid)).toEqual([4242]);
    expect(reg.completes).toHaveLength(1);
    expect(reg.completes[0]).toMatchObject({ requestId: 'req-9', result: 'failed' });
    expect(String(reg.completes[0].reason)).toContain('git pull --ff-only origin staging failed');
    expect(String(reg.completes[0].reason)).toContain('left untouched');
  });

  it('--request, adoption not confirmed (exit 4): completed FAILED', async () => {
    const reg = fakeRegistry();
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, noAdopt: true, registry: reg.client });
    const r = await runRestart(m.deps, { request: 'req-9' });
    expect(r.exitCode).toBe(4);
    expect(reg.completes[0]).toMatchObject({ result: 'failed' });
  });

  it('--request with no conductor here never recurses into the remote path', async () => {
    const reg = fakeRegistry();
    const r = await runRestart(makeWorld({ registry: reg.client }).deps, { request: 'req-9' });
    expect(r.exitCode).toBe(1);
    expect(reg.requests).toEqual([]);
    expect(reg.completes[0]).toMatchObject({ result: 'failed' });
  });

  it('a registry that cannot be reached at completion does not change the restart result', async () => {
    const reg = fakeRegistry({ complete: { kind: 'unknown', detail: 'fetch failed' } });
    const m = makeWorld({ procs: [{ pid: 4242 }], held: HELD, registry: reg.client });
    const r = await runRestart(m.deps, { request: 'req-9' });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join('\n')).toContain('unknown (fetch failed)');
  });
});

// ---------------------------------------------------------------------------------------------------
// B-1173 acceptance: no conductor.env / daemon.env of secret values
// ---------------------------------------------------------------------------------------------------

import { loadSettings, runPreflight } from './conductor-preflight.js';

describe('pre-flight with secrets resolved from Secret Manager (no env file)', () => {
  const secretsHost = {
    version: 1, plugin_dir: PLUGIN, gcp: { project: 'proj' },
    github_app: { app_id: '1', installation_id: '2' },
    secrets: { api_token: 'harmony-api-token', github_app_private_key: 'harmony-app-key' },
  };
  const gcloudSecrets = (file: string, args: string[]): ExecResult | undefined =>
    file === 'gcloud' && args[0] === 'secrets' && args[1] === 'versions' && args[2] === 'access' && args[3] === 'latest' && args.slice(4).every((a) => a.startsWith('--secret=') || a.startsWith('--project='))
      ? { code: 0, stdout: `value-of-${args[4]}\n`, stderr: '' }
      : undefined;

  it('with no env file and no token in the shell, the token and App key come from the named secrets', async () => {
    const m = makeWorld({ noToken: true, failExec: gcloudSecrets });
    m.vfs.set(`${HOME}/.harmony/conductor-host.json`, JSON.stringify(secretsHost));
    expect(m.vfs.has(`${HOME}/.harmony/conductor.env`) || m.vfs.has(`${HOME}/.harmony/daemon.env`)).toBe(false);
    const s = await loadSettings(m.deps, {});
    expect(s.secretsError).toBeUndefined();
    expect(s.envFile).toBeNull();
    expect(s.env.HARMONY_API_TOKEN).toBe('value-of---secret=harmony-api-token');
    const pre = await runPreflight(m.deps, s, {});
    const byName = Object.fromEntries(pre.checks.map((c) => [c.name, c]));
    expect(byName['cred:HARMONY_API_TOKEN'].ok).toBe(true);
    expect(byName['cred:github-app-key'].ok).toBe(true);
    expect(JSON.stringify(pre.checks)).not.toContain('value-of');
  });

  it('an env token already set wins: only the key secret is fetched', async () => {
    const m = makeWorld({ failExec: gcloudSecrets });
    m.vfs.set(`${HOME}/.harmony/conductor-host.json`, JSON.stringify(secretsHost));
    const s = await loadSettings(m.deps, {});
    expect(s.env.HARMONY_API_TOKEN).toBe('tok-s3cret');
    expect(m.calls.filter((c) => c.file === 'gcloud').map((c) => c.args[4])).toEqual(['--secret=harmony-app-key']);
  });

  it('a host file without the names is unchanged: no gcloud call', async () => {
    const m = makeWorld({ noToken: true, failExec: gcloudSecrets });
    const s = await loadSettings(m.deps, {});
    expect(m.calls.filter((c) => c.file === 'gcloud')).toEqual([]);
    expect(s.secretsError).toBeUndefined();
    expect(s.env.HARMONY_API_TOKEN).toBeUndefined();
  });

  it('a failing secret read fails the pre-flight naming only the secret name', async () => {
    const m = makeWorld({ noToken: true, failExec: (f) => (f === 'gcloud' ? { code: 1, stdout: '', stderr: 'boom' } : undefined) });
    m.vfs.set(`${HOME}/.harmony/conductor-host.json`, JSON.stringify(secretsHost));
    const s = await loadSettings(m.deps, {});
    const pre = await runPreflight(m.deps, s, {});
    const c = pre.checks.find((x) => x.name === 'secrets')!;
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('"harmony-api-token"');
    expect(c.detail).not.toContain('boom');
  });
});

describe('pre-flight cloud reach check: gcp.project (B-1186)', () => {
  const cloudEnv = { HARMONY_CLOUD_RUN_JOB: 'crjob', HARMONY_CLOUD_RUN_REGION: 'us-east1' };
  it('uses the nested gcp.project, never an invented one', async () => {
    const m = makeWorld({ profile: 'cloud', env: cloudEnv });
    const s = await loadSettings(m.deps, {});
    await runPreflight(m.deps, s, {});
    const describeCall = m.calls.find((c) => c.file === 'gcloud' && c.args[0] === 'run' && c.args[1] === 'jobs' && c.args[2] === 'describe')!;
    expect(describeCall.args).toContain('--project=proj');
  });

  it('with no project it fails the check naming where to set it, and calls no gcloud', async () => {
    const m = makeWorld({ profile: 'cloud', env: cloudEnv });
    m.vfs.set('/cfg/project.json', JSON.stringify({ version: 1, channel: 'staging', profile: 'cloud', cloud_run: { job: 'crjob' } }));
    const s = await loadSettings(m.deps, {});
    const pre = await runPreflight(m.deps, s, {});
    const c = pre.checks.find((x) => x.name === 'reach:cloud-run-job')!;
    expect(c.ok).toBe(false);
    expect(JSON.stringify(c)).toContain('gcp.project');
    expect(m.calls.some((x) => x.file === 'gcloud' && x.args.some((a) => a.startsWith('--project=')))).toBe(false);
  });
});
