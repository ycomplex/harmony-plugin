// B-1171: `harmony conductor start | stop | restart | status`.
//
// SEMANTICS, written once (docs/conductor-lifecycle.md is the reference; this comment is its short form):
//
//   stop     = no new launches. Running legs keep running as their own jobs (Cloud Run executions / k8s Jobs);
//              the next start adopts them. The supervisor is kept from restarting the conductor.
//   restart  = stop, then start, then adopt: confirmed FROM THE BOARD (every conduction the old process held
//              is leased by the new one with a fresh heartbeat).
//   update   = restart onto the channel's latest version: pull the configured channel (fast-forward only),
//              then restart. Every restart path does this first.
//
// "Conductor" is the user-facing name of the long-running process (internally src/bin/daemon.ts, bundled as
// dist/bin/daemon.js); internal paths and names keep "daemon".
//
// PURE CORE + THIN WRAPPER (the conductor-config.ts convention): runStart / runStop / runRestart / runStatus
// take every side effect through `LifecycleDeps` and RETURN {exitCode, lines, errLines, data}; only
// `registerConductorLifecycleCommands` touches console/process. Exit codes of restart match
// container/gke/switch-daemon-profile.sh: 0 ok / 1 failure / 2 usage / 3 leg in flight on another backend /
// 4 adoption not confirmed.

import { dirname, join } from 'node:path';
import { Command } from 'commander';
import {
  adoptionState,
  classifyLeases,
  heldBy,
  holderPrefix,
  type BoardRow,
} from '../../daemon/conductor-board.js';
import { matchConductors, needsCwd, type ConductorProcess } from '../../daemon/conductor-process.js';
import {
  agentPlistPath,
  daemonPlistPath,
  detectSupervisorState,
  installCommands,
  launcherPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  restartCommands,
  stopCommands,
  systemdUnitPath,
  type SupervisorCommand,
  type SupervisorState,
} from '../../daemon/supervisor-control.js';
import { formatOutput } from '../formatter.js';
import type { CliResult } from './conductor-config.js';
import { defaultLifecycleDeps, type LifecycleDeps } from './conductor-lifecycle-deps.js';
import {
  failedNames,
  formatChecks,
  loadSettings,
  runPreflight,
  type ConductorSettings,
  type Env,
} from './conductor-preflight.js';

export const EXIT = { ok: 0, failure: 1, usage: 2, inFlight: 3, notAdopted: 4 } as const;

const LAUNCHD_TEMPLATE = 'container/launchd/com.ycomplex.harmony-conductor.plist.template';
const SYSTEMD_TEMPLATE = 'container/systemd/harmony-conductor.service.template';

// ---------------------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------------------

/** Collects output; `onLine` streams it as it happens (a restart takes minutes). */
class Out {
  readonly lines: string[] = [];
  readonly errLines: string[] = [];
  constructor(private readonly onLine?: (line: string) => void) {}
  line(s = ''): void {
    this.lines.push(s);
    this.onLine?.(s);
  }
  err(s: string): void {
    this.errLines.push(s);
  }
  result(exitCode: number, data: Record<string, unknown>): CliResult {
    return { exitCode, lines: this.lines, errLines: this.errLines, data: { ok: exitCode === 0, exit_code: exitCode, ...data } };
  }
}

interface Timing {
  timeoutMs: number;
  pollMs: number;
  stopTimeoutMs: number;
  freshMs: number;
}

/** The same knobs as the switch script (HARMONY_SWITCH_*), in seconds. */
export function timingFromEnv(env: Env): Timing {
  const n = (k: string, d: number): number => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    timeoutMs: n('HARMONY_SWITCH_TIMEOUT_S', 180) * 1000,
    pollMs: n('HARMONY_SWITCH_POLL_S', 5) * 1000,
    stopTimeoutMs: n('HARMONY_SWITCH_STOP_TIMEOUT_S', 60) * 1000,
    freshMs: n('HARMONY_SWITCH_FRESH_S', 120) * 1000,
  };
}

const logPathOf = (s: ConductorSettings): string => join(s.paths.home, 'conductor.log');

async function findConductors(deps: LifecycleDeps, s: ConductorSettings): Promise<ConductorProcess[]> {
  const procs = await deps.listProcesses();
  const cwdByPid = new Map<number, string>();
  for (const pid of needsCwd(procs)) {
    const cwd = await deps.cwdOf(pid);
    if (cwd) cwdByPid.set(pid, cwd);
  }
  return matchConductors(procs, { pluginDir: s.pluginDir, configPath: s.deploymentConfig, cwdByPid });
}

