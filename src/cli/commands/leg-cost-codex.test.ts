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
  // B-1149: the resumed-thread delta reads earlier rows of the same thread.
  sumPriorSessionUsage: (...a: unknown[]) => (sumPriorSessionUsage as (...x: unknown[]) => Promise<unknown>)(...a),
  ownUsageDelta: (c: { inputTokens: number | null; cacheReadInputTokens: number | null; outputTokens: number | null }, p: { input_tokens: number; cache_read_input_tokens: number; output_tokens: number } | null) => ({
    inputTokens: c.inputTokens === null ? null : Math.max(0, c.inputTokens - (p?.input_tokens ?? 0)),
    cacheReadInputTokens: c.cacheReadInputTokens === null ? null : Math.max(0, c.cacheReadInputTokens - (p?.cache_read_input_tokens ?? 0)),
    outputTokens: c.outputTokens === null ? null : Math.max(0, c.outputTokens - (p?.output_tokens ?? 0)),
  }),
}));
const sumPriorSessionUsage = vi.fn(async (): Promise<unknown> => null);
vi.mock('../auth.js', () => ({ getAuthenticatedContext: async () => ({ client: {} }) }));
// B-1179: the catalog price read. By default it is the REAL fetchCatalogPrice, so every test above
// the B-1179 block runs it against the `{}` client (no .from) and proves a broken read never stops
// recording; the B-1179 tests below override one call's result.
const fetchCatalogPrice = vi.fn();
vi.mock('../../tools/catalog-pricing.js', async (importActual) => {
  const actual = await importActual<typeof import('../../tools/catalog-pricing.js')>();
  fetchCatalogPrice.mockImplementation(actual.fetchCatalogPrice);
  return { fetchCatalogPrice: (...a: unknown[]) => (fetchCatalogPrice as (...x: unknown[]) => unknown)(...a) };
});

const { registerLegCostCommands, resolveAdapterTelemetry, resolveRuntimeFacts } = await import('./leg-cost.js');

const FIXTURE = fileURLToPath(new URL('../../agents/fixtures/codex-exec-two-turns.jsonl', import.meta.url));
const REQUEST_FIXTURE = fileURLToPath(new URL('../../agents/fixtures/codex-request-usage.jsonl', import.meta.url));
const REQUEST_ARGS = ['--request-usage-file', REQUEST_FIXTURE, '--request-usage-offset', '0'];
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

