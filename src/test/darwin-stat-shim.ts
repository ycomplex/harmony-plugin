// B-1030: test-only shim so the provision.sh / entrypoint.sh contract suites run on a developer Mac.
// The worker scripts call GNU `stat -c '%Y'` / `stat -c '%s'`; macOS's BSD stat rejects `-c`, the
// scripts' `|| echo 0` fallback turns every mtime and size into 0, and resume discovery finds
// nothing. The shim translates exactly those two forms to BSD `-f %m` / `-f %z` and passes every
// other invocation through to the real stat unchanged.
//
// On Linux (CI, cloud workers) the shim is NEVER installed, so CI still exercises real GNU stat.

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

export const STAT_SHIM_SCRIPT = [
  '#!/bin/sh',
  '# B-1030: test-only shim. The worker scripts use GNU stat -c; macOS\'s BSD stat rejects -c.',
  'real="${HARMONY_REAL_STAT:-/usr/bin/stat}"',
  'if [ "$1" = "-c" ]; then',
  '  case "$2" in',
  '    %Y) shift 2; exec "$real" -f %m "$@" ;;',
  '    %s) shift 2; exec "$real" -f %z "$@" ;;',
  '  esac',
  'fi',
  'exec "$real" "$@"',
  '',
].join('\n');

/** Writes the shim as `<dir>/stat` (mode 755) and returns `dir`. */
export function writeStatShim(dir: string): string {
  const shimPath = join(dir, 'stat');
  writeFileSync(shimPath, STAT_SHIM_SCRIPT);
  chmodSync(shimPath, 0o755);
  return dir;
}

/** On darwin, writes the shim to a fresh temp dir, prepends it to `process.env.PATH`, and returns
 *  the dir. On every other platform it does nothing and returns null — Linux CI keeps real GNU stat. */
export function installDarwinStatShim(): string | null {
  if (process.platform !== 'darwin') return null;
  const dir = writeStatShim(mkdtempSync(join(tmpdir(), 'b1030-stat-shim-')));
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  return dir;
}
