// B-1148: Codex resume (Maintain session), the pinned Codex model, the in-place model switch and the
// cross-runtime isolation — EXECUTED against the real provision.sh headless block (extracted verbatim,
// the same discipline as profile-contract.test.ts's B-718 harness), with a stub `codex` / `claude` on
// PATH that logs its argv, and a plugin shim that forwards `agent ...` to the REAL built CLI while
// stubbing the catalog-reading `model ...` calls.
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const REAL_CLI = join(REPO, 'dist', 'bin', 'harmony.js');
const provision = readFileSync(join(REPO, 'container', 'provision.sh'), 'utf8');
const CAPABLE = spawnSync('bash', ['-c', 'command -v jq']).status === 0 && existsSync(REAL_CLI);

function extractBlock(): string {
  const start = provision.indexOf('# --- B-718: same-conduction resume discovery + best-effort --resume wiring (AC5). -----------');
  const end = provision.indexOf('exit "$LEG_EXIT"', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return provision.slice(start, end + 'exit "$LEG_EXIT"'.length);
}

/** `agent ...` → the real CLI; `model ...` → a stub driven by FAKE_* env; everything else exits 1. */
function makePluginShim(dir: string): string {
  mkdirSync(join(dir, 'dist', 'bin'), { recursive: true });
  writeFileSync(
    join(dir, 'dist', 'bin', 'harmony.js'),
    `const fs = require('node:fs');
const argv = process.argv.slice(2);
const log = process.env.FAKE_MODEL_LOG; if (log) fs.appendFileSync(log, argv.join(' ') + '\\n');
if (argv[0] === 'agent') {
  const r = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(REAL_CLI)}, ...argv], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
if (argv[0] !== 'model') process.exit(1);
const sub = argv[1];
const last = argv[argv.length - 1];
const codexAgent = argv.includes('--agent') && argv[argv.indexOf('--agent') + 1] === 'codex';
const handoff = process.env.FAKE_HANDOFF;
if (sub === 'pinned-default') { console.log(process.env.FAKE_PINNED || ''); process.exit(0); }
if (sub === 'normalize') {
  const ok = codexAgent && (process.env.FAKE_CODEX_MODELS || '').split(',').includes(last);
  console.log(ok ? last : ''); process.exit(0);
}
if (sub === 'check-alias') {
  const ok = codexAgent && (process.env.FAKE_CODEX_MODELS || '').split(',').includes(last);
  process.exit(ok ? 0 : 1);
}
if (sub === 'context-budget') { console.log(process.env.FAKE_BUDGET || '999999999'); process.exit(0); }
if (sub === 'read-handoff') { if (handoff && fs.existsSync(handoff)) { console.log(fs.readFileSync(handoff, 'utf8').trim()); process.exit(0); } process.exit(1); }
if (sub === 'clear-handoff') { if (handoff) fs.rmSync(handoff, { force: true }); process.exit(0); }
process.exit(1);
`,
  );
  return dir;
}

/** A stub runtime binary: logs its argv (one line, elements joined by ' | '), prints a thread.started
 *  event (the resumed id on `exec resume <id>`, else FAKE_NEW_THREAD), optionally writes a handoff on
 *  its first call, and fails a resume when FAKE_RESUME_FAIL=1. */
function makeBinDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const body = `#!/usr/bin/env bash
printf '%s' "$(basename "$0")" >> "$FAKE_ARGV_LOG"
for a in "$@"; do printf ' | %s' "$a" >> "$FAKE_ARGV_LOG"; done
printf '\\n' >> "$FAKE_ARGV_LOG"
id="\${FAKE_NEW_THREAD:-thread-new-1}"
if [ "\${1:-}" = exec ] && [ "\${2:-}" = resume ]; then
  if [ "\${FAKE_RESUME_FAIL:-}" = 1 ]; then echo "resume failed" >&2; exit 1; fi
  id="$3"
fi
if [ -n "\${FAKE_SWITCH_TO:-}" ] && [ ! -f "$FAKE_HANDOFF.done" ]; then
  printf '%s' "$FAKE_SWITCH_TO" > "$FAKE_HANDOFF"; : > "$FAKE_HANDOFF.done"
fi
echo '{"type":"thread.started","thread_id":"'"$id"'"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`;
  for (const b of ['codex', 'claude']) writeFileSync(join(dir, b), body, { mode: 0o755 });
  return dir;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  home: string;
  argv: string[];
  modelCalls: string[];
}