beforeEach(() => {
  recordLegCost.mockClear();
  sumPriorSessionUsage.mockClear();
});
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
    const rec = resolveAdapterTelemetry(captured, 'gpt-5.1', facts);
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
  it('retains request usage when the worker reports a failed invocation and creates a stable row ID', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-failed', '--conduction-id', 'cond-1', '--model', 'gpt-6.1-sol', '--invocation-id', 'leg-failed:0', '--is-error']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ input_tokens: 5400, cache_read_input_tokens: 4100, output_tokens: 610, is_error: true, cost_source: 'derived' });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('does not fall back to cumulative terminal usage when the invocation boundary is missing', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined });
    await record(['--file', FIXTURE, '--gate', 'build', '--leg-key', 'leg-unknown', '--conduction-id', 'cond-1', '--model', 'gpt-6.1-sol']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ input_tokens: null, output_tokens: null, total_cost_usd: null, cost_source: 'unknown' });
  });

  it('writes ONE row with the codex usage, runtime and regime; B-1149: a derived equivalent cost, cache-write null', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-1', '--invocation-index', '0', '--conduction-id', 'cond-1', '--model', 'gpt-5.1']);
    expect(recordLegCost).toHaveBeenCalledTimes(1);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      conduction_id: 'cond-1',
      leg_key: 'leg-1',
      task_id: 'task-1',
      gate: 'build',
      model: 'gpt-5.1',
      invocation_index: 0,
      input_tokens: 5400,
      cache_read_input_tokens: 4100,
      output_tokens: 610,
      cache_creation_input_tokens: null,
      thinking_tokens: null,
      // B-1149: (5400 − 4100) × 1.25 + 4100 × 0.125 + 610 × 10, per million tokens
      total_cost_usd: expect.closeTo(0.0082375, 10),
      cost_source: 'derived',
      num_turns: 2,
      refusal_kind: null,
      session_id: '0199b1c7-1076-7000-8000-c0de0000beef',
      is_error: false,
      runtime: 'codex',
      credential_kind: 'login-cache',
      cost_regime: 'plan-included',
    });
  });

  it('B-1353: a resumed thread records only the request usage after its invocation boundary', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-3', '--conduction-id', 'cond-3', '--model', 'gpt-6.1-sol', '--duration-ms', '4321']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({
      input_tokens: 5400,
      cache_read_input_tokens: 4100,
      output_tokens: 610,
      duration_ms: 4321,
      total_cost_usd: expect.closeTo(0.00911, 10),
      cost_source: 'derived',
    });
  });

  it('B-1149: gpt-6.1-sol prices the two-turn fixture to the exact published-rate cost (non-null, derived)', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-5', '--conduction-id', 'cond-5', '--model', 'gpt-6.1-sol']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    // (5400 − 4100) × 2.00 + 4100 × 0.10 + 610 × 10.00 = 2600 + 410 + 6100 = 9110 per million = 0.00911
    expect(row.total_cost_usd).toBeCloseTo(0.00911, 10);
    expect(row.total_cost_usd).not.toBeNull();
    expect(row.cost_source).toBe('derived');
  });

  it('B-1175: a gpt-6-luna leg is priced at the Standard tier (non-null, derived)', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'clarify', '--leg-key', 'leg-7', '--conduction-id', 'cond-7', '--model', 'gpt-6-luna']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    // (5400 − 4100) × 0.10 + 4100 × 0.01 + 610 × 0.50 = 130 + 41 + 305 = 476 per million = 0.000476
    expect(row.total_cost_usd).toBeCloseTo(0.000476, 10);
    expect(row.total_cost_usd).not.toBeNull();
    expect(row.cost_source).toBe('derived');
  });

  it('B-1149: an unpriced model (a removed -mini id) stays not captured', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined });
    await record(['--file', FIXTURE, '--gate', 'build', '--leg-key', 'leg-6', '--conduction-id', 'cond-6', '--model', 'gpt-5-codex-mini']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row.total_cost_usd).toBeNull();
    expect(row.cost_source).toBe('unknown');
  });

  it('B-1149: HARMONY_TEST_FORCE_REFUSAL makes the row carry the forced refusal verdict', async () => {
    setEnv({ ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: 'quota' });
    await record(['--file', FIXTURE, '--gate', 'build', '--leg-key', 'leg-4', '--conduction-id', 'cond-4', '--model', 'gpt-5.1']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ refusal_kind: 'quota', refusal_resets_at: null });
  });

  it('B-1149: a Claude usage-limit envelope records refusal_kind quota with the epoch reset', async () => {
    setEnv({ HARMONY_RUN_CONFIG_JSON: undefined, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-SECRET', HARMONY_CODEX_AUTH_FILE: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined });
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const f = join(mkdtempSync(join(tmpdir(), 'b1149-legcost-')), 'out.json');
    writeFileSync(f, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1792000000', session_id: 's9', usage: { input_tokens: 0, output_tokens: 0 } }));
    await record(['--file', f, '--gate', 'build', '--leg-key', 'leg-5', '--conduction-id', 'cond-5']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row).toMatchObject({ refusal_kind: 'quota', refusal_resets_at: new Date(1792000000 * 1000).toISOString(), is_error: true });
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

describe('B-1179: harmony leg-cost record — the catalog row price', () => {
  const CODEX_RUN_ENV = { ...CODEX_ENV, HARMONY_RUN_CONFIG_JSON: CODEX_RC, HARMONY_RUN_CONFIG_PATH: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, OPENAI_API_KEY: undefined, CODEX_API_KEY: undefined, CODEX_ACCESS_TOKEN: undefined, HARMONY_TEST_FORCE_REFUSAL: undefined };

  it('a catalog row price is used for the recorded cost (derived), over the table', async () => {
    setEnv(CODEX_RUN_ENV);
    fetchCatalogPrice.mockResolvedValueOnce({ input_per_mtok: 3, cached_input_per_mtok: 0.3, output_per_mtok: 12 });
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-8', '--conduction-id', 'cond-8', '--model', 'gpt-6.1-sol']);
    expect(fetchCatalogPrice).toHaveBeenLastCalledWith(expect.anything(), 'gpt-6.1-sol', 'codex');
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    // (5400 − 4100) × 3 + 4100 × 0.3 + 610 × 12 = 3900 + 1230 + 7320 = 12450 per million = 0.01245
    expect(row.total_cost_usd).toBeCloseTo(0.01245, 10);
    expect(row.cost_source).toBe('derived');
  });

  it('no catalog row price records the table price exactly as before', async () => {
    setEnv(CODEX_RUN_ENV);
    fetchCatalogPrice.mockResolvedValueOnce(null);
    await record(['--file', FIXTURE, ...REQUEST_ARGS, '--gate', 'build', '--leg-key', 'leg-9', '--conduction-id', 'cond-9', '--model', 'gpt-6.1-sol']);
    const row = (recordLegCost.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(row.total_cost_usd).toBeCloseTo(0.00911, 10);
    expect(row.cost_source).toBe('derived');
  });
});
