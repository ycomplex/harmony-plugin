// B-772 round 2: unit coverage for `harmony model ...` — the node subprocess accessor
// container/provision.sh and container/entrypoint.sh call into to read the alias allowlist / the
// context-budget table / the handoff-file contract src/config/run-config.ts owns.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll, type MockInstance } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerModelCommands } from './model.js';
import { PINNED_DEFAULT_MODEL_BY_PROFILE } from '../../config/run-config.js';

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerModelCommands(program);
  return program;
}

const run = (argv: string[]) => makeProgram().parseAsync(argv, { from: 'user' });

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;
const tempDirs: string[] = [];

function tempHandoffPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'b772-cli-model-'));
  tempDirs.push(dir);
  return join(dir, 'model-handoff-request.json');
}

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  vi.unstubAllEnvs();
});

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('harmony model check-alias <alias>', () => {
  it('prints "true" and exits 0 for an allowlisted alias', async () => {
    await expect(run(['model', 'check-alias', 'claude-sonnet-5'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('true');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints "false" and exits 1 for an unrecognized alias', async () => {
    await expect(run(['model', 'check-alias', 'not-a-real-model'])).rejects.toThrow(ExitSentinel);
    expect(logSpy).toHaveBeenCalledWith('false');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('harmony model context-budget <alias>', () => {
  it('prints a positive byte count for a tabled alias', async () => {
    await run(['model', 'context-budget', 'claude-sonnet-5']);
    expect(logSpy).toHaveBeenCalledTimes(1);
    const printed = Number(logSpy.mock.calls[0][0]);
    expect(printed).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('never fails on an unrecognized alias — prints the conservative fallback instead', async () => {
    await run(['model', 'context-budget', 'some-future-alias']);
    const printed = Number(logSpy.mock.calls[0][0]);
    expect(printed).toBeGreaterThan(0);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('harmony model running-model', () => {
  it('prints HARMONY_MODEL when set', async () => {
    vi.stubEnv('HARMONY_MODEL', 'claude-opus-5');
    await run(['model', 'running-model']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('prints an empty string (not an error) when HARMONY_MODEL is unset', async () => {
    vi.stubEnv('HARMONY_MODEL', '');
    await run(['model', 'running-model']);
    expect(logSpy).toHaveBeenCalledWith('');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('harmony model resolve-gate <workflow-state>', () => {
  it('falls back to the pinned per-profile default when no run_config env is set', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', '');
    vi.stubEnv('HARMONY_SUPABASE_URL', '');
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('honors an explicit per-gate override from HARMONY_RUN_CONFIG_JSON', async () => {
    const payload = Buffer.from(
      JSON.stringify({ model: { per_gate: { build: 'claude-opus-5' } } }),
    ).toString('base64');
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', payload);
    // 'Planned' -> gate 'build' (src/daemon/gate-phase.ts GATE_BY_WORKFLOW_STATE)
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith('claude-opus-5');
  });

  it('honors --activity being passed through (forward-compat; does not currently discriminate)', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', '');
    await run(['model', 'resolve-gate', 'Decomposed', '--activity', 'designing-ux-ui']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
  });

  it('degrades to the empty run_config (never throws/crashes) on malformed HARMONY_RUN_CONFIG_JSON', async () => {
    vi.stubEnv('HARMONY_RUN_CONFIG_PATH', '');
    vi.stubEnv('HARMONY_RUN_CONFIG_JSON', Buffer.from('not valid json').toString('base64'));
    await run(['model', 'resolve-gate', 'Planned']);
    expect(logSpy).toHaveBeenCalledWith(PINNED_DEFAULT_MODEL_BY_PROFILE.prod);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe('harmony model request-switch / read-handoff / clear-handoff', () => {
  it('request-switch writes a handoff file for an allowlisted alias', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-opus-5']);
    expect(existsSync(handoffPath)).toBe(true);
    expect(JSON.parse(readFileSync(handoffPath, 'utf8'))).toEqual({ requested_model: 'claude-opus-5' });
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('request-switch refuses (exit 1, no file written) for an unrecognized alias', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await expect(run(['model', 'request-switch', 'not-a-real-model'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(handoffPath)).toBe(false);
  });

  it('read-handoff prints the pending alias and exits 0 when a request is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-haiku-5']);
    await run(['model', 'read-handoff']);
    expect(logSpy).toHaveBeenCalledWith('claude-haiku-5');
  });

  it('read-handoff exits 1 with no stdout when no request is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await expect(run(['model', 'read-handoff'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('clear-handoff deletes a pending request', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'request-switch', 'claude-sonnet-5']);
    expect(existsSync(handoffPath)).toBe(true);
    await run(['model', 'clear-handoff']);
    expect(existsSync(handoffPath)).toBe(false);
  });

  it('clear-handoff is idempotent — never exits non-zero when nothing is pending', async () => {
    const handoffPath = tempHandoffPath();
    vi.stubEnv('HARMONY_MODEL_HANDOFF_PATH', handoffPath);
    await run(['model', 'clear-handoff']);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
