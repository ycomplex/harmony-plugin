// B-1076: a Codex leg's usage lands in conduction_leg_costs. The capture is Codex's `--json` JSONL
// (not the Claude result envelope), so `harmony leg-cost record` takes the tokens from the codex
// adapter's telemetry: the LAST `turn.completed` usage, runtime=codex, credential_kind=login-cache,
// cost_regime=plan-included, cost null/'unknown'. Driven through the real command with a fixture
// capture; only the board write and the auth are stubbed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';

const recordLegCost = vi.fn(async () => true);
vi.mock('../../tools/leg-cost-record.js', () => ({
  recordLegCost: (...a: unknown[]) => (recordLegCost as (...x: unknown[]) => Promise<boolean>)(...a),
  resolveLegCostContext: async () => ({ task_id: 'task-1', workflow_state: 'building', workflow_activity: null }),
}));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: async () => ({ client: {} }) }));

const { registerLegCostCommands, resolveAdapterTelemetry, resolveRuntimeFacts } = await import('./leg-cost.js');

const FIXTURE = fileURLToPath(new URL('../../agents/fixtures/codex-exec-two-turns.jsonl', import.meta.url));
const captured = readFileSync(FIXTURE, 'utf8');
const CODEX_RC = Buffer.from(JSON.stringify({ agent: { adapter: 'codex' } })).toString('base64');
const CODEX_ENV = { HARMONY_CODEX_AUTH_FILE: '/home/worker/.codex-auth-src/auth.json' };

const saved: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => recordLegCost.mockClear());
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete saved[k];
  }
});

async function record(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerLegCostCommands(program);
  await program.parseAsync(['node', 'harmony', 'leg-cost', 'record', ...args]);
}

describe('resolveAdapterTelemetry (codex fixture)', () => {
  it('reads the LAST turn.completed usage — input / cached / output — plus the thread id', () => {
    const facts = resolveRuntimeFacts(captured, null, {}, CODEX_ENV, { agent: { adapter: 'codex' } } as never);
    expect(facts).toEqual({ runtime: 'codex', credential_kind: 'login-cache', cost_regime: 'plan-included' });
    const rec = resolveAdapterTelemetry(captured, 'gpt-5-codex', facts);
    expect(rec).toMatchObject({
      runtime: 'codex',
      credential: 'login-cache',
      costRegime: 'plan-included',
      costUsd: null,
      sessionId: '0199b1c7-1076-7000-8000-c0de0000beef',
      isError: false,
      usage: { inputTokens: 5400, cacheReadInputTokens: 4100, outputTokens: 610 },
    });
  });

  it('is null for claude-code (its envelope keeps its own parse), an unknown runtime, or a capture with no terminal turn', () => {
    expect(resolveAdapterTelemetry(captured, null, { runtime: 'claude-code', credential_kind: 'subscription-token', cost_regime: 'plan-included' })).toBeNull();
    expect(resolveAdapterTelemetry(captured, null, { runtime: 'nope', credential_kind: null, cost_regime: null })).toBeNull();
    expect(resolveAdapterTelemetry('{"type":"thread.started","thread_id":"t"}', null, { runtime: 'codex', credential_kind: null, cost_regime: null })).toBeNull();
  });
});

describe('harmony leg-cost record — a Codex capture', () => {
  it('writes ONE row with the codex usage, runtime and regime; cost null/unknown', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined });
    await record(['--file', FIXTURE, '--gate', 'build', '--leg-key', 'leg-1', '--invocation-index', '0', '--conduction-id', 'cond-1', '--model', 'gpt-5-codex']);
    expect(recordLegCost).toHaveBeenCalledTimes(1);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      conduction_id: 'cond-1',
      leg_key: 'leg-1',
      task_id: 'task-1',
      gate: 'build',
      model: 'gpt-5-codex',
      invocation_index: 0,
      input_tokens: 5400,
      cache_read_input_tokens: 4100,
      output_tokens: 610,
      cache_creation_input_tokens: null,
      thinking_tokens: null,
      total_cost_usd: null,
      cost_source: 'unknown',
      session_id: '0199b1c7-1076-7000-8000-c0de0000beef',
      is_error: false,
      runtime: 'codex',
      credential_kind: 'login-cache',
      cost_regime: 'plan-included',
    });
  });

  it('a Claude envelope on a Claude run is recorded exactly as before (no codex usage leaks in)', async () => {
    setEnv({ HARMONY_RUN_CONFIG_JSON: undefined, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-SECRET', HARMONY_CODEX_AUTH_FILE: undefined });
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const f = join(mkdtempSync(join(tmpdir(), 'b1076-legcost-')), 'out.json');
    writeFileSync(f, JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', total_cost_usd: 0.1, usage: { input_tokens: 1, output_tokens: 2 } }));
    await record(['--file', f, '--gate', 'build', '--leg-key', 'leg-2', '--conduction-id', 'cond-2']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ input_tokens: 1, output_tokens: 2, session_id: 's1', runtime: 'claude-code', total_cost_usd: 0.1, cost_source: 'cli' });
  });
});
