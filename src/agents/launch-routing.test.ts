// B-1077: the worker side of the routing seam — pure resolution/encoding, then the SHELL-LEVEL
// proof: provision.sh's own `_agent_argv` (extracted verbatim, run against the real built CLI) emits
// a launch command byte-identical to the pre-B-1077 hand assembly, for run_config with
// `agent: {adapter: 'claude-code'}` AND with no `agent` key — the config-only rollback path.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFUSAL_PREFIX,
  buildLaunchCommand,
  checkLaunchCredentials,
  decodeNulArgv,
  encodeNulArgv,
  resolveLaunchAdapter,
} from './launch-routing.js';
import { claudeCodeAdapter } from './claude-code.js';
import { RunConfigSchema } from '../config/run-config.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'dist', 'bin', 'harmony.js');
const PROVISION = readFileSync(join(ROOT, 'container', 'provision.sh'), 'utf8');

describe('resolveLaunchAdapter', () => {
  it('absent agent key ⇒ the claude-code adapter', () => {
    const r = resolveLaunchAdapter({});
    expect(r.ok && r.adapter.id).toBe('claude-code');
  });
  it('explicit claude-code ⇒ the claude-code adapter', () => {
    const r = resolveLaunchAdapter(RunConfigSchema.parse({ agent: { adapter: 'claude-code' } }));
    expect(r.ok && r.adapter.id).toBe('claude-code');
  });
  it('unknown adapter ⇒ refused with the registry message, no fallback', () => {
    expect(resolveLaunchAdapter(RunConfigSchema.parse({ agent: { adapter: 'codex' } }))).toEqual({
      ok: false,
      error: "Unknown agent adapter 'codex' — registered: claude-code",
    });
  });
  it('malformed adapter ⇒ refused', () => {
    expect(resolveLaunchAdapter(RunConfigSchema.parse({ agent: 'claude-code' })).ok).toBe(false);
  });
});

describe('buildLaunchCommand', () => {
  it("is the adapter's binary followed by its headless argv (one --output-format, model last)", () => {
    expect(
      buildLaunchCommand(claudeCodeAdapter, { pluginDir: '/p', prompt: 'hi', resumeSessionId: 'abc', model: 'claude-opus-5-5', extraFlags: ['--verbose'] }),
    ).toEqual(['claude', '--plugin-dir', '/p', '-p', 'hi', '--resume', 'abc', '--verbose', '--output-format', 'json', '--model', 'claude-opus-5-5']);
  });
});