function runBlock(env: Record<string, string>, setup?: (home: string) => void): Run {
  const dir = mkdtempSync(join(tmpdir(), 'b1148-'));
  const home = join(dir, 'home');
  mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
  setup?.(home);
  const plugin = makePluginShim(join(dir, 'plugin'));
  const bin = makeBinDir(join(dir, 'bin'));
  const script = join(dir, 'harness.sh');
  writeFileSync(script, ['#!/usr/bin/env bash', 'set -euo pipefail', `PLUGIN_DIR="${plugin}"`, 'PROMPT="do the leg"', extractBlock(), ''].join('\n'), { mode: 0o700 });
  const argvLog = join(dir, 'argv.log');
  const modelLog = join(dir, 'model.log');
  const runConfig = (env.RUN_CONFIG as string | undefined) ?? '{}';
  const childEnv: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: home,
    FAKE_ARGV_LOG: argvLog,
    FAKE_MODEL_LOG: modelLog,
    FAKE_HANDOFF: join(dir, 'handoff'),
    HARMONY_RUN_CONFIG_JSON: Buffer.from(runConfig).toString('base64'),
    ...env,
  };
  delete childEnv.RUN_CONFIG;
  const r = spawnSync('bash', [script], { env: childEnv, encoding: 'utf8' });
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, home, argv: read(argvLog), modelCalls: read(modelLog) };
}

const CODEX_RC_ON = JSON.stringify({ agent: { adapter: 'codex' }, session_resume: { enabled: true } });
const CODEX_RC_OFF = JSON.stringify({ agent: { adapter: 'codex' }, session_resume: { enabled: false } });
const CLAUDE_RC_ON = JSON.stringify({ session_resume: { enabled: true } });

function writeThreadFile(home: string, rec: Record<string, unknown>): void {
  writeFileSync(join(home, '.codex', 'sessions', '.harmony-codex-thread.json'), JSON.stringify(rec));
}
function writeRollout(home: string, id: string, bytes = 10): string {
  const d = join(home, '.codex', 'sessions', '2026', '10', '17');
  mkdirSync(d, { recursive: true });
  const f = join(d, `rollout-2026-10-17T18-00-00-${id}.jsonl`);
  writeFileSync(f, 'x'.repeat(bytes));
  return f;
}
function threadFile(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, '.codex', 'sessions', '.harmony-codex-thread.json'), 'utf8'));
}