function pluginVersion(deps: LifecycleDeps, pluginDir: string): string {
  try {
    const v = (JSON.parse(deps.readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'))) as { version?: string }).version;
    return v || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function waitForExit(deps: LifecycleDeps, pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = deps.now() + timeoutMs;
  let alive = pids.filter((p) => deps.signal(p, 0));
  while (alive.length > 0 && deps.now() < deadline) {
    await deps.sleep(1000);
    alive = alive.filter((p) => deps.signal(p, 0));
  }
  return alive;
}

async function runSupervisorCommands(deps: LifecycleDeps, cmds: SupervisorCommand[], out: Out): Promise<boolean> {
  for (const c of cmds) {
    out.line(`  $ ${c.file} ${c.args.join(' ')}`);
    const r = await deps.exec(c.file, c.args, { interactive: c.interactive });
    if (r.code !== 0) {
      out.err(`${c.file} ${c.args[0]} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n')[0] ?? ''}`);
      return false;
    }
  }
  return true;
}

const describeSupervisor = (sup: SupervisorState): string => (sup.kind === 'none' ? 'none (unsupervised)' : `${sup.kind}${sup.target ? ` (${sup.target})` : ''}`);

const legLine = (r: { ticket: string | null; id: string }): string => `  - ${r.ticket ?? '?'}  conduction ${r.id}`;

/** The args the launcher forwards to the daemon, from explicit options only (a supervised conductor takes its
 *  profile from the config files; the daemon reads them itself). */
function launcherArgsFrom(o: { config?: string; profile?: string }): string[] {
  return [...(o.config ? ['--config', o.config] : []), ...(o.profile ? ['--profile', o.profile] : [])];
}

async function safeBoard(deps: LifecycleDeps, s: ConductorSettings): Promise<{ rows: BoardRow[] | null; error?: string }> {
  if (!s.env.HARMONY_API_TOKEN) return { rows: null, error: 'HARMONY_API_TOKEN is not set' };
  try {
    return { rows: await deps.readBoard(s.env) };
  } catch (err) {
    return { rows: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------------------------------

export interface StatusOptions {
  config?: string;
}

export async function runStatus(deps: LifecycleDeps, opts: StatusOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const s = await loadSettings(deps, { config: opts.config });
  const timing = timingFromEnv(s.env);
  const host = deps.hostname();
  const procs = await findConductors(deps, s);
  const sup = await detectSupervisorState({ platform: deps.platform, uid: deps.uid, home: deps.home, exec: (f, a) => deps.exec(f, a), existsSync: deps.existsSync });
  const board = await safeBoard(deps, s);
  const nowMs = deps.now();

  if (procs.length === 0) {
    out.line('No conductor is running here. Status for a conductor elsewhere arrives with the registry.');
    if (sup.kind !== 'none' && sup.active) out.line(`A supervisor job is loaded (${describeSupervisor(sup)}) but no conductor process is running; it may be starting or crash-looping.`);
    const orphans = board.rows ? classifyLeases(board.rows, host, null, timing.freshMs, nowMs).filter((l) => l.owner === 'previous-process') : [];
    if (orphans.length > 0) {
      out.line('');
      out.line(`Conductor stopped; ${orphans.length} leg(s) still running as their own jobs (the next \`harmony conductor start\` adopts them):`);
      for (const l of orphans) out.line(`  - ${l.ticket}  conduction ${l.id}  (held by ${l.holder})`);
    } else if (board.error) {
      out.line(`(the board could not be read to list legs: ${board.error})`);
    }
    return out.result(EXIT.ok, {
      state: 'stopped',
      host,
      supervisor: sup.kind,
      supervisor_target: sup.target ?? null,
      legs_still_running: orphans.map((l) => ({ ticket: l.ticket, conduction: l.id, holder: l.holder })),
      board_error: board.error ?? null,
    });
  }

  const primary = procs[0];
  const version = pluginVersion(deps, s.pluginDir);
  const profile = primary.profile ?? s.profile ?? 'unknown (the config file names none)';
  const leases = board.rows ? classifyLeases(board.rows, host, primary.pid, timing.freshMs, nowMs) : [];
  const mine = leases.filter((l) => l.owner === 'this-conductor');
  const earlier = leases.filter((l) => l.owner === 'previous-process');
  const stale = mine.filter((l) => !l.fresh);
  const beats = mine.map((l) => Date.parse(l.last_heartbeat_at ?? '')).filter((t) => Number.isFinite(t));
  const lastBeat = beats.length ? new Date(Math.max(...beats)).toISOString() : null;
  const ago = (iso: string | null): string => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) ? `${Math.max(0, Math.round((nowMs - t) / 1000))}s ago` : 'never';
  };

  out.line(procs.length > 1 ? `Conductor: MORE THAN ONE conductor process for this project is running here (pids ${procs.map((p) => p.pid).join(', ')})` : 'Conductor: running');
  out.line(`  host:            ${host}`);
  out.line(`  pid:             ${procs.map((p) => p.pid).join(', ')}`);
  out.line(`  profile:         ${profile}`);
  out.line(`  plugin version:  ${version}${s.channel ? ` (channel ${s.channel})` : ''}`);
  out.line(`  supervisor:      ${describeSupervisor(sup)}`);
  out.line(`  last heartbeat:  ${lastBeat ? `${lastBeat} (${ago(lastBeat)})` : board.rows ? 'none yet (this conductor holds no leases)' : 'unknown (board unreadable)'}`);
  out.line('');
  if (board.rows === null) {
    out.line(`Legs: unknown (the board could not be read: ${board.error})`);
  } else {
    out.line(`Legs running under this conductor: ${mine.length}`);
    for (const l of mine) out.line(`  - ${l.ticket}  conduction ${l.id}  heartbeat ${ago(l.last_heartbeat_at)}${l.fresh ? '' : '  STALE'}`);
    if (earlier.length > 0) {
      out.line(`NOT YET ADOPTED: ${earlier.length} lease(s) on this host are held by an earlier process:`);
      for (const l of earlier) out.line(`  - ${l.ticket}  conduction ${l.id}  held by ${l.holder}`);
    }
    if (mine.length > 0 && earlier.length === 0 && stale.length === 0) {
      out.line(`Adoption: every lease on this host is held by pid ${primary.pid} with a fresh heartbeat.`);
    } else if (mine.length === 0 && earlier.length === 0) {
      out.line('Adoption: no leases are held on this host.');
    }
  }
  return out.result(EXIT.ok, {
    state: procs.length > 1 ? 'multiple' : 'running',
    host,
    pids: procs.map((p) => p.pid),
    profile: primary.profile ?? s.profile ?? null,
    plugin_version: version,
    channel: s.channel ?? null,
    supervisor: sup.kind,
    supervisor_target: sup.target ?? null,
    last_heartbeat_at: lastBeat,
    legs: mine.map((l) => ({ ticket: l.ticket, conduction: l.id, last_heartbeat_at: l.last_heartbeat_at, fresh: l.fresh })),
    not_adopted: earlier.map((l) => ({ ticket: l.ticket, conduction: l.id, holder: l.holder })),
    adoption_complete: board.rows !== null && earlier.length === 0 && stale.length === 0,
    board_error: board.error ?? null,
  });
}

// ---------------------------------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------------------------------

export interface StopOptions {
  config?: string;
}

export async function runStop(deps: LifecycleDeps, opts: StopOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const s = await loadSettings(deps, { config: opts.config });
  const timing = timingFromEnv(s.env);
  const procs = await findConductors(deps, s);
  const sup = await detectSupervisorState({ platform: deps.platform, uid: deps.uid, home: deps.home, exec: (f, a) => deps.exec(f, a), existsSync: deps.existsSync });

  if (procs.length === 0 && !sup.active) {
    out.line('No conductor is running here. Nothing to stop.');
    return out.result(EXIT.ok, { state: 'stopped', stopped: false, supervisor: sup.kind });
  }

  const pids = procs.map((p) => p.pid);
  out.line(`Stopping the conductor (${pids.length ? `pid ${pids.join(', ')}` : 'no process'}; supervisor ${describeSupervisor(sup)}).`);
  out.line('Running legs keep running as their own jobs; the next start adopts them.');
  if (sup.kind === 'none') {
    for (const pid of pids) {
      out.line(`  SIGTERM ${pid}`);
      deps.signal(pid, 'SIGTERM');
    }
  } else if (!(await runSupervisorCommands(deps, stopCommands(sup.kind, deps.uid), out))) {
    return out.result(EXIT.failure, { state: 'unknown', error: out.errLines[0], supervisor: sup.kind });
  }
  const left = await waitForExit(deps, pids, timing.stopTimeoutMs);
  if (left.length > 0) {
    out.err(`conductor pid ${left.join(', ')} did not exit within ${timing.stopTimeoutMs / 1000}s after the stop — it is still running`);
    return out.result(EXIT.failure, { state: 'running', still_running: left, supervisor: sup.kind });
  }
  out.line('Conductor stopped.');

  const board = await safeBoard(deps, s);
  const legs = board.rows ? classifyLeases(board.rows, deps.hostname(), null, timing.freshMs, deps.now()).filter((l) => l.owner === 'previous-process') : [];
  if (legs.length > 0) {
    out.line(`${legs.length} leg(s) still running as their own jobs; the next \`harmony conductor start\` adopts them:`);
    for (const l of legs) out.line(`  - ${l.ticket}  conduction ${l.id}`);
  } else if (board.error) out.line(`(the board could not be read to list legs: ${board.error})`);
  return out.result(EXIT.ok, {
    state: 'stopped',
    stopped: true,
    supervisor: sup.kind,
    pids,
    legs_still_running: legs.map((l) => ({ ticket: l.ticket, conduction: l.id })),
  });
}

// ---------------------------------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------------------------------

export interface StartOptions {
  local?: boolean;
  atBoot?: boolean;
  remote?: boolean;
  profile?: string;
  config?: string;
}

export async function runStart(deps: LifecycleDeps, opts: StartOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const modes = [opts.local, opts.atBoot, opts.remote].filter(Boolean).length;
  if (modes > 1) {
    out.err('--local, --at-boot and --remote are mutually exclusive');
    return out.result(EXIT.usage, { error: out.errLines[0] });
  }
  if (opts.remote) {
    out.err('--remote is not available yet: remote conductors arrive with the registry. Nothing was started.');
    return out.result(EXIT.usage, { error: out.errLines[0], started: false });
  }
  const mode: 'local' | 'at-boot' = opts.atBoot ? 'at-boot' : 'local';
  if (mode === 'at-boot' && deps.platform !== 'darwin') {
    out.err('--at-boot is macOS only (a LaunchDaemon). On Linux use --local and enable lingering: sudo loginctl enable-linger $USER');
    return out.result(EXIT.usage, { error: out.errLines[0], started: false });
  }
  if (deps.platform !== 'darwin' && deps.platform !== 'linux') {
    out.err(`conductor start is supported on macOS and Linux, not ${deps.platform}`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false });
  }

  const s = await loadSettings(deps, { profile: opts.profile, config: opts.config });
  const host = deps.hostname();
  const procs = await findConductors(deps, s);
  const sup = await detectSupervisorState({ platform: deps.platform, uid: deps.uid, home: deps.home, exec: (f, a) => deps.exec(f, a), existsSync: deps.existsSync });

  if (procs.length > 0) {
    out.err(`a conductor for this project is already running on this machine (host ${host}, pid ${procs.map((p) => p.pid).join(', ')}, supervisor ${describeSupervisor(sup)}). Nothing was started. Use \`harmony conductor restart\` to restart it, or \`harmony conductor stop\` first.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, host, pids: procs.map((p) => p.pid) });
  }
  if (sup.active && sup.kind !== 'none' && sup.kind !== 'systemd-user') {
    out.err(`a supervisor job is already loaded (${describeSupervisor(sup)}) but no conductor process is running. Nothing was started. Use \`harmony conductor restart\`, or \`harmony conductor stop\` to unload it first.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, supervisor: sup.kind });
  }

  out.line('Pre-flight');
  const pre = await runPreflight(deps, s, { supervise: mode });
  for (const l of formatChecks(pre.checks)) out.line(l);
  for (const w of pre.warnings) out.line(`  WARNING: ${w}`);
  if (!pre.ok) {
    out.err(`pre-flight failed: ${failedNames(pre.checks).join(', ')}. Nothing was started.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, failed_checks: failedNames(pre.checks), checks: pre.checks, warnings: pre.warnings });
  }

  const args = launcherArgsFrom(opts);
  const logPath = logPathOf(s);
  const renderOpts = { pluginDir: s.pluginDir, launcherArgs: args, home: deps.home, path: deps.env.PATH || '/usr/local/bin:/usr/bin:/bin', logPath };
  let kind: SupervisorState['kind'];
  let unitPath: string;
  let cmds: SupervisorCommand[];
  try {
    deps.mkdirSync(dirname(logPath));
    if (deps.platform === 'darwin') {
      const template = deps.readFileSync(join(s.pluginDir, LAUNCHD_TEMPLATE));
      if (mode === 'at-boot') {
        kind = 'launchd-daemon';
        unitPath = daemonPlistPath();
        const staged = join(s.paths.home, 'conductor-launchd.plist.staged');
        deps.writeFileSync(staged, renderLaunchdPlist(template, { ...renderOpts, userName: deps.username }), 0o644);
        cmds = installCommands(kind, deps.uid, { agentPlist: unitPath, staged });
        out.line(`Installing a LaunchDaemon (${unitPath}) that starts at boot as ${deps.username}; sudo will ask for your password once.`);
      } else {
        kind = 'launchd-agent';
        unitPath = agentPlistPath(deps.home);
        deps.mkdirSync(dirname(unitPath));
        deps.writeFileSync(unitPath, renderLaunchdPlist(template, renderOpts), 0o644);
        cmds = installCommands(kind, deps.uid, { agentPlist: unitPath });
        out.line(`Installed the LaunchAgent ${unitPath}.`);
      }
    } else {
      const template = deps.readFileSync(join(s.pluginDir, SYSTEMD_TEMPLATE));
      kind = 'systemd-user';
      unitPath = systemdUnitPath(deps.home);
      deps.mkdirSync(dirname(unitPath));
      deps.writeFileSync(unitPath, renderSystemdUnit(template, renderOpts), 0o644);
      cmds = installCommands(kind, deps.uid, { agentPlist: unitPath });
      out.line(`Installed the systemd user unit ${unitPath}.`);
    }
  } catch (err) {
    out.err(`could not write the supervisor job: ${err instanceof Error ? err.message : String(err)}. Nothing was started.`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false });
  }

  if (!(await runSupervisorCommands(deps, cmds, out))) {
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, supervisor: kind });
  }
  if (mode === 'at-boot') deps.rmSync(join(s.paths.home, 'conductor-launchd.plist.staged'));

  const deadline = deps.now() + 30_000;
  let started: ConductorProcess[] = [];
  while (deps.now() < deadline) {
    started = await findConductors(deps, s);
    if (started.length > 0) break;
    await deps.sleep(1000);
  }
  if (started.length === 0) {
    out.err(`the supervisor job was loaded but no conductor process appeared within 30s — see ${logPath}`);
    return out.result(EXIT.failure, { error: out.errLines[0], started: false, supervisor: kind, log: logPath });
  }
  out.line('');
  out.line(`Conductor started: host ${host}, pid ${started[0].pid}, supervisor ${kind}, plugin ${pluginVersion(deps, s.pluginDir)}, log ${logPath}.`);
  out.line('It survives a reboot. Run `harmony conductor status` to confirm it holds its leases with a fresh heartbeat.');
  return out.result(EXIT.ok, { started: true, host, pid: started[0].pid, supervisor: kind, unit: unitPath, log: logPath });
}

