// B-1076: nothing in this repo reads, cats or logs the Codex login-cache file (auth.json).
//
// The cache holds a bearer access token, a refresh token and an id token. The adapter's contract is that
// the secret never enters env, argv or a log: the AuthSeam carries only a PATH (HARMONY_CODEX_AUTH_FILE),
// resolveCredential never opens it, the launcher streams it over ssh stdin (never via a command line), and
// the one place bytes move is the adapter's own fs.copyFileSync. This test scans every shell script and
// every non-test source file that mentions the file and fails on a content-reading verb applied to it, or
// on tracing that would print it. Each rule has a positive control.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === '.worktrees') return [];
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p, accept);
    return accept(name) ? [p] : [];
  });
}

/** A line is about the credential file when it names the file, the path variable, or a variable the scripts
 *  derive from them (the launcher's CODEX_AUTH_* family, the adapter's `authFile`). */
const MENTIONS = /auth\.json|HARMONY_CODEX_AUTH|CODEX_AUTH_|\bauthFile\b|codex-auth/;

// shell: a verb that reads or prints a file's CONTENT, applied on a line that names the credential file.
// `cat >` / `cat > "dest"` is a stdin->file sink (ssh stdin shipping), not a read of the credential.
const SHELL_READERS = /(?<![\w-])(?:cat(?!\s*>)|head|tail|less|more|jq|base64|xxd|od|hexdump|strings|grep|awk|sed|tee|source|eval|openssl|sha\d*sum|md5sum|cksum)(?![\w-])|^\s*\.\s/;
const SHELL_TRACING = /set\s+-[a-z]*x|bash\s+-[a-z]*x|xtrace|--verbose/;
// echo / printf are fine for a MESSAGE that names the path; they are not fine when they print the bare value.
const SHELL_BARE_PRINT = /(?:echo|printf)\s+(?:-[a-z]+\s+)?(?:'%s\\?n?'\s+)?"?\$\{?(?:HARMONY_CODEX_AUTH_FILE|CODEX_AUTH_[A-Z_]+)\}?"?\s*(?:[>|;]|$)/;

const TS_READERS = /readFile(?:Sync)?|createReadStream|openSync|readSync|\.readFile\(|fs\.promises\.read/;
const TS_PRINTERS = /console\.(?:log|error|warn|info|debug)\([^)]*\b(?:authFile|AUTH_FILE)\b[^)]*\)|process\.std(?:out|err)\.write\([^)]*\bauthFile\b/;

export function shellViolations(script: string): string[] {
  const out: string[] = [];
  const lines = script.split('\n');
  if (MENTIONS.test(script) && lines.some((l) => !/^\s*#/.test(l) && SHELL_TRACING.test(l))) out.push('shell tracing is on in a script that handles the credential file');
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l) || !MENTIONS.test(l)) return;
    // strip quoted prose so a word inside a message ("... see the head of ...") is not mistaken for a verb
    const code = l.replace(/"[^"$]*"/g, '""').replace(/'[^']*'/g, "''");
    if (SHELL_READERS.test(code)) out.push(`line ${i + 1}: reads/derives from the credential file: ${l.trim()}`);
    if (SHELL_BARE_PRINT.test(l)) out.push(`line ${i + 1}: prints the credential path variable bare: ${l.trim()}`);
  });
  return out;
}

export function tsViolations(source: string): string[] {
  const out: string[] = [];
  source.split('\n').forEach((l, i) => {
    if (/^\s*(?:\/\/|\*|\/\*)/.test(l) || !MENTIONS.test(l)) return;
    if (TS_READERS.test(l)) out.push(`line ${i + 1}: reads the credential file: ${l.trim()}`);
    if (TS_PRINTERS.test(l)) out.push(`line ${i + 1}: logs the credential file: ${l.trim()}`);
  });
  return out;
}

const scripts = walk(ROOT, (n) => n.endsWith('.sh') || n.endsWith('.mjs')).filter((p) => !/\.test\./.test(p));
const sources = walk(join(ROOT, 'src'), (n) => n.endsWith('.ts') && !n.endsWith('.test.ts'));

describe('no script or source reads, cats or logs the Codex login cache', () => {
  it('scans a meaningful set (positive control on the walk)', () => {
    expect(scripts.some((p) => p.endsWith('container/provision.sh'))).toBe(true);
    expect(scripts.some((p) => p.endsWith('container/docker-host-worker-launch.sh'))).toBe(true);
    expect(sources.some((p) => p.endsWith('src/agents/codex-provision.ts'))).toBe(true);
    const touching = [...scripts, ...sources].filter((p) => MENTIONS.test(readFileSync(p, 'utf8')));
    expect(touching.length).toBeGreaterThanOrEqual(3);
  });

  it.each(scripts.map((p) => [p.slice(ROOT.length), p]))('shell: %s', (_name, path) => {
    expect(shellViolations(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it.each(sources.map((p) => [p.slice(ROOT.length), p]))('source: %s', (_name, path) => {
    expect(tsViolations(readFileSync(path, 'utf8'))).toEqual([]);
  });

  it('the recorded-output path redacts bearer / refresh-token shapes before bounding the tail', () => {
    const src = readFileSync(join(ROOT, 'src/cli/commands/leg-output.ts'), 'utf8');
    expect(src).toContain("from '../../agents/redaction.js'");
    expect(src).toMatch(/const storedText = redactSecrets\(/);
  });

  it('the adapter resolves the credential from env without opening the file', () => {
    const src = readFileSync(join(ROOT, 'src/agents/codex.ts'), 'utf8');
    expect(src).not.toMatch(/from 'node:fs'/);
  });
});

describe('the scan catches a violation (positive controls)', () => {
  it.each([
    'cat "$HARMONY_CODEX_AUTH_FILE"',
    'jq . "$CODEX_AUTH_SRC"',
    'head -c 10 ~/.codex/auth.json',
    'base64 < "$CODEX_AUTH_SRC"',
    'TOKEN="$(grep refresh_token /home/worker/.codex/auth.json)"',
    'echo "$HARMONY_CODEX_AUTH_FILE"',
    'printf \'%s\\n\' "$CODEX_AUTH_SRC"',
    'set -x; cp "$CODEX_AUTH_SRC" "$HOME/.codex/auth.json"',
    'bash -x launch.sh # uses HARMONY_CODEX_AUTH_FILE',
  ])('shell flags %s', (line) => {
    expect(shellViolations(line)).not.toEqual([]);
  });

  it.each([
    'dh_ssh_setup "$CODEX_AUTH_SRC" "umask 077; cat > \\"$REMOTE_RUN/codex-auth.json\\""',
    'echo "launcher: login-cache file is missing at $CODEX_AUTH_SRC" >&2',
    '[ -f "$CODEX_AUTH_SRC" ] || exit 1',
    '# cat "$HARMONY_CODEX_AUTH_FILE" would be wrong',
    'install -m 600 "$CODEX_AUTH_SRC" "$HOME/.codex/auth.json"',
  ])('shell allows %s', (line) => {
    expect(shellViolations(line)).toEqual([]);
  });

  it.each([
    'const raw = readFileSync(authFile, "utf8");',
    'const s = fs.readFileSync(join(codexHome, "auth.json"));',
    'console.error(`using ${authFile}`);',
  ])('source flags %s', (line) => {
    expect(tsViolations(line)).not.toEqual([]);
  });

  it.each(['copyFileSync(authFile, dest);', 'if (!isFile(authFile)) throw new Error(`missing at ${authFile}`);', '// readFileSync(authFile) would be wrong'])('source allows %s', (line) => {
    expect(tsViolations(line)).toEqual([]);
  });
});