describe.skipIf(!CAPABLE)('provision.sh B-1148: Codex model, resume and switch (shell level, stub CLI)', () => {
  beforeAll(() => {
    expect(existsSync(REAL_CLI)).toBe(true);
  });

  it('AC1: no run/gate model ⇒ the leg launches on the catalog-pinned Codex model, never a Claude alias', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, HARMONY_MODEL: 'claude-opus-5', FAKE_PINNED: 'gpt-pinned', HARMONY_CODEX_MODEL: 'gpt-base' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(1);
    expect(r.argv[0]).toContain(' | -m | gpt-pinned');
    expect(r.argv[0]).not.toContain('claude-opus-5');
    expect(r.stderr).toContain("catalog's pinned model 'gpt-pinned'");
  });

  it('AC1: nothing pinned ⇒ HARMONY_CODEX_MODEL; a catalog-confirmed HARMONY_MODEL wins over both', () => {
    const base = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, HARMONY_CODEX_MODEL: 'gpt-base' });
    expect(base.argv[0]).toContain(' | -m | gpt-base');
    const explicit = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, HARMONY_MODEL: 'gpt-run', FAKE_CODEX_MODELS: 'gpt-run', FAKE_PINNED: 'gpt-pinned' });
    expect(explicit.argv[0]).toContain(' | -m | gpt-run');
    expect(explicit.modelCalls.some((c) => c.startsWith('model pinned-default'))).toBe(false);
  });

  it('AC2: Maintain session on ⇒ the next leg resumes the thread named in the thread file, and the file is rewritten', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON, FAKE_PINNED: 'gpt-pinned' }, (home) => {
      writeThreadFile(home, { agent: 'codex', thread_id: 'thr-prev', model: 'gpt-pinned', time: 't' });
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(1);
    expect(r.argv[0]).toMatch(/^codex \| exec \| resume \| thr-prev \| --json \| --dangerously-bypass-approvals-and-sandbox \| --dangerously-bypass-hook-trust \| -m \| gpt-pinned/);
    expect(threadFile(r.home)).toMatchObject({ agent: 'codex', thread_id: 'thr-prev', model: 'gpt-pinned' });
  });

  it('AC2: Maintain session off ⇒ a cold start even with a thread file, which the leg then overwrites', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, FAKE_NEW_THREAD: 'thr-cold' }, (home) => {
      writeThreadFile(home, { agent: 'codex', thread_id: 'thr-prev', model: null, time: 't' });
    });
    expect(r.argv).toHaveLength(1);
    expect(r.argv[0]).not.toContain('resume');
    expect(threadFile(r.home)).toMatchObject({ agent: 'codex', thread_id: 'thr-cold' });
  });

  it('AC2: no thread file ⇒ HARMONY_CODEX_RESUME_THREAD, else the newest rollout file', () => {
    const fromEnv = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON, HARMONY_CODEX_RESUME_THREAD: 'thr-sibling' });
    expect(fromEnv.argv[0]).toContain('exec | resume | thr-sibling');
    const fromRollout = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON }, (home) => {
      writeRollout(home, '019a0000-0000-7000-8000-000000000001');
    });
    expect(fromRollout.argv[0]).toContain('exec | resume | 019a0000-0000-7000-8000-000000000001');
  });

  it('a failed resume never kills the leg: it falls back to a cold start (B-718 shape)', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON, FAKE_RESUME_FAIL: '1' }, (home) => {
      writeThreadFile(home, { agent: 'codex', thread_id: 'thr-prev', model: null, time: 't' });
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(2);
    expect(r.argv[1]).not.toContain('resume');
    expect(r.stderr).toContain('falling back to a COLD start');
  });

  it('the context-budget guard weighs the rollout against the Codex row (`--agent codex`) and cold-starts when over', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON, FAKE_PINNED: 'gpt-pinned', FAKE_BUDGET: '100' }, (home) => {
      writeThreadFile(home, { agent: 'codex', thread_id: 'thr-big', model: null, time: 't' });
      writeRollout(home, 'thr-big', 500);
    });
    expect(r.modelCalls).toContain('model context-budget --agent codex gpt-pinned');
    expect(r.stderr).toContain('cold-starting instead of resuming (session-resume guard)');
    expect(r.argv[0]).not.toContain('resume');
  });

  it('AC4: a gate on another model ⇒ the thread is resumed with -m <new> and the output says "switched in place"', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, FAKE_PINNED: 'gpt-a', FAKE_CODEX_MODELS: 'gpt-a,gpt-b', FAKE_SWITCH_TO: 'gpt-b', FAKE_NEW_THREAD: 'thr-1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(2);
    expect(r.argv[1]).toMatch(/^codex \| exec \| resume \| thr-1 \| .* \| -m \| gpt-b/);
    expect(r.stderr).toContain("model switch to 'gpt-b' — switched in place");
    expect(r.modelCalls).toContain('model check-alias --agent codex gpt-b');
    expect(threadFile(r.home)).toMatchObject({ thread_id: 'thr-1', model: 'gpt-b' });
  });

  it('AC4: when the in-place resume fails the switch starts a new thread on the new model, and says so', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, FAKE_PINNED: 'gpt-a', FAKE_CODEX_MODELS: 'gpt-a,gpt-b', FAKE_SWITCH_TO: 'gpt-b', FAKE_RESUME_FAIL: '1' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(3);
    expect(r.argv[2]).not.toContain('resume');
    expect(r.argv[2]).toContain(' | -m | gpt-b');
    expect(r.stderr).toContain("model switch to 'gpt-b' — started a new thread");
  });

  it('AC4: a requested model outside the Codex catalog rows is rejected (no second invocation)', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_OFF, FAKE_PINNED: 'gpt-a', FAKE_CODEX_MODELS: 'gpt-a', FAKE_SWITCH_TO: 'claude-opus-5' });
    expect(r.argv).toHaveLength(1);
    expect(r.stderr).toContain('NOT in the canonical allowlist');
  });
});