describe('checkLaunchCredentials (B-934 via the adapter auth seam)', () => {
  it('both credentials set ⇒ config error', () => {
    const r = checkLaunchCredentials(claudeCodeAdapter, { ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/two credentials at once is a config error/);
  });
  it('an empty value counts as unset', () => {
    expect(checkLaunchCredentials(claudeCodeAdapter, { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 't' })).toEqual({
      ok: true,
      credential: 'subscription-token',
    });
  });
  it('neither ⇒ refused', () => {
    expect(checkLaunchCredentials(claudeCodeAdapter, {}).ok).toBe(false);
  });
});

describe('NUL argv encoding', () => {
  it('round-trips spaces, quotes, newlines and empty elements', () => {
    const argv = ['claude', '-p', 'it\'s "two"\nlines', '', '--x'];
    expect(decodeNulArgv(encodeNulArgv(argv))).toEqual(argv);
  });
  it('refuses an element carrying a NUL', () => {
    expect(() => encodeNulArgv(['a\0b'])).toThrow(/NUL/);
  });
});

// ------------------------------------------------------------------------------------------------
// Shell level. PRE_B1077_ASSEMBLY is the launch-command assembly provision.sh performed before this
// ticket, copied verbatim from origin/main 0ec85f9 (the flag base, the B-916 output-format append,
// the B-772 per-iteration --model, and the resume/cold launch lines) with only `_b772_run` replaced
// by a NUL-printing `printf` so the command can be compared rather than run. Pinned as text on
// purpose: the old script no longer exists to read.
// ------------------------------------------------------------------------------------------------
const PRE_B1077_ASSEMBLY = [
  '# shellcheck disable=SC2206',
  'EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})',
  'B916_OUTPUT_FORMAT_SET=0',
  'for b916_flag in "${EXTRA_HEADLESS_FLAGS_BASE[@]}"; do',
  '  if [ "$b916_flag" = "--output-format" ]; then',
  '    B916_OUTPUT_FORMAT_SET=1',
  '  fi',
  'done',
  'if [ "$B916_OUTPUT_FORMAT_SET" -eq 0 ]; then',
  '  EXTRA_HEADLESS_FLAGS_BASE+=(--output-format json)',
  'fi',
  'CURRENT_MODEL="${HARMONY_MODEL:-}"',
  'EXTRA_HEADLESS_FLAGS=("${EXTRA_HEADLESS_FLAGS_BASE[@]}")',
  'if [ -n "$CURRENT_MODEL" ]; then',
  '  EXTRA_HEADLESS_FLAGS+=(--model "$CURRENT_MODEL")',
  'fi',
  'if [ -n "$RESUME_SESSION_ID" ]; then',
  '  printf \'%s\\0\' claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" --resume "$RESUME_SESSION_ID" "${EXTRA_HEADLESS_FLAGS[@]}"',
  'else',
  '  printf \'%s\\0\' claude --plugin-dir "$PLUGIN_DIR" -p "$PROMPT" "${EXTRA_HEADLESS_FLAGS[@]}"',
  'fi',
].join('\n');

/** The CURRENT provision.sh's flag base + `_agent_argv` function, extracted verbatim. */
function currentAssembly(): string {
  const base = 'EXTRA_HEADLESS_FLAGS_BASE=(${CLAUDE_HEADLESS_FLAGS:-})';
  expect(PROVISION).toContain(base);
  const fn = /^ {4}AGENT_ARGV=\(\)\n {4}_agent_argv\(\) \{\n[\s\S]*?\n {4}\}\n/m.exec(PROVISION);
  expect(fn).not.toBeNull();
  return [
    '# shellcheck disable=SC2206',
    base,
    'CURRENT_MODEL="${HARMONY_MODEL:-}"',
    fn![0],
    '_agent_argv "$RESUME_SESSION_ID"',
    'printf \'%s\\0\' "${AGENT_ARGV[@]}"',
    '',
  ].join('\n');
}

interface Case {
  prompt: string;
  resume?: string;
  model?: string;
  headlessFlags?: string;
}

function runBash(body: string, env: NodeJS.ProcessEnv): { status: number; stdout: Buffer; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'b1077-argv-'));
  const file = join(dir, 'run.sh');
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o700 });
  try {
    const stdout = execFileSync('bash', [file], { env: { PATH: process.env.PATH, HOME: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: Buffer; stderr: Buffer };
    return { status: e.status, stdout: e.stdout, stderr: e.stderr.toString() };
  }
}

function caseEnv(c: Case, runConfig: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PLUGIN_DIR: ROOT,
    PROMPT: c.prompt,
    RESUME_SESSION_ID: c.resume ?? '',
    HARMONY_MODEL: c.model ?? '',
  };
  if (c.headlessFlags !== undefined) env.CLAUDE_HEADLESS_FLAGS = c.headlessFlags;
  if (runConfig !== null) env.HARMONY_RUN_CONFIG_JSON = Buffer.from(runConfig).toString('base64');
  return env;
}

const CASES: Array<[string, Case]> = [
  ['cold, no model', { prompt: 'do the leg' }],
  ['cold, model', { prompt: 'do the leg', model: 'claude-opus-5-5' }],
  ['resume + model', { prompt: 'do the leg', resume: '11111111-2222-4333-8444-555555555555', model: 'claude-sonnet-5' }],
  ['upstream flags', { prompt: 'do the leg', headlessFlags: '--verbose --max-turns 40', model: 'claude-opus-5-5' }],
  ['upstream output format wins', { prompt: 'do the leg', headlessFlags: '--output-format stream-json --verbose' }],
  ['awkward prompt', { prompt: 'it\'s "quoted"\n  with $HOME and `ticks` -p --resume x' }],
];

const RUN_CONFIGS: Array<[string, string | null]> = [
  ['no run_config at all', null],
  ['run_config {}', '{}'],
  ['run_config with no agent key', '{"session_resume":{"enabled":true},"note":"n"}'],
  ['run_config agent.adapter = claude-code', '{"agent":{"adapter":"claude-code"}}'],
];

