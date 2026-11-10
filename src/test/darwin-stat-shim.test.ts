import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { STAT_SHIM_SCRIPT, installDarwinStatShim, writeStatShim } from './darwin-stat-shim.js';

// B-1030: these run on Linux. A fake "real stat" prints its argv one per line, so each case
// asserts exactly what the shim forwarded.
describe('B-1030 darwin stat shim', () => {
  const shimDir = writeStatShim(mkdtempSync(join(tmpdir(), 'b1030-shim-test-')));
  const fakeDir = mkdtempSync(join(tmpdir(), 'b1030-fake-stat-'));
  const fakeStat = join(fakeDir, 'fake-stat');
  writeFileSync(fakeStat, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done\n', { mode: 0o755 });

  const runShim = (args: string[]): string[] =>
    execFileSync(join(shimDir, 'stat'), args, {
      env: { ...process.env, HARMONY_REAL_STAT: fakeStat },
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line !== '');

  it('writes the script verbatim', () => {
    expect(STAT_SHIM_SCRIPT.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('translates -c %Y to -f %m', () => {
    expect(runShim(['-c', '%Y', 'FILE'])).toEqual(['-f', '%m', 'FILE']);
  });

  it('translates -c %s to -f %z', () => {
    expect(runShim(['-c', '%s', 'FILE'])).toEqual(['-f', '%z', 'FILE']);
  });

  it('passes any other -c format through unchanged', () => {
    expect(runShim(['-c', '%n', 'FILE'])).toEqual(['-c', '%n', 'FILE']);
  });

  it('passes non -c invocations through unchanged', () => {
    expect(runShim(['-L', 'FILE'])).toEqual(['-L', 'FILE']);
  });

  it.skipIf(process.platform === 'darwin')('installDarwinStatShim() is a no-op off darwin', () => {
    const before = process.env.PATH;
    expect(installDarwinStatShim()).toBeNull();
    expect(process.env.PATH).toBe(before);
  });
});