describe.skipIf(!CAPABLE)('provision.sh B-1148: cross-runtime isolation (shell level, stub CLI)', () => {
  it('AC3: a Codex leg never receives a Claude session (projects transcript, a --resume flag, a foreign thread file)', () => {
    const r = runBlock({ AGENT_ID: 'codex', RUN_CONFIG: CODEX_RC_ON, CLAUDE_HEADLESS_FLAGS: '--resume claude-sess-flag', FAKE_NEW_THREAD: 'thr-new' }, (home) => {
      const slug = join(home, '.claude', 'projects', '-workspace-workspace');
      mkdirSync(slug, { recursive: true });
      writeFileSync(join(slug, 'claude-sess-file.jsonl'), '{}\n');
      writeThreadFile(home, { agent: 'claude-code', thread_id: 'claude-sess-thread', model: null, time: 't' });
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(1);
    const all = r.argv.join('\n');
    for (const leak of ['claude-sess-flag', 'claude-sess-file', 'claude-sess-thread']) expect(all).not.toContain(leak);
    expect(all).not.toContain('resume');
  });

  it('AC3: a Claude leg never receives a Codex thread (thread file, rollout, HARMONY_CODEX_RESUME_THREAD) and writes no thread file', () => {
    const r = runBlock({ RUN_CONFIG: CLAUDE_RC_ON, HARMONY_CODEX_RESUME_THREAD: 'codex-thr-env' }, (home) => {
      writeThreadFile(home, { agent: 'codex', thread_id: 'codex-thr-file', model: null, time: 't' });
      writeRollout(home, 'codex-thr-rollout');
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.argv).toHaveLength(1);
    expect(r.argv[0].startsWith('claude')).toBe(true);
    const all = r.argv.join('\n');
    for (const leak of ['codex-thr-env', 'codex-thr-file', 'codex-thr-rollout', '--resume']) expect(all).not.toContain(leak);
    expect(threadFile(r.home).thread_id).toBe('codex-thr-file'); // untouched by the Claude leg
  });
});

describe.skipIf(!existsSync(REAL_CLI))('harmony agent thread-id / write-thread / read-thread (B-1148, real CLI)', () => {
  const cli = (args: string[]) => spawnSync(process.execPath, [REAL_CLI, ...args], { encoding: 'utf8', env: { ...process.env, HARMONY_RUN_CONFIG_JSON: '', HARMONY_RUN_CONFIG_PATH: '' } });

  it('thread-id prints the thread.started id; exits 1 on a capture without one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1148-cli-'));
    writeFileSync(join(dir, 'out'), 'noise\n{"type":"thread.started","thread_id":"abc-123"}\n');
    writeFileSync(join(dir, 'none'), '{"type":"turn.completed"}\n');
    expect(cli(['agent', 'thread-id', join(dir, 'out')]).stdout.trim()).toBe('abc-123');
    expect(cli(['agent', 'thread-id', join(dir, 'none')]).status).toBe(1);
  });

  it('write-thread writes {agent:"codex", thread_id, model, time}; read-thread accepts only agent "codex"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1148-cli-'));
    writeFileSync(join(dir, 'out'), '{"type":"thread.started","thread_id":"abc-123"}\n');
    const sessions = join(dir, 'sessions');
    expect(cli(['agent', 'write-thread', '--dir', sessions, '--stdout-file', join(dir, 'out'), '--model', 'gpt-x']).stdout.trim()).toBe('abc-123');
    const rec = JSON.parse(readFileSync(join(sessions, '.harmony-codex-thread.json'), 'utf8'));
    expect(rec).toMatchObject({ agent: 'codex', thread_id: 'abc-123', model: 'gpt-x' });
    expect(typeof rec.time).toBe('string');
    expect(cli(['agent', 'read-thread', join(sessions, '.harmony-codex-thread.json')]).stdout.trim()).toBe('abc-123');
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ agent: 'claude-code', thread_id: 'abc-123' }));
    expect(cli(['agent', 'read-thread', join(dir, 'claude.json')]).status).toBe(1);
    writeFileSync(join(dir, 'evil.json'), JSON.stringify({ agent: 'codex', thread_id: '--model x' }));
    expect(cli(['agent', 'read-thread', join(dir, 'evil.json')]).status).toBe(1);
  });

  it('write-thread leaves an existing file untouched when the capture carries no thread id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b1148-cli-'));
    mkdirSync(join(dir, 's'));
    writeFileSync(join(dir, 's', '.harmony-codex-thread.json'), '{"agent":"codex","thread_id":"keep"}');
    writeFileSync(join(dir, 'none'), '');
    expect(cli(['agent', 'write-thread', '--dir', join(dir, 's'), '--stdout-file', join(dir, 'none')]).status).toBe(1);
    expect(readFileSync(join(dir, 's', '.harmony-codex-thread.json'), 'utf8')).toContain('keep');
  });
});

