// B-1076: the filesystem half of the Codex adapter (provisionCodex) and its CLI surface
// (`harmony agent render | capability | argv | check-credentials` against the real built CLI).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectInstructionSources, provisionCodex } from './codex-provision.js';
import { decodeNulArgv } from './launch-routing.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'dist', 'bin', 'harmony.js');
const SENTINEL = 'AUTH-JSON-SENTINEL-must-never-be-printed-9f3a';

let dir: string;
let ws: string;
let plugin: string;
let home: string;
let auth: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'b1076-prov-'));
  ws = join(dir, 'workspace');
  plugin = join(ws, 'plugin');
  home = join(dir, 'home', '.codex');
  mkdirSync(join(plugin, 'skills', 'demo'), { recursive: true });
  mkdirSync(join(ws, 'web'), { recursive: true });
  mkdirSync(join(ws, '.git', 'info'), { recursive: true });
  writeFileSync(join(ws, 'CLAUDE.md'), 'WS-GUIDANCE\n');
  writeFileSync(join(plugin, 'CLAUDE.md'), 'PLUGIN-GUIDANCE\n');
  writeFileSync(join(ws, 'web', 'CLAUDE.md'), 'WEB-GUIDANCE\n');
  auth = join(dir, 'mounted-auth.json');
  writeFileSync(auth, `{"tokens":{"refresh_token":"${SENTINEL}"}}`, { mode: 0o640 });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const input = () => ({ pluginDir: plugin, workspaceDir: ws, codexHome: home, authFile: auth });

describe('provisionCodex', () => {
  it('renders config.toml, ONE AGENTS.md of all three guidance files, the skills link, and copies the login cache in at 0600', () => {
    const r = provisionCodex(input());
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    expect(config).toContain('required = true');
    expect(config).toContain(`args = ["${plugin}/dist/index.js"]`);

    const md = readFileSync(join(ws, 'AGENTS.md'), 'utf8');
    for (const marker of ['WS-GUIDANCE', 'PLUGIN-GUIDANCE', 'WEB-GUIDANCE', 'Codex worker overlay']) expect(md).toContain(marker);
    expect(md.indexOf('WS-GUIDANCE')).toBeLessThan(md.indexOf('PLUGIN-GUIDANCE'));
    expect(md.indexOf('PLUGIN-GUIDANCE')).toBeLessThan(md.indexOf('WEB-GUIDANCE'));
    expect(r.sources).toEqual(['workspace/CLAUDE.md', 'plugin/CLAUDE.md', 'web/CLAUDE.md']);

    const link = join(ws, '.agents', 'skills');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(plugin, 'skills'));

    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, 'auth.json'), 'utf8')).toContain(SENTINEL);
    expect(r.authInstalledAt).toBe(join(home, 'auth.json'));
  });

  it('keeps the generated files out of git status', () => {
    provisionCodex(input());
    provisionCodex(input()); // idempotent
    const exclude = readFileSync(join(ws, '.git', 'info', 'exclude'), 'utf8').split('\n');
    expect(exclude.filter((l) => l === 'AGENTS.md')).toHaveLength(1);
    expect(exclude).toContain('.agents/');
  });

  it('is idempotent: a re-render overwrites its own AGENTS.md and re-points a stale skills link', () => {
    provisionCodex(input());
    writeFileSync(join(ws, 'CLAUDE.md'), 'WS-CHANGED\n');
    provisionCodex(input());
    expect(readFileSync(join(ws, 'AGENTS.md'), 'utf8')).toContain('WS-CHANGED');
  });

  it("never overwrites a repository's own AGENTS.md or a real .agents/skills directory", () => {
    writeFileSync(join(ws, 'AGENTS.md'), '# hand-written\n');
    expect(() => provisionCodex(input())).toThrow(/not a generated file/);
    rmSync(join(ws, 'AGENTS.md'));
    mkdirSync(join(ws, '.agents', 'skills'), { recursive: true });
    expect(() => provisionCodex(input())).toThrow(/not a symlink/);
  });

  it('FAILS when the login-cache file is missing — and names the path, not any content', () => {
    let msg = '';
    try {
      provisionCodex({ ...input(), authFile: join(dir, 'nope.json') });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('login-cache file is missing');
    expect(msg).toContain('nope.json');
    expect(msg).not.toContain(SENTINEL);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
  });

  it('accepts the login cache already sitting at <codexHome>/auth.json (the read-write mount form)', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'auth.json'), 'x', { mode: 0o644 });
    provisionCodex({ ...input(), authFile: join(home, 'auth.json') });
    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('includes extra repos (HARMONY_REPOS_JSON) after the three fixed sources, and skips missing files', () => {
    const extra = join(dir, 'other-repo');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'CLAUDE.md'), 'OTHER-GUIDANCE\n');
    const labels = collectInstructionSources({ pluginDir: plugin, workspaceDir: ws, extraRepoPaths: [extra, join(dir, 'absent')] }).map((s) => s.label);
    expect(labels).toHaveLength(4);
    expect(labels[3]).toMatch(/other-repo\/CLAUDE\.md$/);
  });
});

