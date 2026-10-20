import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  detectSupervisorState,
  fillTemplate,
  installCommands,
  renderLaunchdPlist,
  renderSystemdUnit,
  restartCommands,
  statusCommand,
  stopCommands,
  systemdQuote,
  type DetectDeps,
} from './supervisor-control.js';

const repo = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const plistTemplate = readFileSync(repo('container/launchd/com.ycomplex.harmony-conductor.plist.template'), 'utf8');
const unitTemplate = readFileSync(repo('container/systemd/harmony-conductor.service.template'), 'utf8');

const detectDeps = (o: Partial<DetectDeps> & { loaded?: string[]; activeWord?: string }): DetectDeps => ({
  platform: 'darwin',
  uid: 501,
  home: '/Users/op',
  existsSync: () => false,
  exec: async (file, args) => {
    if (file === 'launchctl') return { code: (o.loaded ?? []).includes(args[1]) ? 0 : 113, stdout: '', stderr: '' };
    if (file === 'systemctl') return { code: o.activeWord === 'active' ? 0 : o.activeWord ? 3 : 127, stdout: `${o.activeWord ?? ''}\n`, stderr: '' };
    return { code: 127, stdout: '', stderr: '' };
  },
  ...o,
});

describe('B-1171: the label matches the shipped plist (so the daemon\'s own detectSupervisor recognises it)', () => {
  it('LAUNCHD_LABEL is the label of container/launchd/com.ycomplex.harmony-daemon.plist', () => {
    const shipped = readFileSync(repo('container/launchd/com.ycomplex.harmony-daemon.plist'), 'utf8');
    expect(shipped).toContain(`<string>${LAUNCHD_LABEL}</string>`);
  });
});

describe('B-1171: detectSupervisorState', () => {
  it('launchd-agent when gui/<uid>/<label> is loaded', async () => {
    const s = await detectSupervisorState(detectDeps({ loaded: [`gui/501/${LAUNCHD_LABEL}`] }));
    expect(s).toEqual({ kind: 'launchd-agent', active: true, target: `gui/501/${LAUNCHD_LABEL}` });
  });
  it('launchd-daemon when only the system domain has it', async () => {
    const s = await detectSupervisorState(detectDeps({ loaded: [`system/${LAUNCHD_LABEL}`] }));
    expect(s).toEqual({ kind: 'launchd-daemon', active: true, target: `system/${LAUNCHD_LABEL}` });
  });
  it('none on macOS when neither domain has it', async () => {
    expect((await detectSupervisorState(detectDeps({}))).kind).toBe('none');
  });
  it('systemd-user when is-active says active; installed-but-stopped is kind systemd-user, inactive', async () => {
    expect(await detectSupervisorState(detectDeps({ platform: 'linux', activeWord: 'active' }))).toMatchObject({ kind: 'systemd-user', active: true });
    expect(await detectSupervisorState(detectDeps({ platform: 'linux', activeWord: 'inactive', existsSync: () => true }))).toMatchObject({ kind: 'systemd-user', active: false });
    expect((await detectSupervisorState(detectDeps({ platform: 'linux', activeWord: 'inactive' }))).kind).toBe('none');
  });
  it('none when systemctl does not exist', async () => {
    expect((await detectSupervisorState(detectDeps({ platform: 'linux' }))).kind).toBe('none');
  });
});