describe('config-only rollback: provision.sh launches byte-identically to the pre-B-1077 assembly (shell level, real CLI)', () => {
  for (const [rcLabel, runConfig] of RUN_CONFIGS) {
    it.each(CASES)(`${rcLabel}: %s`, (_label, c) => {
      const before = runBash(PRE_B1077_ASSEMBLY, caseEnv(c, null));
      const after = runBash(currentAssembly(), caseEnv(c, runConfig));
      expect(before.status).toBe(0);
      expect(after.stderr).toBe('');
      expect(after.status).toBe(0);
      expect(after.stdout.equals(before.stdout)).toBe(true);
      expect(decodeNulArgv(after.stdout.toString())[0]).toBe('claude');
    });
  }

  it('positive control: the comparison is sensitive (a different model, or a dropped resume id, changes the bytes)', () => {
    const c: Case = { prompt: 'do the leg', resume: 'abc', model: 'claude-opus-5-5' };
    const before = runBash(PRE_B1077_ASSEMBLY, caseEnv(c, null)).stdout;
    expect(runBash(currentAssembly(), caseEnv({ ...c, model: 'claude-sonnet-5' }, null)).stdout.equals(before)).toBe(false);
    expect(runBash(currentAssembly(), caseEnv({ ...c, resume: '' }, null)).stdout.equals(before)).toBe(false);
    expect(decodeNulArgv(before.toString())).toEqual([
      'claude', '--plugin-dir', ROOT, '-p', 'do the leg', '--resume', 'abc', '--output-format', 'json', '--model', 'claude-opus-5-5',
    ]);
  });

  it('an unknown adapter is REFUSED at the worker (non-zero, "Refusing to start", nothing launched) — then switching config back to claude-code launches as before', () => {
    const c: Case = { prompt: 'do the leg', model: 'claude-opus-5-5' };
    const refused = runBash(currentAssembly(), caseEnv(c, '{"agent":{"adapter":"codex"}}'));
    expect(refused.status).toBe(1);
    expect(refused.stdout.length).toBe(0);
    expect(refused.stderr).toContain(`${REFUSAL_PREFIX} Unknown agent adapter 'codex' — registered: claude-code`);
    expect(refused.stderr).toContain('no worker launched');

    const rolledBack = runBash(currentAssembly(), caseEnv(c, '{"agent":{"adapter":"claude-code"}}'));
    expect(rolledBack.status).toBe(0);
    expect(rolledBack.stdout.equals(runBash(PRE_B1077_ASSEMBLY, caseEnv(c, null)).stdout)).toBe(true);
  });

  it('the run_config FILE delivery form (HARMONY_RUN_CONFIG_PATH) routes the same way', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1077-rc-'));
    const path = join(dir, 'run-config.json');
    const c: Case = { prompt: 'do the leg' };
    writeFileSync(path, '{"agent":{"adapter":"codex"}}');
    expect(runBash(currentAssembly(), { ...caseEnv(c, null), HARMONY_RUN_CONFIG_PATH: path }).status).toBe(1);
    writeFileSync(path, '{"agent":{"adapter":"claude-code"}}');
    const ok = runBash(currentAssembly(), { ...caseEnv(c, null), HARMONY_RUN_CONFIG_PATH: path });
    expect(ok.stdout.equals(runBash(PRE_B1077_ASSEMBLY, caseEnv(c, null)).stdout)).toBe(true);
  });
});

// The auth block, extracted verbatim from provision.sh (the adapter binary lookup through the
// credential check) and run against the real CLI with a stub `claude` on PATH.
describe('provision.sh credential refusal (shell level, real CLI)', () => {
  function authBlock(): string {
    const start = PROVISION.indexOf('    AGENT_BINARY="$(node');
    const end = PROVISION.indexOf('    echo "B-1077: agent credential: $AGENT_CREDENTIAL." >&2', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return PROVISION.slice(start, end) + '    echo "LAUNCH-OK $AGENT_CREDENTIAL"\n';
  }
  function runAuth(env: NodeJS.ProcessEnv) {
    const bin = mkdtempSync(join(tmpdir(), 'b1077-bin-'));
    writeFileSync(join(bin, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    const r = runBash(authBlock(), { PLUGIN_DIR: ROOT, ...env, PATH: `${bin}:${process.env.PATH}` });
    return { ...r, out: r.stdout.toString() };
  }

  it('ANTHROPIC_API_KEY beside CLAUDE_CODE_OAUTH_TOKEN REFUSES to start (was: a warning, API key wins)', () => {
    const r = runAuth({ ANTHROPIC_API_KEY: 'sk-test', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('LAUNCH-OK');
    expect(r.stderr).toContain(`${REFUSAL_PREFIX} Claude Code: ANTHROPIC_API_KEY is set beside CLAUDE_CODE_OAUTH_TOKEN`);
    expect(r.stderr).toContain('config error');
  });
  it('an EMPTY ANTHROPIC_API_KEY beside the token is unset first and starts on the subscription token', () => {
    const r = runAuth({ ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('LAUNCH-OK subscription-token');
  });
  it('the API key alone starts (metered)', () => {
    expect(runAuth({ ANTHROPIC_API_KEY: 'sk-test' }).out).toContain('LAUNCH-OK api-key');
  });
  it('neither credential refuses, pointing at env.example', () => {
    const r = runAuth({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${REFUSAL_PREFIX} Claude Code: headless mode needs auth`);
    expect(r.stderr).toContain('container/env.example');
  });
  it('an unknown adapter refuses before any credential is even looked at', () => {
    const r = runAuth({
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test',
      HARMONY_RUN_CONFIG_JSON: Buffer.from('{"agent":{"adapter":"codex"}}').toString('base64'),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Unknown agent adapter 'codex' — registered: claude-code");
  });
});