// ---------------------------------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------------------------------

export interface RestartOptions {
  profile?: string;
  config?: string;
  dryRun?: boolean;
  /** Skip the in-flight guard. LAST RESORT: a leg on the other backend can end up running twice. */
  force?: boolean;
}

interface InFlight {
  ok: boolean;
  legs: Array<{ ticket: string; id: string }>;
  reason?: string;
  /** The listing tool is absent here: the backend is not in use on this machine. */
  toolMissing?: boolean;
}

/** Legs running on a backend (the guard's outgoing side). Ports gke_legs_in_flight / cloud_legs_in_flight. */
async function legsInFlight(deps: LifecycleDeps, s: ConductorSettings, backend: 'gke' | 'cloud', board: BoardRow[]): Promise<InFlight> {
  if (backend === 'gke') {
    const ns = s.env.HARMONY_GKE_NAMESPACE || 'harmony-legs';
    const args = ['-n', ns, ...(s.env.HARMONY_GKE_CONTEXT ? ['--context', s.env.HARMONY_GKE_CONTEXT] : []), 'get', 'jobs', '-o', 'json'];
    const r = await deps.exec('kubectl', args, { env: s.env });
    if (r.code === 127) return { ok: false, legs: [], toolMissing: true, reason: 'kubectl is not installed' };
    if (r.code !== 0) return { ok: false, legs: [], reason: `could not list Jobs in ${ns}` };
    try {
      const items = (JSON.parse(r.stdout).items ?? []) as Array<{ metadata?: { labels?: Record<string, string> }; status?: { conditions?: Array<{ type: string; status: string }> } }>;
      const legs = items
        .filter((it) => !(it.status?.conditions ?? []).filter((c) => c.status !== 'False').some((c) => c.type === 'Complete' || c.type === 'Failed'))
        .map((it) => ({ ticket: it.metadata?.labels?.['harmony-ticket'] ?? '?', id: it.metadata?.labels?.['conduction-id'] ?? '?' }));
      return { ok: true, legs };
    } catch {
      return { ok: false, legs: [], reason: `the Jobs listing in ${ns} was not valid JSON` };
    }
  }
  const job = s.env.HARMONY_CLOUD_RUN_JOB;
  const region = s.env.HARMONY_CLOUD_RUN_REGION;
  if (!job || !region) return { ok: false, legs: [], toolMissing: true, reason: 'HARMONY_CLOUD_RUN_JOB / HARMONY_CLOUD_RUN_REGION are not set' };
  const project = s.env.CLOUDSDK_CORE_PROJECT || 'harmony-conductor';
  const r = await deps.exec('gcloud', ['run', 'jobs', 'executions', 'list', `--job=${job}`, `--region=${region}`, `--project=${project}`, '--format=json'], { env: s.env });
  if (r.code === 127) return { ok: false, legs: [], toolMissing: true, reason: 'gcloud is not installed' };
  if (r.code !== 0) return { ok: false, legs: [], reason: `could not list Cloud Run executions of ${job}` };
  try {
    const list = JSON.parse(r.stdout) as Array<{ metadata?: { name?: string; labels?: Record<string, string> }; status?: { completionTime?: string } }>;
    if (!Array.isArray(list)) throw new Error('not an array');
    const legs = list
      .filter((e) => !e.status?.completionTime)
      .map((e) => {
        const id = e.metadata?.labels?.['conduction-id'] ?? e.metadata?.name ?? '?';
        return { ticket: board.find((b) => b.id === id)?.ticket ?? '?', id };
      });
    return { ok: true, legs };
  } catch {
    return { ok: false, legs: [], reason: 'the Cloud Run executions listing was not valid JSON' };
  }
}

