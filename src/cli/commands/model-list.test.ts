// B-1346: `harmony model list [--agent <id>]` — each active offer with its provider and catalog price
// (read only through fetchCatalogPrice, mocked here), and `list-aliases` left byte-for-byte unchanged.

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import type { SupabaseClient } from '@supabase/supabase-js';
import { registerModelCommands } from './model.js';

const mocks = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn(), fetchCatalogPrice: vi.fn() }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.getAuthenticatedContext }));
vi.mock('../../tools/catalog-pricing.js', () => ({ fetchCatalogPrice: mocks.fetchCatalogPrice }));

const sol = { alias: 'codex:gpt-6.1-sol', label: 'Sol', context_budget_bytes: 1, active: true, verified_at: null, agent: 'codex', model_id: 'gpt-6.1-sol', provider: null };
const orOffer = { alias: 'codex:or-kimi', label: 'Kimi', context_budget_bytes: 1, active: true, verified_at: null, agent: 'codex', model_id: 'moonshot/kimi', provider: 'openrouter' };
const hidden = { alias: 'codex:or-hidden', label: 'Hidden', context_budget_bytes: 1, active: false, verified_at: null, agent: 'codex', model_id: 'or/hidden', provider: 'openrouter' };
const opus = { alias: 'claude-opus-5', label: 'Opus', context_budget_bytes: 1, active: true, verified_at: null, agent: 'claude-code', model_id: 'claude-opus-5', provider: null };
const ROWS = [sol, orOffer, hidden, opus];

/** The catalog read: `.eq('active', true)` returns active rows; an unfiltered await returns all. */
function catalogClient(rows: unknown[]): SupabaseClient {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => Promise.resolve({ data: (rows as { active: boolean }[]).filter((r) => r.active), error: null });
  chain.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok, bad);
  return { from: () => chain } as unknown as SupabaseClient;
}

const run = (argv: string[]) => {
  const program = new Command();
  program.name('harmony');
  registerModelCommands(program);
  return program.parseAsync(argv, { from: 'user' });
};

let logSpy: MockInstance;
let errSpy: MockInstance;
let client: SupabaseClient;
const lines = () => logSpy.mock.calls.map((c) => c[0] as string);
const HEADER = 'model\truntime\tprovider\tinput_usd_per_mtok\tcached_input_usd_per_mtok\toutput_usd_per_mtok';

beforeEach(() => {
  vi.clearAllMocks();
  client = catalogClient(ROWS);
  mocks.getAuthenticatedContext.mockResolvedValue({ client, projectId: 'p', userId: 'u' });
  mocks.fetchCatalogPrice.mockResolvedValue(null);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

describe('harmony model list (B-1346)', () => {
  it('prints a header, then each active offer of the runtime with its provider and prices', async () => {
    mocks.fetchCatalogPrice.mockImplementation(async (_c: unknown, model: string) =>
      model === 'gpt-6.1-sol'
        ? { input_per_mtok: 1.25, cached_input_per_mtok: 0.125, output_per_mtok: 10 }
        : { input_per_mtok: 0.6, cached_input_per_mtok: 0.15, output_per_mtok: 2.5 },
    );
    await run(['model', 'list', '--agent', 'codex']);
    expect(lines()).toEqual([
      HEADER,
      'gpt-6.1-sol\tcodex\topenai\t1.25\t0.125\t10',
      'moonshot/kimi\tcodex\topenrouter\t0.6\t0.15\t2.5',
    ]);
    expect(mocks.fetchCatalogPrice).toHaveBeenCalledWith(client, 'gpt-6.1-sol', 'codex');
    expect(mocks.fetchCatalogPrice).toHaveBeenCalledWith(client, 'moonshot/kimi', 'codex');
  });

  it('defaults to the claude-code runtime, whose provider defaults to anthropic', async () => {
    await run(['model', 'list']);
    expect(lines()).toEqual([HEADER, 'claude-opus-5\tclaude-code\tanthropic\tnot captured\tnot captured\tnot captured']);
  });

  it('prints "not captured" when fetchCatalogPrice returns null', async () => {
    await run(['model', 'list', '--agent', 'codex']);
    expect(lines().slice(1)).toEqual([
      'gpt-6.1-sol\tcodex\topenai\tnot captured\tnot captured\tnot captured',
      'moonshot/kimi\tcodex\topenrouter\tnot captured\tnot captured\tnot captured',
    ]);
  });

  it('prints "not captured" for an individual null price field', async () => {
    mocks.fetchCatalogPrice.mockResolvedValue({ input_per_mtok: 2, cached_input_per_mtok: null, output_per_mtok: 8 });
    await run(['model', 'list', '--agent', 'codex']);
    expect(lines()[1]).toBe('gpt-6.1-sol\tcodex\topenai\t2\tnot captured\t8');
  });

  it('list-aliases output is unchanged: one model id per line, no header, no price read', async () => {
    await run(['model', 'list-aliases', '--agent', 'codex']);
    expect(lines()).toEqual(['gpt-6.1-sol', 'moonshot/kimi']);
    expect(mocks.fetchCatalogPrice).not.toHaveBeenCalled();
  });
});
