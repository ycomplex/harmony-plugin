// B-1171: how the conductor is supervised on this machine, and the exact commands that control it.
//
// Sits beside supervisor.ts (which answers, from INSIDE the daemon process, "who started me?"). This module
// answers it from OUTSIDE, for `harmony conductor start|stop|restart|status`:
//
//   launchd-agent   a LaunchAgent in the user's gui/<uid> domain (starts at login; at boot only with
//                   automatic login)
//   launchd-daemon  a LaunchDaemon in the system domain with a UserName key (starts at boot, as that user)
//   systemd-user    a systemd USER unit (starts at login; at boot only with lingering)
//   none            nothing supervises it (a hand-started nohup process)
//
// Everything here is PURE or takes an injected exec: command construction and template rendering are tested
// without ever running launchctl or systemctl.

import { join } from 'node:path';
import { LAUNCHD_SERVICE_NAME } from './supervisor.js';

export type SupervisorKind = 'launchd-agent' | 'launchd-daemon' | 'systemd-user' | 'none';

/** The label of container/launchd/com.ycomplex.harmony-daemon.plist, reused so the daemon's own
 *  detectSupervisor (XPC_SERVICE_NAME) recognises a job this module installs. */
export const LAUNCHD_LABEL = LAUNCHD_SERVICE_NAME;
export const SYSTEMD_UNIT = 'harmony-conductor.service';

/** One external command. `interactive` means stdio is inherited (a sudo password prompt). */
export interface SupervisorCommand {
  file: string;
  args: string[];
  interactive?: boolean;
}

export interface SupervisorState {
  kind: SupervisorKind;
  /** The supervised job is loaded (launchd) / active (systemd). A systemd unit that is installed but
   *  stopped is `{kind:'systemd-user', active:false}`. */
  active: boolean;
  /** `gui/501/<label>`, `system/<label>` or the unit name; absent for `none`. */
  target?: string;
}

