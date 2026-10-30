// B-1178: `harmony agent provider` — which provider serves an EXPLICITLY named model (inactive rows too),
// the facts the launchers need (names only), and its exit contract: 0 known, 1 unknown model / no catalog,
// 2 a provider this build does not know.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describeOfferProvider, registerAgentCommands } from './agent.js';
import type { ModelCatalogEntry } from '../../config/run-config.js';

const authMock = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn() }));
vi.mock('../auth.js', () => authMock);

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Applies the active filter the way PostgREST does: `.eq('active', true)` → active rows; a bare
 *  awaited select → every row. */
function catalogClient(rows: ModelCatalogEntry[]): SupabaseClient {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (col: string, val: unknown) => Promise.resolve({ data: rows.filter((r) => (r as unknown as Record<string, unknown>)[col] === val), error: null });
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, bad);
  return { from: () => chain } as unknown as SupabaseClient;
}

const row = (o: Partial<ModelCatalogEntry>): ModelCatalogEntry => ({
  alias: 'codex:gpt-6.1-sol',
  label: 'Sol',
  context_budget_bytes: 1,
  active: true,
  verified_at: null,
  agent: 'codex',
  model_id: 'gpt-6.1-sol',
  ...o,
});
const SOL = row({});
const OR = row({ alias: 'codex:or-qwen', model_id: 'qwen/qwen-9', provider: 'openrouter', context_window_tokens: 262144 });
const OR_RETIRED = row({ alias: 'codex:or-old', model_id: 'or/old', provider: 'openrouter', active: false, context_window_tokens: null });
const ALIEN = row({ alias: 'codex:alien', model_id: 'alien/1', provider: 'martian' });

let out: string;
let errSpy: MockInstance;
let exitSpy: MockInstance;
let writeSpy: MockInstance;
beforeEach(() => {
  out = '';
  writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
    out += s;
    return true;
  }) as never);
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
  authMock.getAuthenticatedContext.mockResolvedValue({ client: catalogClient([SOL, OR, OR_RETIRED, ALIEN]), projectId: 'p', userId: 'u' });
});
afterEach(() => {
  writeSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
  authMock.getAuthenticatedContext.mockReset();
});

async function run(args: string[]): Promise<number | null> {
  const program = new Command();
  registerAgentCommands(program);
  try {
    await program.parseAsync(['agent', 'provider', ...args], { from: 'user' });
    return null;
  } catch (e) {
    if (e instanceof ExitSentinel) return e.code;
    throw e;
  }
}

describe('harmony agent provider', () => {
  it('an OpenAI offer (no provider on the row) prints openai', async () => {
    expect(await run(['--model', 'gpt-6.1-sol'])).toBeNull();
    expect(out).toBe('openai\n');
  });

  it('a provider offer prints its provider, by either catalog spelling', async () => {
    await run(['--model', 'codex:or-qwen']);
    expect(out).toBe('openrouter\n');
  });

  it('--field gives the launchers the env var, the secret NAME and the context window', async () => {
    for (const [field, want] of [
      ['env-key', 'OPENROUTER_API_KEY'],
      ['secret', 'harmony-provider-openrouter-key'],
      ['context-window', '262144'],
      ['base-url', 'https://openrouter.ai/api/v1'],
    ]) {
      out = '';
      await run(['--model', 'qwen/qwen-9', '--field', field]);
      expect(out).toBe(`${want}\n`);
    }
  });

  it('--json prints every fact; an OpenAI offer carries no key names', async () => {
    await run(['--model', 'qwen/qwen-9', '--json']);
    expect(JSON.parse(out)).toEqual({
      agent: 'codex',
      model: 'qwen/qwen-9',
      provider: 'openrouter',
      env_key: 'OPENROUTER_API_KEY',
      secret: 'harmony-provider-openrouter-key',
      base_url: 'https://openrouter.ai/api/v1',
      context_window_tokens: 262144,
    });
    out = '';
    await run(['--model', 'gpt-6.1-sol', '--json']);
    expect(JSON.parse(out)).toMatchObject({ provider: 'openai', env_key: null, secret: null, base_url: null });
  });

  it('AC7: an inactive offer named explicitly still answers', async () => {
    await run(['--model', 'or/old', '--json']);
    expect(JSON.parse(out)).toMatchObject({ provider: 'openrouter', context_window_tokens: null });
  });

  it('an unknown model exits 1 with a clear message and prints nothing', async () => {
    expect(await run(['--model', 'no-such-model'])).toBe(1);
    expect(out).toBe('');
    expect(String(errSpy.mock.calls[0][0])).toContain("model 'no-such-model' is not in the live model catalog for runtime 'codex'");
  });

  it('no reachable catalog: exits 1 (the caller launches the leg as an OpenAI one, as before B-1178)', async () => {
    authMock.getAuthenticatedContext.mockRejectedValue(new Error('No active project.'));
    expect(await run(['--model', 'qwen/qwen-9'])).toBe(1);
    expect(out).toBe('');
  });

  it('a provider this build does not know exits 2, naming it — never a silent default', async () => {
    expect(await run(['--model', 'alien/1'])).toBe(2);
    expect(out).toBe('');
    expect(String(errSpy.mock.calls[0][0])).toContain("'martian'");
  });

  it('an unknown --field exits 1', async () => {
    expect(await run(['--model', 'gpt-6.1-sol', '--field', 'value'])).toBe(1);
  });
});

describe('describeOfferProvider', () => {
  it('a claude-code row reports its default provider and no key names', () => {
    const r = describeOfferProvider(row({ agent: 'claude-code', alias: 'claude-opus-5', model_id: 'claude-opus-5' }), 'claude-code');
    expect(r).toEqual({ ok: true, value: expect.objectContaining({ provider: 'anthropic', env_key: null, secret: null }) });
  });
});