export async function runRestart(deps: LifecycleDeps, opts: RestartOptions = {}, onLine?: (l: string) => void): Promise<CliResult> {
  const out = new Out(onLine);
  const s = await loadSettings(deps, { profile: opts.profile, config: opts.config });
  const timing = timingFromEnv(s.env);
  const host = deps.hostname();
  const procs = await findConductors(deps, s);
  const sup = await detectSupervisorState({ platform: deps.platform, uid: deps.uid, home: deps.home, exec: (f, a) => deps.exec(f, a), existsSync: deps.existsSync });
  const supervised = sup.kind !== 'none';

  if (procs.length === 0 && !supervised) {
    out.err('no conductor is running here — nothing to restart. Start one with `harmony conductor start --local`.');
    return out.result(EXIT.failure, { error: out.errLines[0] });
  }
  if (procs.length > 1) {
    out.err(`more than one conductor for this project is running (pids ${procs.map((p) => p.pid).join(', ')}) — stop the extras first`);
    return out.result(EXIT.failure, { error: out.errLines[0] });
  }
  if (supervised && opts.profile && opts.profile !== s.merged?.profile) {
    out.err(`a supervised conductor takes its profile from the config files, so --profile ${opts.profile} cannot be passed on restart. Change \`profile\` in .harmony/conductor.json (or the host file), then run \`harmony conductor restart\`.`);
    return out.result(EXIT.usage, { error: out.errLines[0] });
  }
  const old = procs[0] as ConductorProcess | undefined;
  const target = s.profile;

  // 1. Pre-flight: read-only, BEFORE any signal.
  out.line('1. Pre-flight');
  const pre = await runPreflight(deps, s, { pull: true });
  for (const l of formatChecks(pre.checks)) out.line(l);
  if (!pre.ok || pre.board === null) {
    out.err(`pre-flight failed: ${failedNames(pre.checks).join(', ') || 'cred:board'}. The running conductor and its leases were left untouched.`);
    return out.result(EXIT.failure, { error: out.errLines[0], failed_checks: failedNames(pre.checks), checks: pre.checks, signalled: false });
  }
  const board = pre.board;

  // 2. The leases the old conductor holds (what the new one must adopt).
  const held = old ? heldBy(board, holderPrefix(host, old.pid)) : heldBy(board, `${host}:`);
  out.line(old ? `Running conductor: pid ${old.pid}${old.profile ? `, profile ${old.profile}` : ''}.` : 'No conductor process is running; the supervisor job will be restarted.');
  if (held.length > 0) {
    out.line('Conductions held:');
    for (const h of held) out.line(legLine(h));
  } else out.line('The conductor holds no active conductions.');

  // 3. In-flight guard: legs on the backend the target profile does NOT use (switch-daemon-profile.sh logic).
  if (!opts.force && (target === 'gke' || target === 'cloud') && !(old?.profile && old.profile === target)) {
    const outgoing = target === 'gke' ? 'cloud' : 'gke';
    out.line(`2. In-flight legs on the other backend (${outgoing})`);
    const f = await legsInFlight(deps, s, outgoing, board);
    if (!f.ok && f.toolMissing && !(old?.profile && old.profile !== target)) {
      out.line(`  skipped: ${f.reason} (the ${outgoing} backend is not used from this machine)`);
    } else if (!f.ok) {
      out.err(`cannot tell whether a leg is in flight on ${outgoing}: ${f.reason}. Nothing was changed.`);
      return out.result(EXIT.failure, { error: out.errLines[0], signalled: false });
    } else if (f.legs.length > 0) {
      out.err(`REFUSING to restart onto profile '${target}': a leg is still running on ${outgoing}:`);
      for (const l of f.legs) out.err(`  - ${l.ticket}  conduction ${l.id}`);
      out.err('Wait for these to finish, then run again. --force overrides this check, but it is a LAST RESORT: the new conductor reaps adopted leases with its OWN profile\'s reap script, which cannot see a leg on the other backend, so a forced restart can leave a leg running twice.');
      return out.result(EXIT.inFlight, { error: 'legs in flight on another backend', in_flight: f.legs, signalled: false });
    } else out.line(`  no leg is running on ${outgoing}`);
  } else if (opts.force) out.line('WARNING: --force given — the in-flight guard was skipped (last resort; a leg may run twice).');

  const versionBefore = pluginVersion(deps, s.pluginDir);
  const cmds = supervised ? restartCommands(sup.kind, deps.uid) : [];
  const launchArgs = launcherArgsFrom({ config: opts.config ?? old?.config, profile: opts.profile ?? old?.profile });

  if (opts.dryRun) {
    out.line('');
    out.line('Dry run: nothing changed. A real run would:');
    out.line(s.channel ? `  - pull channel '${s.channel}' (git -C ${s.pluginDir} pull --ff-only origin ${s.channel}); plugin is ${versionBefore} now` : '  - skip the pull (no channel is configured)');
    if (supervised) for (const c of cmds) out.line(`  - ${c.file} ${c.args.join(' ')}`);
    else out.line(`  - SIGTERM pid ${old?.pid}, wait up to ${timing.stopTimeoutMs / 1000}s, then nohup bash ${launcherPath(s.pluginDir)} ${launchArgs.join(' ')}`.trimEnd());
    out.line(`  - confirm from the board within ${timing.timeoutMs / 1000}s that every held conduction is leased by the new conductor with a heartbeat under ${timing.freshMs / 1000}s old`);
    return out.result(EXIT.ok, { dry_run: true, held: held.map((h) => ({ ticket: h.ticket, conduction: h.id })), plugin_version: versionBefore, signalled: false });
  }

  // 4. Update: pull the configured channel, fast-forward only.
  out.line('3. Update the plugin checkout');
  let versionAfter = versionBefore;
  if (s.channel) {
    const pull = await deps.exec('git', ['-C', s.pluginDir, 'pull', '--ff-only', 'origin', s.channel]);
    if (pull.code !== 0) {
      out.err(`git pull --ff-only origin ${s.channel} failed in ${s.pluginDir}: ${(pull.stderr || pull.stdout).trim().split('\n')[0]}. The running conductor was left untouched.`);
      return out.result(EXIT.failure, { error: out.errLines[0], signalled: false, plugin_version_before: versionBefore });
    }
    versionAfter = pluginVersion(deps, s.pluginDir);
    if (!deps.existsSync(join(s.pluginDir, 'dist', 'bin', 'daemon.js'))) {
      out.err(`after the pull ${join(s.pluginDir, 'dist', 'bin', 'daemon.js')} does not exist — the channel branch carries no built bundle. The running conductor was left untouched.`);
      return out.result(EXIT.failure, { error: out.errLines[0], signalled: false, plugin_version_before: versionBefore });
    }
    out.line(versionAfter === versionBefore ? `  plugin ${versionBefore} (already the channel's latest)` : `  plugin ${versionBefore} -> ${versionAfter}`);
  } else out.line(`  no channel is configured: restarting the version already on disk (plugin ${versionBefore})`);

  // 5. Stop and start.
  out.line('4. Restart');
  const oldPids = procs.map((p) => p.pid);
  let startedPid: number | null = null;
  if (supervised) {
    if (!(await runSupervisorCommands(deps, cmds, out))) {
      return out.result(EXIT.failure, { error: out.errLines[0], signalled: true, plugin_version_before: versionBefore, plugin_version_after: versionAfter });
    }
  } else {
    for (const pid of oldPids) {
      out.line(`  SIGTERM ${pid}`);
      if (!deps.signal(pid, 'SIGTERM')) {
        out.err(`could not signal conductor pid ${pid}`);
        return out.result(EXIT.failure, { error: out.errLines[0], signalled: false });
      }
    }
    const left = await waitForExit(deps, oldPids, timing.stopTimeoutMs);
    if (left.length > 0) {
      out.err(`conductor pid ${left.join(', ')} did not exit within ${timing.stopTimeoutMs / 1000}s after SIGTERM — it was NOT restarted; it is still running`);
      return out.result(EXIT.failure, { error: out.errLines[0], signalled: true });
    }
    out.line('  old conductor exited');
    startedPid = deps.spawnDetached('nohup', ['bash', launcherPath(s.pluginDir), ...launchArgs], { logPath: logPathOf(s), env: { HARMONY_PLUGIN_DIR: s.pluginDir }, cwd: s.pluginDir });
    out.line(`  started conductor pid ${startedPid} (log ${logPathOf(s)})`);
  }

  // 6. Find the new process.
  let newPid = startedPid;
  const findDeadline = deps.now() + timing.timeoutMs;
  while (newPid === null) {
    const now = (await findConductors(deps, s)).filter((p) => !oldPids.includes(p.pid));
    if (now.length > 0) newPid = now[0].pid;
    else if (deps.now() >= findDeadline) break;
    else await deps.sleep(Math.min(timing.pollMs, 1000));
  }
  if (newPid === null) {
    out.err(`no new conductor process appeared within ${timing.timeoutMs / 1000}s — see ${logPathOf(s)}`);
    return out.result(EXIT.notAdopted, { error: out.errLines[0], plugin_version_before: versionBefore, plugin_version_after: versionAfter });
  }
  out.line(`  new conductor pid ${newPid}`);

  // 7. Adoption, confirmed from the board.
  out.line(`5. Confirm adoption (board, up to ${timing.timeoutMs / 1000}s)`);
  const newPrefix = holderPrefix(host, newPid);
  const deadline = deps.now() + timing.timeoutMs;
  let pending = held.map((h) => h.id);
  const labelOf = (id: string): string => held.find((h) => h.id === id)?.ticket ?? '?';
  const adopted: string[] = [];
  for (;;) {
    if (!deps.signal(newPid, 0)) {
      out.err(`the new conductor (pid ${newPid}) is no longer running — see ${logPathOf(s)}`);
      return out.result(EXIT.notAdopted, { error: out.errLines[0], new_pid: newPid });
    }
    const reasons: string[] = [];
    if (pending.length > 0) {
      const rows: BoardRow[] | null = await deps.readBoard(s.env).catch(() => null);
      const stillPending: string[] = [];
      for (const id of pending) {
        const st = rows ? adoptionState(rows, id, newPrefix, timing.freshMs, deps.now()) : ({ state: 'wait', why: 'board unreadable' } as const);
        if (st.state === 'ok') {
          adopted.push(id);
          out.line(`  adopted: ${labelOf(id)}  conduction ${id}`);
        } else if (st.state === 'gone') out.line(`  settled meanwhile (no longer active): ${labelOf(id)}  conduction ${id}`);
        else {
          stillPending.push(id);
          reasons.push(`  - ${labelOf(id)}  conduction ${id}: ${st.why}`);
        }
      }
      pending = stillPending;
    }
    if (pending.length === 0) break;
    if (deps.now() >= deadline) {
      out.err(`adoption NOT confirmed within ${timing.timeoutMs / 1000}s for:`);
      for (const r of reasons) out.err(r);
      out.err(`New conductor pid ${newPid}, log ${logPathOf(s)}.`);
      return out.result(EXIT.notAdopted, { error: 'adoption not confirmed', new_pid: newPid, pending, plugin_version_before: versionBefore, plugin_version_after: versionAfter });
    }
    await deps.sleep(timing.pollMs);
  }
  out.line('');
  out.line(`Restarted: conductor pid ${newPid}; plugin ${versionBefore === versionAfter ? versionAfter : `${versionBefore} -> ${versionAfter}`}; ${held.length === 0 ? 'it held no conductions' : 'all held conductions confirmed on the board'}.`);
  return out.result(EXIT.ok, { restarted: true, old_pids: oldPids, new_pid: newPid, plugin_version_before: versionBefore, plugin_version_after: versionAfter, adopted, supervisor: sup.kind });
}

