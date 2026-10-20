// B-1171: container/conductor-launch.sh EXECUTED from disk with a stub `node` first on PATH. The stub records
// the argv and environment it was exec'd with, so the test proves: the env file is loaded (conductor.env
// first, the legacy daemon.env with ONE rename hint), values are never printed, and the passthrough args reach
// node. (That it `exec`s node, keeping the supervisor's pid, is the last line of the script.)

import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoPath = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const launcher = repoPath('container/conductor-launch.sh');
const bashPath = (() => {
  try {
    return execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
})();

function world(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'b1171-launch-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  mkdirSync(join(home, '.harmony'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(home, '.harmony', name), body);
  writeFileSync(join(bin, 'node'), ['#!/usr/bin/env bash', 'printf "%s\\n" "$@" > "$STUB_OUT/argv"', 'env > "$STUB_OUT/env"', 'echo $$ > "$STUB_OUT/pid"', ''].join('\n'), { mode: 0o755 });
  return { dir, home, bin };
}

function run(w: ReturnType<typeof world>, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(bashPath!, [launcher, ...args], {
    encoding: 'utf8',
    env: { PATH: `${w.bin}:${process.env.PATH}`, HOME: w.home, STUB_OUT: w.dir, ...env },
  });
  const read = (n: string) => { try { return readFileSync(join(w.dir, n), 'utf8'); } catch { return null; } };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, argv: read('argv'), env: read('env'), pid: read('pid') };
}

describe.skipIf(!bashPath)('container/conductor-launch.sh (EXECUTED against a stub node)', () => {
  it('passes bash -n and is executable', () => {
    expect(spawnSync(bashPath!, ['-n', launcher]).status).toBe(0);
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
  });

  it('loads conductor.env, never prints its values, and execs node <checkout>/dist/bin/daemon.js with the passthrough args', () => {
    const w = world({ 'conductor.env': "HARMONY_API_TOKEN=tok-s3cret-value\nCUSTOM='a b'\n" });
    const r = run(w, ['--profile', 'gke', '--config', '/x/deployment.json']);
    expect(r.status).toBe(0);
    expect(r.argv!.split('\n').filter(Boolean)).toEqual([repoPath('dist/bin/daemon.js').replace(/\/$/, ''), '--profile', 'gke', '--config', '/x/deployment.json']);
    const env = r.env!.split('\n');
    expect(env).toContain('HARMONY_API_TOKEN=tok-s3cret-value');
    expect(env).toContain('CUSTOM=a b');
    expect(env).toContain(`HARMONY_PLUGIN_DIR=${repoPath('').replace(/\/$/, '')}`);
    expect(r.stdout + r.stderr).not.toContain('tok-s3cret-value');
    expect(r.stdout).not.toContain('daemon.env');
  });

  it('prefers conductor.env over the legacy daemon.env and prints nothing about it', () => {
    const w = world({ 'conductor.env': 'WHICH=new\n', 'daemon.env': 'WHICH=legacy\n' });
    const r = run(w);
    expect(r.env!.split('\n')).toContain('WHICH=new');
    expect(r.stdout).toBe('');
  });

  it('reads only a legacy daemon.env when that is all there is, and prints ONE rename hint', () => {
    const w = world({ 'daemon.env': 'WHICH=legacy\nHARMONY_API_TOKEN=tok-legacy-s3cret\n' });
    const r = run(w);
    expect(r.status).toBe(0);
    expect(r.env!.split('\n')).toContain('WHICH=legacy');
    expect(r.stdout.trim().split('\n')).toEqual(['conductor-launch: reading ~/.harmony/daemon.env — rename it to ~/.harmony/conductor.env']);
    expect(r.stdout + r.stderr).not.toContain('tok-legacy-s3cret');
  });

  it('HARMONY_HOME replaces ~/.harmony', () => {
    const w = world({});
    const other = join(w.dir, 'elsewhere');
    mkdirSync(other);
    writeFileSync(join(other, 'conductor.env'), 'WHICH=from-harmony-home\n');
    const r = run(w, [], { HARMONY_HOME: other });
    expect(r.env!.split('\n')).toContain('WHICH=from-harmony-home');
  });

  it('refuses a syntactically invalid env file without quoting a line of it', () => {
    const w = world({ 'conductor.env': 'TOKEN="unterminated-s3cret\n' });
    const r = run(w);
    expect(r.status).toBe(1);
    expect(r.argv).toBeNull();
    expect(r.stderr).toContain('not valid shell syntax');
    expect(r.stdout + r.stderr).not.toContain('unterminated-s3cret');
  });

  it('runs with no env file at all (the inherited environment only)', () => {
    const w = world({});
    const r = run(w, [], { INHERITED: 'yes' });
    expect(r.status).toBe(0);
    expect(r.env!.split('\n')).toContain('INHERITED=yes');
  });
});