export interface DetectDeps {
  platform: NodeJS.Platform;
  uid: number;
  home: string;
  exec: (file: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  existsSync: (path: string) => boolean;
}

export const agentPlistPath = (home: string): string => join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const daemonPlistPath = (): string => `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;
export const systemdUnitPath = (home: string): string => join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);

export const launchdTarget = (kind: 'launchd-agent' | 'launchd-daemon', uid: number): string =>
  kind === 'launchd-agent' ? `gui/${uid}/${LAUNCHD_LABEL}` : `system/${LAUNCHD_LABEL}`;

export async function detectSupervisorState(deps: DetectDeps): Promise<SupervisorState> {
  if (deps.platform === 'darwin') {
    for (const kind of ['launchd-agent', 'launchd-daemon'] as const) {
      const target = launchdTarget(kind, deps.uid);
      const r = await deps.exec('launchctl', ['print', target]);
      if (r.code === 0) return { kind, active: true, target };
    }
    return { kind: 'none', active: false };
  }
  if (deps.platform === 'linux') {
    const r = await deps.exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
    const word = r.stdout.trim();
    if (r.code === 0 || word === 'active' || word === 'activating') return { kind: 'systemd-user', active: true, target: SYSTEMD_UNIT };
    if (deps.existsSync(systemdUnitPath(deps.home))) return { kind: 'systemd-user', active: false, target: SYSTEMD_UNIT };
  }
  return { kind: 'none', active: false };
}

/** The status probe for a supervised job (what `status` runs to report it). */
export function statusCommand(kind: SupervisorKind, uid: number): SupervisorCommand | null {
  if (kind === 'launchd-agent' || kind === 'launchd-daemon') return { file: 'launchctl', args: ['print', launchdTarget(kind, uid)] };
  if (kind === 'systemd-user') return { file: 'systemctl', args: ['--user', 'is-active', SYSTEMD_UNIT] };
  return null;
}

/** Stop and keep the supervisor from restarting it. launchd: bootout UNLOADS the job (KeepAlive cannot
 *  bring it back). systemd: stop. none: the caller sends SIGTERM itself (empty list). */
export function stopCommands(kind: SupervisorKind, uid: number): SupervisorCommand[] {
  if (kind === 'launchd-agent') return [{ file: 'launchctl', args: ['bootout', launchdTarget(kind, uid)] }];
  if (kind === 'launchd-daemon') return [{ file: 'sudo', args: ['launchctl', 'bootout', launchdTarget(kind, uid)], interactive: true }];
  if (kind === 'systemd-user') return [{ file: 'systemctl', args: ['--user', 'stop', SYSTEMD_UNIT] }];
  return [];
}

/** Restart in place. launchd: kickstart -k (kill and restart). systemd: restart. none: the caller does
 *  SIGTERM, wait, start the launcher detached (empty list). */
export function restartCommands(kind: SupervisorKind, uid: number): SupervisorCommand[] {
  if (kind === 'launchd-agent') return [{ file: 'launchctl', args: ['kickstart', '-k', launchdTarget(kind, uid)] }];
  if (kind === 'launchd-daemon') return [{ file: 'sudo', args: ['launchctl', 'kickstart', '-k', launchdTarget(kind, uid)], interactive: true }];
  if (kind === 'systemd-user') return [{ file: 'systemctl', args: ['--user', 'restart', SYSTEMD_UNIT] }];
  return [];
}

/** Load a freshly written job. `staged` is where the rendered file was written first (for the LaunchDaemon
 *  it is a user-owned temp file that sudo then installs root-owned). */
export function installCommands(kind: Exclude<SupervisorKind, 'none'>, uid: number, paths: { agentPlist: string; staged?: string }): SupervisorCommand[] {
  if (kind === 'launchd-agent') return [{ file: 'launchctl', args: ['bootstrap', `gui/${uid}`, paths.agentPlist] }];
  if (kind === 'launchd-daemon') {
    const dest = daemonPlistPath();
    return [
      { file: 'sudo', args: ['install', '-m', '644', '-o', 'root', '-g', 'wheel', paths.staged ?? paths.agentPlist, dest], interactive: true },
      { file: 'sudo', args: ['launchctl', 'bootstrap', 'system', dest], interactive: true },
    ];
  }
  return [
    { file: 'systemctl', args: ['--user', 'daemon-reload'] },
    { file: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT] },
  ];
}

// ---------------------------------------------------------------------------------------------------
// Template rendering (pure)
// ---------------------------------------------------------------------------------------------------

/** Replace every `{{KEY}}`. A placeholder with no value is an error (a silent blank would ship a broken
 *  job); a value no placeholder uses is ignored. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return values[key];
  });
}

export const xmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface RenderOptions {
  pluginDir: string;
  /** Passed through to the launcher (and on to the daemon): `--config X`, `--profile Y`. */
  launcherArgs: string[];
  home: string;
  /** The PATH the job runs with: launchd and systemd do not read the shell's PATH. */
  path: string;
  logPath: string;
}

export const launcherPath = (pluginDir: string): string => join(pluginDir, 'container', 'conductor-launch.sh');

export function renderLaunchdPlist(template: string, o: RenderOptions & { label?: string; userName?: string }): string {
  const args = ['/bin/bash', launcherPath(o.pluginDir), ...o.launcherArgs];
  return fillTemplate(template, {
    LABEL: xmlEscape(o.label ?? LAUNCHD_LABEL),
    PROGRAM_ARGUMENTS: args.map((a) => `        <string>${xmlEscape(a)}</string>`).join('\n'),
    PLUGIN_DIR: xmlEscape(o.pluginDir),
    // A LaunchDaemon runs as root unless told otherwise: UserName makes it start at boot AS that user, with that user's HOME.
    USER_NAME_BLOCK: o.userName ? `\n    <key>UserName</key>\n    <string>${xmlEscape(o.userName)}</string>\n` : '',
    HOME: xmlEscape(o.home),
    PATH: xmlEscape(o.path),
    LOG_PATH: xmlEscape(o.logPath),
  });
}

/** systemd double-quoted word: backslash, quote and `%` (specifier) escaped; `$` too in ExecStart. */
export function systemdQuote(value: string, execLine = false): string {
  let v = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (execLine) v = v.replace(/\$/g, '$$$$');
  return `"${v}"`;
}

export function renderSystemdUnit(template: string, o: RenderOptions): string {
  const args = ['/bin/bash', launcherPath(o.pluginDir), ...o.launcherArgs];
  return fillTemplate(template, {
    PLUGIN_DIR: o.pluginDir.replace(/%/g, '%%'),
    ENV_PATH: systemdQuote(`PATH=${o.path}`),
    ENV_PLUGIN_DIR: systemdQuote(`HARMONY_PLUGIN_DIR=${o.pluginDir}`),
    EXEC_START: args.map((a) => systemdQuote(a, true)).join(' '),
    LOG_PATH: o.logPath.replace(/%/g, '%%'),
  });
}
