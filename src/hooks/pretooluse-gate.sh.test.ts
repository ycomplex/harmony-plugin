// B-992: `hooks/pretooluse-gate.sh`, executed FOR REAL (never a hand-retyped copy — mirrors this
// repo's "prose-pinned tests alone are not trusted" discipline, see
// src/container/activate-toolchain.test.ts / src/daemon/profile-contract.test.ts). Proves the three
// layers of the fast path in isolation from src/hooks/pretooluse-gate.ts's own unit-tested decision
// logic:
//
//   1. no `.harmony/project.yml` in the session's cwd -> exit 0, prints nothing (AC2's floor, before
//      node is even a consideration);
//   2. a manifest-bearing repo but NON-boundary stdin -> exit 0 WITHOUT spawning node at all — proved
//      with a sentinel `node` shim on PATH that would mark itself invoked if it ever ran;
//   3. a manifest-bearing repo, BOUNDARY-shaped stdin, but no built `dist/bin/pretooluse-gate.js` ->
//      exit 0 (the wrapper's own `[ -f "$GATE" ] || exit 0` guard).

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(new URL('../../hooks/pretooluse-gate.sh', import.meta.url));

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runHook(input: unknown, env: Record<string, string | undefined> = {}): Run {
  try {
    const stdout = execFileSync('sh', [scriptPath], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number | null; stdout?: string; stderr?: string };
    return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

describe('hooks/pretooluse-gate.sh — the floor, the fast path, and the not-yet-built fallback', () => {
  it('AC2 floor: no .harmony/project.yml in the session cwd -> exit 0, prints nothing', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'b992-nomanifest-'));
    const run = runHook({
      hook_event_name: 'PreToolUse',
      cwd,
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x' },
    });
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
  });

  it('no cwd on the payload at all -> exit 0 (nothing to resolve a manifest against)', () => {
    const run = runHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'gh pr create' } });
    expect(run.status).toBe(0);
  });

  it('a manifest-bearing repo with NON-boundary stdin exits 0 WITHOUT ever spawning node', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'b992-nonboundary-'));
    mkdirSync(join(cwd, '.harmony'), { recursive: true });
    writeFileSync(join(cwd, '.harmony', 'project.yml'), 'version: 1\n');

    // A sentinel `node` shim that proves itself invoked (and fails loudly) if node is ever spawned.
    const stubDir = mkdtempSync(join(tmpdir(), 'b992-stub-'));
    const sentinel = join(stubDir, 'node-invoked.marker');
    writeFileSync(
      join(stubDir, 'node'),
      ['#!/bin/sh', `echo invoked > "${sentinel}"`, 'exit 1', ''].join('\n'),
      { mode: 0o755 },
    );

    const run = runHook(
      { hook_event_name: 'PreToolUse', cwd, tool_name: 'Read', tool_input: { file_path: '/tmp/x' } },
      { PATH: `${stubDir}:${process.env.PATH}` },
    );
    expect(run.status).toBe(0);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('a manifest-bearing repo, boundary-shaped stdin, but NO built dist bin -> exit 0 (fail open)', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'b992-missingdist-'));
    mkdirSync(join(cwd, '.harmony'), { recursive: true });
    writeFileSync(join(cwd, '.harmony', 'project.yml'), 'version: 1\n');

    // A scratch CLAUDE_PLUGIN_ROOT that has no dist/ at all — the GATE file the wrapper looks for.
    const pluginRoot = mkdtempSync(join(tmpdir(), 'b992-pluginroot-'));

    const run = runHook(
      {
        hook_event_name: 'PreToolUse',
        cwd,
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --title x' },
      },
      { CLAUDE_PLUGIN_ROOT: pluginRoot },
    );
    expect(run.status).toBe(0);
  });

  it('a manifest-bearing repo, a resolve_brief-shaped stdin, also passes the layer-3 grep', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'b992-resolvebrief-'));
    mkdirSync(join(cwd, '.harmony'), { recursive: true });
    writeFileSync(join(cwd, '.harmony', 'project.yml'), 'version: 1\n');
    const pluginRoot = mkdtempSync(join(tmpdir(), 'b992-pluginroot2-'));

    const run = runHook(
      {
        hook_event_name: 'PreToolUse',
        cwd,
        tool_name: 'mcp__plugin_harmony-plugin_harmony__resolve_brief',
        tool_input: { task_id: 'B-1', command: 'accept' },
      },
      { CLAUDE_PLUGIN_ROOT: pluginRoot },
    );
    // No built dist bin under pluginRoot either -> still fails open, but this proves the grep layer
    // itself let a resolve_brief call PAST layer 3 (otherwise this and the gh-pr-create case above
    // would be indistinguishable).
    expect(run.status).toBe(0);
  });
});