describe.skipIf(!CAPABLE)('entrypoint.sh B-1148: the cloud Codex layout (codex-sessions link + sibling thread discovery)', () => {
  const entry = readFileSync(join(REPO, 'container', 'entrypoint.sh'), 'utf8');
  function block(): string {
    const at = entry.indexOf('if [ -n "${HARMONY_TRANSCRIPT_MOUNT_ROOT:-}" ]; then');
    const fnAt = entry.indexOf('b772_finish_cross_conduction_resume() {', at);
    const fnEnd = entry.indexOf('\n}', fnAt);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(fnEnd).toBeGreaterThan(fnAt);
    return entry.slice(at, fnEnd + 2);
  }
  function run(runConfig: object, seed: (root: string) => void) {
    const dir = mkdtempSync(join(tmpdir(), 'b1148-entry-'));
    const home = join(dir, 'home');
    const root = join(dir, 'mount');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    mkdirSync(join(home, '.claude', 'logs'), { recursive: true });
    mkdirSync(join(home, '.codex', 'sessions'), { recursive: true });
    mkdirSync(root);
    seed(root);
    const script = join(dir, 'h.sh');
    writeFileSync(
      script,
      ['#!/usr/bin/env bash', 'set -euo pipefail', block(), 'b772_finish_cross_conduction_resume "/fake/plugin"',
        'echo "CLAUDE_HEADLESS_FLAGS=[${CLAUDE_HEADLESS_FLAGS:-}]"', 'echo "CODEX_THREAD=[${HARMONY_CODEX_RESUME_THREAD:-}]"', ''].join('\n'),
      { mode: 0o700 },
    );
    const r = spawnSync('bash', [script], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: home, HARMONY_TRANSCRIPT_MOUNT_ROOT: root, CONDUCTION_ID: 'cond-new', TICKET: 'B-9', HARMONY_RUN_CONFIG_JSON: Buffer.from(JSON.stringify(runConfig)).toString('base64') },
    });
    return { ...r, home, root };
  }
  const seedBoth = (agent = 'codex') => (root: string) => {
    const sib = join(root, 'B-9', 'cond-old', 'codex-sessions');
    mkdirSync(join(sib, '2026', '10', '17'), { recursive: true });
    writeFileSync(join(sib, '.harmony-codex-thread.json'), JSON.stringify({ agent, thread_id: 'thr-old', model: null, time: 't' }));
    writeFileSync(join(sib, '2026', '10', '17', 'rollout-2026-10-17T10-00-00-thr-old.jsonl'), '{}\n');
    const slug = join(root, 'B-9', 'cond-old', 'projects', '-workspace-workspace');
    mkdirSync(slug, { recursive: true });
    writeFileSync(join(slug, 'claude-sess.jsonl'), '{}\n');
  };

  it('a Codex run links codex-sessions onto ~/.codex/sessions, copies the sibling thread + rollout, and exports HARMONY_CODEX_RESUME_THREAD (never a --resume flag)', () => {
    const r = run({ agent: { adapter: 'codex' }, session_resume: { enabled: true } }, seedBoth());
    expect(r.status, r.stderr).toBe(0);
    const link = join(r.home, '.codex', 'sessions');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(r.root, 'B-9', 'cond-new', 'codex-sessions'));
    expect(r.stdout).toContain('CODEX_THREAD=[thr-old]');
    expect(r.stdout).toContain('CLAUDE_HEADLESS_FLAGS=[]');
    expect(existsSync(join(r.root, 'B-9', 'cond-new', 'codex-sessions', '2026', '10', '17', 'rollout-2026-10-17T10-00-00-thr-old.jsonl'))).toBe(true);
  });

  it('a sibling thread file naming another agent is not adopted', () => {
    const r = run({ agent: { adapter: 'codex' }, session_resume: { enabled: true } }, seedBoth('claude-code'));
    expect(r.stdout).toContain('CODEX_THREAD=[]');
    expect(r.stdout).toContain('CLAUDE_HEADLESS_FLAGS=[]');
  });

  it('a Claude run keeps the Claude discovery only: no Codex link, no Codex thread', () => {
    const r = run({ session_resume: { enabled: true } }, seedBoth());
    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(join(r.home, '.codex', 'sessions')).isSymbolicLink()).toBe(false);
    expect(r.stdout).toContain('CLAUDE_HEADLESS_FLAGS=[ --resume claude-sess]');
    expect(r.stdout).toContain('CODEX_THREAD=[]');
  });
});