describe('B-1171: command construction (never executed here)', () => {
  it('status', () => {
    expect(statusCommand('launchd-agent', 501)).toEqual({ file: 'launchctl', args: ['print', `gui/501/${LAUNCHD_LABEL}`] });
    expect(statusCommand('systemd-user', 501)).toEqual({ file: 'systemctl', args: ['--user', 'is-active', SYSTEMD_UNIT] });
    expect(statusCommand('none', 501)).toBeNull();
  });
  it('stop unloads launchd jobs (so KeepAlive cannot restart) and stops the systemd unit; none is the caller\'s SIGTERM', () => {
    expect(stopCommands('launchd-agent', 501)).toEqual([{ file: 'launchctl', args: ['bootout', `gui/501/${LAUNCHD_LABEL}`] }]);
    expect(stopCommands('launchd-daemon', 501)).toEqual([{ file: 'sudo', args: ['launchctl', 'bootout', `system/${LAUNCHD_LABEL}`], interactive: true }]);
    expect(stopCommands('systemd-user', 501)).toEqual([{ file: 'systemctl', args: ['--user', 'stop', SYSTEMD_UNIT] }]);
    expect(stopCommands('none', 501)).toEqual([]);
  });
  it('restart: kickstart -k / systemctl restart; none is SIGTERM + launcher', () => {
    expect(restartCommands('launchd-agent', 501)[0].args).toEqual(['kickstart', '-k', `gui/501/${LAUNCHD_LABEL}`]);
    expect(restartCommands('launchd-daemon', 501)[0].args).toEqual(['launchctl', 'kickstart', '-k', `system/${LAUNCHD_LABEL}`]);
    expect(restartCommands('systemd-user', 501)[0].args).toEqual(['--user', 'restart', SYSTEMD_UNIT]);
    expect(restartCommands('none', 501)).toEqual([]);
  });
  it('install: bootstrap into gui/<uid>; sudo install + bootstrap system; daemon-reload then enable --now', () => {
    expect(installCommands('launchd-agent', 501, { agentPlist: '/p.plist' })).toEqual([{ file: 'launchctl', args: ['bootstrap', 'gui/501', '/p.plist'] }]);
    const d = installCommands('launchd-daemon', 501, { agentPlist: '/x', staged: '/tmp/s.plist' });
    expect(d[0].args).toEqual(['install', '-m', '644', '-o', 'root', '-g', 'wheel', '/tmp/s.plist', `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`]);
    expect(d[1].args).toEqual(['launchctl', 'bootstrap', 'system', `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`]);
    expect(installCommands('systemd-user', 501, { agentPlist: '' }).map((c) => c.args)).toEqual([['--user', 'daemon-reload'], ['--user', 'enable', '--now', SYSTEMD_UNIT]]);
  });
});

const R = { pluginDir: '/opt/harmony plugin', launcherArgs: ['--profile', 'gke'], home: '/Users/op', path: '/opt/homebrew/bin:/usr/bin', logPath: '/Users/op/.harmony/conductor.log' };

describe('B-1171: renderLaunchdPlist', () => {
  it('runs the launcher with the passthrough args, KeepAlive + RunAtLoad, HOME and PATH, no UserName for an agent', () => {
    const out = renderLaunchdPlist(plistTemplate, R);
    expect(out).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(out).toContain('<string>/bin/bash</string>');
    expect(out).toContain('<string>/opt/harmony plugin/container/conductor-launch.sh</string>');
    expect(out).toContain('<string>--profile</string>\n        <string>gke</string>');
    expect(out).toContain('<key>KeepAlive</key>\n    <true/>');
    expect(out).toContain('<key>HOME</key>\n        <string>/Users/op</string>');
    expect(out).toContain('<string>/opt/homebrew/bin:/usr/bin</string>');
    expect(out).not.toContain('UserName');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
  it('a LaunchDaemon carries UserName so it starts at boot as that user with that user\'s HOME', () => {
    const out = renderLaunchdPlist(plistTemplate, { ...R, userName: 'op' });
    expect(out).toContain('<key>UserName</key>\n    <string>op</string>');
    expect(out).toContain('<key>HOME</key>\n        <string>/Users/op</string>');
  });
  it('escapes XML metacharacters in values', () => {
    const out = renderLaunchdPlist(plistTemplate, { ...R, path: '/a&b:/c<d' });
    expect(out).toContain('/a&amp;b:/c&lt;d');
  });
  it('contains no credential placeholder or value', () => {
    expect(renderLaunchdPlist(plistTemplate, R)).not.toMatch(/REPLACE-ME|<key>HARMONY_API_TOKEN/);
  });
});

describe('B-1171: renderSystemdUnit', () => {
  it('quotes ExecStart words, sets PATH and HARMONY_PLUGIN_DIR, logs to the file, restarts always', () => {
    const out = renderSystemdUnit(unitTemplate, R);
    expect(out).toContain('ExecStart="/bin/bash" "/opt/harmony plugin/container/conductor-launch.sh" "--profile" "gke"');
    expect(out).toContain('Environment="PATH=/opt/homebrew/bin:/usr/bin"');
    expect(out).toContain('Environment="HARMONY_PLUGIN_DIR=/opt/harmony plugin"');
    expect(out).toContain('StandardOutput=append:/Users/op/.harmony/conductor.log');
    expect(out).toContain('Restart=always');
    expect(out).toContain('WantedBy=default.target');
    expect(out).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });
  it('systemdQuote escapes backslash, quote, % and (in ExecStart) $', () => {
    expect(systemdQuote('a"b\\c%d$e')).toBe('"a\\"b\\\\c%%d$e"');
    expect(systemdQuote('$HOME', true)).toBe('"$$HOME"');
  });
});

describe('B-1171: fillTemplate', () => {
  it('refuses a placeholder with no value rather than shipping a blank', () => {
    expect(() => fillTemplate('a {{X}} b', {})).toThrow(/\{\{X\}\}/);
    expect(fillTemplate('a {{X}} b', { X: '1' })).toBe('a 1 b');
  });
});
