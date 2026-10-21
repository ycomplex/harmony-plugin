// B-808: `hooks/link-cli.sh`, executed FOR REAL against a temp HOME / HARMONY_HOME / HARMONY_BIN_DIR (never a
// retyped copy). Proves: the wrapper + pointer are created and the wrapper runs a stub dist/bin/harmony.js; a
// second run changes nothing; a foreign `harmony` is never clobbered; the PATH hint appears only when the bin dir
// is off PATH; a plugin update repoints the pointer; no shell profile is touched; the exit code is always 0.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../hooks/link-cli.sh', import.meta.url));
const NODE_DIR = join(process.execPath, '..');

interface Sandbox {
  home: string;
  harmonyHome: string;
  binDir: string;
  pluginA: string;
  pluginB: string;
}

function plugin(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, 'dist', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'bin', 'harmony.js'), `console.log('stub ${name}: ' + process.argv.slice(2).join(' '));\n`);
  return dir;
}

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'b808-'));
  const home = join(root, 'home');
  mkdirSync(home);
  return { home, harmonyHome: join(home, '.harmony'), binDir: join(home, '.local', 'bin'), pluginA: plugin(root, 'plugin-a'), pluginB: plugin(root, 'plugin-b') };
}

function run(sb: Sandbox, over: Record<string, string | undefined> = {}) {
  const r = spawnSync('sh', [scriptPath], {
    encoding: 'utf8',
    env: {
      PATH: `${sb.binDir}:${NODE_DIR}:/usr/bin:/bin`,
      HOME: sb.home,
      HARMONY_HOME: sb.harmonyHome,
      HARMONY_BIN_DIR: sb.binDir,
      CLAUDE_PLUGIN_ROOT: sb.pluginA,
      ...over,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const wrapper = (sb: Sandbox) => join(sb.binDir, 'harmony');
const pointer = (sb: Sandbox) => join(sb.harmonyHome, 'plugin-root');

describe('hooks/link-cli.sh', () => {
  it('first run creates the pointer and a wrapper that runs the plugin CLI with its args', () => {
    const sb = sandbox();
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('');
    expect(readFileSync(pointer(sb), 'utf8')).toBe(`${sb.pluginA}\n`);
    expect(readFileSync(wrapper(sb), 'utf8').split('\n')[1]).toBe('# harmony-plugin-shim v1');
    expect(statSync(wrapper(sb)).mode & 0o111).not.toBe(0);
    const out = spawnSync(wrapper(sb), ['tasks', 'list', '--json'], { encoding: 'utf8', env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HARMONY_HOME: sb.harmonyHome, HOME: sb.home } });
    expect(out.status).toBe(0);
    expect(out.stdout).toBe('stub plugin-a: tasks list --json\n');
  });

  it('second run is a no-op', () => {
    const sb = sandbox();
    run(sb);
    const before = { w: statSync(wrapper(sb)), p: statSync(pointer(sb)), wt: readFileSync(wrapper(sb), 'utf8') };
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(statSync(wrapper(sb)).ino).toBe(before.w.ino);
    expect(statSync(pointer(sb)).ino).toBe(before.p.ino);
    expect(readFileSync(wrapper(sb), 'utf8')).toBe(before.wt);
    expect(readdirSync(sb.binDir)).toEqual(['harmony']);
    expect(readdirSync(sb.harmonyHome)).toEqual(['plugin-root']);
  });

  it('a foreign pre-existing harmony is not overwritten and a notice is printed', () => {
    const sb = sandbox();
    mkdirSync(sb.binDir, { recursive: true });
    writeFileSync(wrapper(sb), '#!/bin/sh\necho mine\n');
    chmodSync(wrapper(sb), 0o755);
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(readFileSync(wrapper(sb), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(r.stderr).toContain('left untouched');
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('a symlink at the wrapper path is left alone too', () => {
    const sb = sandbox();
    mkdirSync(sb.binDir, { recursive: true });
    const target = join(sb.home, 'elsewhere');
    writeFileSync(target, '#!/bin/sh\n# harmony-plugin-shim v1\n');
    symlinkSync(target, wrapper(sb));
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('left untouched');
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n# harmony-plugin-shim v1\n');
  });

  it('a wrapper with an older marker version is rewritten', () => {
    const sb = sandbox();
    mkdirSync(sb.binDir, { recursive: true });
    writeFileSync(wrapper(sb), '#!/bin/sh\n# harmony-plugin-shim v0\nexit 1\n');
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(readFileSync(wrapper(sb), 'utf8')).toContain('exec node');
  });

  it('prints the PATH hint when the bin dir is off PATH, and not when it is on PATH', () => {
    const sb = sandbox();
    const off = run(sb, { PATH: `${NODE_DIR}:/usr/bin:/bin` });
    expect(off.status).toBe(0);
    expect(off.stderr).toContain(`export PATH="${sb.binDir}:$PATH"`);
    expect(off.stderr.trim().split('\n')).toHaveLength(1);
    const on = run(sb);
    expect(on.stderr).toBe('');
  });

  it('repoints the pointer when CLAUDE_PLUGIN_ROOT changes, leaving the wrapper alone', () => {
    const sb = sandbox();
    run(sb);
    const ino = statSync(wrapper(sb)).ino;
    const r = run(sb, { CLAUDE_PLUGIN_ROOT: sb.pluginB });
    expect(r.status).toBe(0);
    expect(readFileSync(pointer(sb), 'utf8')).toBe(`${sb.pluginB}\n`);
    expect(statSync(wrapper(sb)).ino).toBe(ino);
    const out = spawnSync(wrapper(sb), ['x'], { encoding: 'utf8', env: { PATH: `${NODE_DIR}:/usr/bin:/bin`, HARMONY_HOME: sb.harmonyHome, HOME: sb.home } });
    expect(out.stdout).toBe('stub plugin-b: x\n');
  });

  it('falls back to its own directory when CLAUDE_PLUGIN_ROOT is unset', () => {
    const sb = sandbox();
    const r = run(sb, { CLAUDE_PLUGIN_ROOT: undefined });
    expect(r.status).toBe(0);
    expect(readFileSync(pointer(sb), 'utf8')).toBe(`${join(scriptPath, '..', '..')}\n`);
  });

  it('never creates or modifies a shell profile', () => {
    const sb = sandbox();
    run(sb, { PATH: `${NODE_DIR}:/usr/bin:/bin` });
    run(sb, { PATH: `${NODE_DIR}:/usr/bin:/bin`, CLAUDE_PLUGIN_ROOT: sb.pluginB });
    for (const f of ['.zshrc', '.bashrc', '.profile', '.bash_profile', '.zprofile']) expect(existsSync(join(sb.home, f))).toBe(false);
    expect(readdirSync(sb.home).sort()).toEqual(['.harmony', '.local']);
  });

  it('wrapper errors are one clear line when the pointer or target is missing', () => {
    const sb = sandbox();
    run(sb);
    const env = { PATH: `${NODE_DIR}:/usr/bin:/bin`, HARMONY_HOME: sb.harmonyHome, HOME: sb.home };
    writeFileSync(pointer(sb), `${join(sb.home, 'gone')}\n`);
    const gone = spawnSync(wrapper(sb), [], { encoding: 'utf8', env });
    expect(gone.status).toBe(127);
    expect(gone.stderr).toMatch(/^harmony: .* not found/);
    const none = spawnSync(wrapper(sb), [], { encoding: 'utf8', env: { ...env, HARMONY_HOME: join(sb.home, 'nope') } });
    expect(none.status).toBe(127);
    expect(none.stderr).toContain('no plugin pointer');
  });

  it('exits 0 with at most one line even when the bin dir is unwritable', () => {
    const sb = sandbox();
    writeFileSync(join(sb.home, '.local'), 'a file, so the bin dir cannot be created');
    const r = run(sb);
    expect(r.status).toBe(0);
    expect(r.stderr.trim().split('\n')).toHaveLength(1);
    expect(r.stderr).toContain('could not create');
    // and an unwritable harmony home
    const sb2 = sandbox();
    writeFileSync(sb2.harmonyHome, 'a file');
    const r2 = run(sb2);
    expect(r2.status).toBe(0);
    expect(r2.stderr.trim().split('\n')).toHaveLength(1);
  });
});