// ---------------------------------------------------------------------------------------------------
// commander wiring
// ---------------------------------------------------------------------------------------------------

/** Run a core with live output and exit with its code. Streaming means the lines are printed as they happen;
 *  --json prints one payload at the end instead. */
async function emitLive(program: Command, run: (onLine?: (l: string) => void) => Promise<CliResult>): Promise<void> {
  const json = Boolean(program.opts().json);
  let result: CliResult;
  try {
    result = await run(json ? undefined : (l) => console.log(l));
  } catch (err) {
    result = { exitCode: 1, lines: [], errLines: [err instanceof Error ? err.message : String(err)], data: { ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
  if (json) console.log(formatOutput(result.data, { json: true }));
  else for (const l of result.errLines) console.error(`harmony conductor: ${l}`);
  if (result.exitCode !== 0) process.exit(result.exitCode);
}

/** Register start/stop/restart/status on the `conductor` group. Sibling files (conductor-logs.ts, B-1174)
 *  register their verbs the same way: one `register...(program, conductor)` line in conductor-config.ts. */
export function registerConductorLifecycleCommands(program: Command, conductor: Command, makeDeps: () => LifecycleDeps = defaultLifecycleDeps): void {
  conductor
    .command('start')
    .description('Start this project\'s conductor on this machine and keep it running (refuses if one already runs here)')
    .option('--local', 'Install and load a supervisor job that survives reboot (LaunchAgent on macOS, systemd user unit on Linux) [default]', false)
    .option('--at-boot', 'macOS only: install a LaunchDaemon (needs sudo once) that starts at boot as this user', false)
    .option('--remote', 'Start on another machine (not available yet)', false)
    .option('--profile <name>', 'Launch profile to pass to the conductor (default: the config files\')')
    .option('--config <path>', 'Explicit deployment.json path to pass to the conductor')
    .action((o: { local?: boolean; atBoot?: boolean; remote?: boolean; profile?: string; config?: string }) =>
      emitLive(program, (on) => runStart(makeDeps(), o, on)),
    );

  conductor
    .command('stop')
    .description('Stop new launches. Running legs keep running as their own jobs; the next start adopts them')
    .option('--config <path>', 'Explicit deployment.json path the conductor was started with')
    .action((o: { config?: string }) => emitLive(program, (on) => runStop(makeDeps(), o, on)));

  conductor
    .command('restart')
    .description('Update and restart: pull the configured channel (fast-forward only), stop, start, and confirm adoption from the board')
    .option('--profile <name>', 'Launch profile to restart under (unsupervised conductors only; a supervised one follows the config files)')
    .option('--config <path>', 'Explicit deployment.json path')
    .option('--dry-run', 'Run pre-flight and the in-flight guard, print the plan, change nothing', false)
    .option('--force', 'Skip the in-flight guard. LAST RESORT: a leg may end up running twice', false)
    .action((o: RestartOptions) => emitLive(program, (on) => runRestart(makeDeps(), o, on)));

  conductor
    .command('status')
    .description('Where the conductor runs, its profile, plugin version, last heartbeat, running legs and supervisor')
    .option('--config <path>', 'Explicit deployment.json path the conductor was started with')
    .action((o: StatusOptions) => emitLive(program, (on) => runStatus(makeDeps(), o, on)));
}
