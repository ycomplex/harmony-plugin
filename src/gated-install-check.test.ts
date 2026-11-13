// B-1477: scripts/gated-install-check.sh — its argument handling, offline. The real run (against a gated download,
// with a token) is recorded in docs/gated-download-walk.md; these cases all exit before any network call.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/gated-install-check.sh', import.meta.url));
const BASE = 'https://download.example.test/plugin-download';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function tmp() { const d = mkdtempSync(join(tmpdir(), 'b1477-check-')); roots.push(d); return d; }

function run(args: string[]): { status: number; output: string } {
  try {
    const output = execFileSync('bash', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe', timeout: 10000 });
    return { status: 0, output };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status, output: `${e.stdout}${e.stderr}` };
  }
}

function tokenFile(content: string): string {
  const f = join(tmp(), 'token');
  writeFileSync(f, content, { mode: 0o600 });
  return f;
}

describe('gated-install-check.sh usage errors (exit 2, offline)', () => {
  it('is executable', () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it('refuses an unknown argument', () => {
    const r = run(['--bogus']);
    expect(r.status).toBe(2);
    expect(r.output).toContain('unknown argument --bogus');
  });

  it('requires --base', () => {
    const r = run(['--token-file', tokenFile('t')]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('--base');
  });

  it('requires --token-file', () => {
    const r = run(['--base', BASE]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('--token-file');
  });

  it('refuses a missing token file', () => {
    const r = run(['--base', BASE, '--token-file', join(tmp(), 'absent')]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('token file does not exist');
  });

  it('refuses an empty token file', () => {
    const r = run(['--base', BASE, '--token-file', tokenFile('')]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('token file is empty');
  });

  it('refuses a token file of blank lines', () => {
    const r = run(['--base', BASE, '--token-file', tokenFile('\n\n')]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('only blank lines');
  });

  it('refuses an unknown channel', () => {
    const r = run(['--base', BASE, '--token-file', tokenFile('t'), '--channel', 'dev']);
    expect(r.status).toBe(2);
    expect(r.output).toContain('--channel must be prod or staging');
  });

  it('refuses a non-https base', () => {
    const r = run(['--base', 'http://download.example.test', '--token-file', tokenFile('t')]);
    expect(r.status).toBe(2);
    expect(r.output).toContain('https://');
  });
});

describe('gated-install-check.sh carries no deployment value or token', () => {
  const text = readFileSync(SCRIPT, 'utf8');

  it('names no Supabase host or download function address', () => {
    expect(text).not.toMatch(/supabase\.co/);
    expect(text).not.toMatch(/functions\/v1\/plugin-download/);
  });

  it('writes a bearer only through the helper format string', () => {
    const bearers = text.match(/Bearer [^\s"']+/g) ?? [];
    expect(bearers.length).toBeGreaterThan(0);
    for (const b of bearers) expect(['Bearer %s', 'Bearer <redacted>/g', 'Bearer [^']).toContain(b);
  });
});
