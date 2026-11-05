import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../container/pinned-node-smoke.sh', import.meta.url));
function probe(failDownloads: number, failExecution = false) {
  const root = mkdtempSync(join(tmpdir(), 'b1399-smoke-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  mkdirSync(bin); mkdirSync(home);
  const log = join(root, 'calls');
  writeFileSync(log, '');
  const stub = (name: string, body: string) => writeFileSync(join(bin, name), '#!/usr/bin/env bash\n' + body + '\n', { mode: 0o755 });
  // Exercise the real streamed archive and scripts. Only Docker/network tooling
  // is replaced; runtime image evidence is recorded separately on the ticket.
  stub('docker', 'exec bash -euo pipefail -c "${@: -1}"');
  stub('sleep', 'echo sleep >> "$PROBE_LOG"');
  stub('fnm', `echo "$1" >> "$PROBE_LOG"
case "$1" in
  env) echo ':' ;;
  current) echo v26.13.0 ;;
  install) n=$(cat "$PROBE_COUNT" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "$PROBE_COUNT"; [ "$n" -gt ${failDownloads} ] ;;
  *) exit 0 ;;
esac`);
  stub('node', failExecution ? 'echo "missing libatomic.so.1" >&2; exit 127' : 'echo v26.13.0');
  const result = spawnSync('bash', [script, 'fixture-image'], {
    env: { ...process.env, HOME: home, FNM_DIR: join(home, '.fnm'), PATH: `${bin}:${process.env.PATH}`, PROBE_LOG: log, PROBE_COUNT: join(root, 'count') },
    encoding: 'utf8',
  });
  return { status: result.status, output: result.stdout + result.stderr, calls: readFileSync(log, 'utf8').trim().split('\n') };
}

describe('pinned Node publication smoke', () => {
  it('retries two failed downloads, then validates once and checks a later shell', () => {
    const r = probe(2);
    expect(r.status).toBe(0);
    expect(r.calls.filter(c => c === 'install')).toHaveLength(3);
    expect(r.calls.filter(c => c === 'use')).toHaveLength(1);
    expect(r.calls.filter(c => c === 'sleep')).toHaveLength(2);
    expect(r.output).toContain('PASS — pinned Node v26.13.0 runs in a later shell');
  });
  it('rejects exhausted downloads with a distinct diagnostic and never activates', () => {
    const r = probe(3);
    expect(r.status).not.toBe(0);
    expect(r.calls.filter(c => c === 'install')).toHaveLength(3);
    expect(r.calls).not.toContain('use');
    expect(r.output).toContain('DOWNLOAD FAILED after 3 attempts');
    expect(r.output).not.toContain('PASS');
  });
  it('does not retry execution failures or confuse them with downloads', () => {
    const r = probe(0, true);
    expect(r.status).not.toBe(0);
    expect(r.calls.filter(c => c === 'install')).toHaveLength(1);
    expect(r.calls.filter(c => c === 'use')).toHaveLength(1);
    expect(r.output).toContain('missing libatomic.so.1');
    expect(r.output).toContain('ACTIVATION FAILED');
    expect(r.output).not.toContain('DOWNLOAD FAILED');
  });
  it('both publication entry scripts invoke the shared probe', () => {
    for (const relative of ['../../container/smoke.sh', '../../container/docker-engine/smoke.sh']) {
      expect(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')).toMatch(/bash .*pinned-node-smoke\.sh.*"\$IMAGE"/);
    }
  });
});
