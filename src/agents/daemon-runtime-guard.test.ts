// B-1075: no src/daemon file assembles an agent-runtime command. The daemon renders a launch
// TEMPLATE and runs it; the runtime argv belongs to the worker (provision.sh → the adapter
// registry, B-1077). The daemon's only adapter logic is an id lookup + profile-list comparison
// (src/daemon/agent-eligibility.ts). A daemon file that starts building `claude`/`codex` argv itself would fork
// the launch description away from the adapter — this test stops that at CI.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRuntimeCommandAssembly, stripComments } from './runtime-command-guard.js';

const DAEMON_DIR = fileURLToPath(new URL('../daemon/', import.meta.url));

function daemonSources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return daemonSources(p);
    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [p] : [];
  });
}

describe('src/daemon builds no runtime command', () => {
  const files = daemonSources(DAEMON_DIR);

  it('scans a non-trivial set of daemon sources (positive control on the walk)', () => {
    expect(files.length).toBeGreaterThan(5);
    expect(files.some((f) => f.endsWith('scheduler.ts'))).toBe(true);
  });

  it('finds no spawn/exec of claude or codex and no runtime argv literal', () => {
    const findings = files.flatMap((f) => findRuntimeCommandAssembly(readFileSync(f, 'utf8')).map((x) => ({ file: f, ...x })));
    expect(findings).toEqual([]);
  });
});

describe('findRuntimeCommandAssembly (positive controls)', () => {
  it.each([
    "spawn('claude', ['-p', prompt]);",
    'execFileSync("codex", ["exec", prompt]);',
    'exec(`claude -p ${prompt}`);',
    "const argv = ['claude', '--plugin-dir', dir];",
    'const cmd = "claude --plugin-dir " + dir;',
    "const cmd = 'codex exec ' + prompt;",
  ])('flags %s', (src) => {
    expect(findRuntimeCommandAssembly(src).length).toBeGreaterThan(0);
  });

  it.each([
    '// spawns `claude -p` in the worker',
    '/* exec("claude -p") */',
    "const url = 'https://example.com/claude';",
    "const label = 'claude-code';",
    'exec(command, { env });',
  ])('ignores %s', (src) => {
    expect(findRuntimeCommandAssembly(src)).toEqual([]);
  });

  it('keeps line numbers through a stripped block comment', () => {
    const src = "/* one\ntwo */\nspawn('claude', []);";
    expect(stripComments(src).split('\n')).toHaveLength(3);
    expect(findRuntimeCommandAssembly(src)[0].line).toBe(3);
  });
});