// --- the CLI, against the real built bundle (CI builds dist before the tests, as launch-routing.test.ts) ---

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const r = spawnSync('node', [CLI, ...args], {
    env: { PATH: process.env.PATH, HOME: dir, ...env },
    encoding: 'buffer',
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
}
const CODEX_RC = Buffer.from('{"agent":{"adapter":"codex"}}').toString('base64');

describe('harmony agent … against the Codex adapter (real CLI)', () => {
  const codexEnv = (extra: Record<string, string> = {}) => ({ HARMONY_RUN_CONFIG_JSON: CODEX_RC, ...extra });

  it('resolve / binary name codex', () => {
    expect(cli(['agent', 'resolve'], codexEnv()).stdout.toString()).toBe('codex\n');
    expect(cli(['agent', 'binary'], codexEnv()).stdout.toString()).toBe('codex\n');
  });

  it('argv is the Codex launch command (binary first, prompt translated, NUL-separated)', () => {
    const r = cli(['agent', 'argv', '--plugin-dir', '/workspace/workspace/plugin', '--prompt', '/harmony-plugin:harmony-conduct B-1 --one-shot', '--model', 'm', '--'], codexEnv());
    expect(r.status).toBe(0);
    expect(decodeNulArgv(r.stdout.toString())).toEqual([
      'codex', 'exec', '--json', '--cd', '/workspace/workspace', '--add-dir', '/workspace/workspace/plugin',
      '--dangerously-bypass-approvals-and-sandbox', '-m', 'm', '$harmony-plugin:harmony-conduct B-1 --one-shot',
    ]);
  });

  it('check-credentials: the login-cache path resolves; OPENAI_API_KEY / CODEX_API_KEY REFUSE the start; none refuses too', () => {
    const ok = cli(['agent', 'check-credentials'], codexEnv({ HARMONY_CODEX_AUTH_FILE: auth }));
    expect(ok.status).toBe(0);
    expect(ok.stdout.toString()).toBe('login-cache\n');
    for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY']) {
      const r = cli(['agent', 'check-credentials'], codexEnv({ HARMONY_CODEX_AUTH_FILE: auth, [name]: 'sk-should-not-echo-0123456789' }));
      expect(r.status).toBe(1);
      expect(r.stdout.length).toBe(0);
      expect(r.stderr).toContain('Refusing to start:');
      expect(r.stderr).toContain(name);
      expect(r.stderr).not.toContain('sk-should-not-echo');
    }
    expect(cli(['agent', 'check-credentials'], codexEnv()).status).toBe(1);
  });

  it('capability: Codex declares no subagents and no model switch; Claude declares both', () => {
    const q = (name: string, env: Record<string, string>) => cli(['agent', 'capability', name], env).stdout.toString().trim();
    expect(q('subagents', codexEnv())).toBe('false');
    expect(q('modelSwitch', codexEnv())).toBe('false');
    expect(q('mcp', codexEnv())).toBe('true');
    expect(q('subagents', {})).toBe('true');
    expect(q('modelSwitch', {})).toBe('true');
    const bad = cli(['agent', 'capability', 'telepathy'], {});
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Refusing to start:');
  });

  it('render provisions everything and never prints the login cache content', () => {
    const r = cli(['agent', 'render', '--plugin-dir', plugin, '--workspace', ws, '--codex-home', home], codexEnv({ HARMONY_CODEX_AUTH_FILE: auth }));
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(0);
    expect(r.stderr).not.toContain(SENTINEL);
    expect(r.stderr).toContain('login cache installed at');
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(true);
    expect(statSync(join(home, 'auth.json')).mode & 0o777).toBe(0o600);
  });

  it('render refuses to start (exit 1) when HARMONY_CODEX_AUTH_FILE is unset or the file is missing', () => {
    const unset = cli(['agent', 'render', '--plugin-dir', plugin, '--workspace', ws, '--codex-home', home], codexEnv());
    expect(unset.status).toBe(1);
    expect(unset.stderr).toContain('Refusing to start:');
    const missing = cli(['agent', 'render', '--plugin-dir', plugin, '--workspace', ws, '--codex-home', home], codexEnv({ HARMONY_CODEX_AUTH_FILE: join(dir, 'gone.json') }));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('login-cache file is missing');
  });

  it('render is a no-op for claude-code', () => {
    const r = cli(['agent', 'render', '--plugin-dir', plugin, '--workspace', ws, '--codex-home', home], {});
    expect(r.status).toBe(0);
    expect(existsSync(join(ws, 'AGENTS.md'))).toBe(false);
  });
});
