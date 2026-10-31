// B-1179: a leg's price read from its model-catalog row — which row is chosen, when a row counts as
// priced, and that every failure (a missing price column above all) degrades to null, never a throw.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCatalogPrice } from './catalog-pricing.js';

type Row = Record<string, unknown>;

/** A hand-rolled client: `.from().select()` resolves `{ data, error }` directly. Records what was
 *  asked — including any `.eq()` filter, so a test can prove none (no active filter) was applied. */
function fakeClient(result: { data: Row[] | null; error: unknown }) {
  const calls: { table?: string; columns?: string; eq?: [string, unknown] } = {};
  const client = {
    from(table: string) {
      calls.table = table;
      return {
        select(columns: string) {
          calls.columns = columns;
          return Object.assign(Promise.resolve(result), {
            eq(col: string, val: unknown) {
              calls.eq = [col, val];
              return Promise.resolve(result);
            },
          });
        },
      };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

const priced = (over: Row): Row => ({
  agent: 'claude-code',
  input_usd_per_mtok: 4,
  cached_input_usd_per_mtok: 0.2,
  output_usd_per_mtok: 20,
  ...over,
});

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

describe('fetchCatalogPrice — row matching', () => {
  it('reads model_catalog rows with the three price columns, and prices an EXACT alias match', async () => {
    const { client, calls } = fakeClient({
      data: [priced({ alias: 'claude-opus-5-5', model_id: 'claude-opus-5-5' }), priced({ alias: 'opus', model_id: 'opus', input_usd_per_mtok: 5 })],
      error: null,
    });
    expect(await fetchCatalogPrice(client, 'claude-opus-5-5', 'claude-code')).toEqual({
      input_per_mtok: 4,
      cached_input_per_mtok: 0.2,
      output_per_mtok: 20,
      long_context_threshold_tokens: null,
      long_context_price: null,
    });
    expect(calls.table).toBe('model_catalog');
    expect(calls.columns).toBe('alias, model_id, agent, input_usd_per_mtok, cached_input_usd_per_mtok, output_usd_per_mtok, long_context_threshold_tokens, long_context_input_usd_per_mtok, long_context_cached_input_usd_per_mtok, long_context_output_usd_per_mtok');
    // B-1179: no activation filter on the price read.
    expect(calls.eq).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('prices a leg from an INACTIVE row — an explicitly named inactive offer still launches (B-1179)', async () => {
    const row = {
      agent: 'codex',
      alias: 'codex:openrouter-offer',
      model_id: 'openrouter/vendor/some-model',
      active: false,
      input_usd_per_mtok: 0.6,
      cached_input_usd_per_mtok: 0.06,
      output_usd_per_mtok: 2.4,
    };
    const want = { input_per_mtok: 0.6, cached_input_per_mtok: 0.06, output_per_mtok: 2.4, long_context_threshold_tokens: null, long_context_price: null };
    const byAlias = fakeClient({ data: [row], error: null });
    expect(await fetchCatalogPrice(byAlias.client, 'codex:openrouter-offer', 'codex')).toEqual(want);
    expect(byAlias.calls.eq).toBeUndefined();
    expect(await fetchCatalogPrice(fakeClient({ data: [row], error: null }).client, 'openrouter/vendor/some-model', 'codex')).toEqual(want);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('an inactive and an active row sharing a model_id are two matches — null, never a guess', async () => {
    const data = [
      { agent: 'codex', alias: 'codex:offer-old', model_id: 'shared/model', active: false, input_usd_per_mtok: 1, cached_input_usd_per_mtok: 0.1, output_usd_per_mtok: 2 },
      { agent: 'codex', alias: 'codex:offer-new', model_id: 'shared/model', active: true, input_usd_per_mtok: 3, cached_input_usd_per_mtok: 0.3, output_usd_per_mtok: 6 },
    ];
    expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'shared/model', 'codex')).toBeNull();
  });

  it('matches by model_id with an optional, case-insensitive codex: prefix', async () => {
    const row = { agent: 'codex', alias: 'codex:gpt-6.1-sol', model_id: 'gpt-6.1-sol', input_usd_per_mtok: 2, cached_input_usd_per_mtok: 0.1, output_usd_per_mtok: 10 };
    const want = { input_per_mtok: 2, cached_input_per_mtok: 0.1, output_per_mtok: 10, long_context_threshold_tokens: null, long_context_price: null };
    expect(await fetchCatalogPrice(fakeClient({ data: [row], error: null }).client, 'gpt-6.1-sol', 'codex')).toEqual(want);
    expect(await fetchCatalogPrice(fakeClient({ data: [row], error: null }).client, 'CODEX:gpt-6.1-sol', 'codex')).toEqual(want);
    expect(await fetchCatalogPrice(fakeClient({ data: [row], error: null }).client, 'codex:gpt-6.1-sol', 'codex')).toEqual(want);
  });

  it('reads the OpenAI threshold and all three long-context prices from the same offer row', async () => {
    const row = {
      agent: 'codex',
      alias: 'codex:gpt-6.1-sol',
      model_id: 'gpt-6.1-sol',
      input_usd_per_mtok: 2,
      cached_input_usd_per_mtok: 0.1,
      output_usd_per_mtok: 10,
      long_context_threshold_tokens: 272000,
      long_context_input_usd_per_mtok: 4,
      long_context_cached_input_usd_per_mtok: 0.2,
      long_context_output_usd_per_mtok: 15,
    };
    expect(await fetchCatalogPrice(fakeClient({ data: [row], error: null }).client, 'codex:gpt-6.1-sol', 'codex')).toEqual({
      input_per_mtok: 2,
      cached_input_per_mtok: 0.1,
      output_per_mtok: 10,
      long_context_threshold_tokens: 272000,
      long_context_price: { input_per_mtok: 4, cached_input_per_mtok: 0.2, output_per_mtok: 15 },
    });
  });

  it('only uses a row of the leg runtime — a claude-code row is not used for a codex runtime', async () => {
    const data = [priced({ alias: 'gpt-6.1-sol', model_id: 'gpt-6.1-sol' })];
    expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'gpt-6.1-sol', 'codex')).toBeNull();
    // A row with no agent column value reads as claude-code, and a null runtime is claude-code.
    const legacy = [{ alias: 'opus', model_id: 'opus', input_usd_per_mtok: 5, cached_input_usd_per_mtok: 0.5, output_usd_per_mtok: 25 }];
    expect(await fetchCatalogPrice(fakeClient({ data: legacy, error: null }).client, 'opus', null)).toEqual({
      input_per_mtok: 5,
      cached_input_per_mtok: 0.5,
      output_per_mtok: 25,
      long_context_threshold_tokens: null,
      long_context_price: null,
    });
  });

  it('returns null when two rows share the model_id — never guesses between offers', async () => {
    const data = [
      { agent: 'codex', alias: 'codex:openrouter-a', model_id: 'openrouter/some-model', input_usd_per_mtok: 1, cached_input_usd_per_mtok: 0.1, output_usd_per_mtok: 2 },
      { agent: 'codex', alias: 'codex:openrouter-b', model_id: 'openrouter/some-model', input_usd_per_mtok: 3, cached_input_usd_per_mtok: 0.3, output_usd_per_mtok: 6 },
    ];
    expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'openrouter/some-model', 'codex')).toBeNull();
    // An exact alias still picks one of them.
    expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'codex:openrouter-b', 'codex')).toEqual({
      input_per_mtok: 3,
      cached_input_per_mtok: 0.3,
      output_per_mtok: 6,
      long_context_threshold_tokens: null,
      long_context_price: null,
    });
  });

  it('returns null when no row matches', async () => {
    const data = [priced({ alias: 'opus', model_id: 'opus' })];
    expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'sonnet-5', 'claude-code')).toBeNull();
  });

  it('returns null for a row with any price unset, negative or non-numeric', async () => {
    for (const over of [
      { input_usd_per_mtok: null },
      { cached_input_usd_per_mtok: null },
      { output_usd_per_mtok: undefined },
      { output_usd_per_mtok: -1 },
      { input_usd_per_mtok: '4' },
      { input_usd_per_mtok: Number.NaN },
    ]) {
      const data = [priced({ alias: 'opus', model_id: 'opus', ...over })];
      expect(await fetchCatalogPrice(fakeClient({ data, error: null }).client, 'opus', 'claude-code')).toBeNull();
    }
  });
});

describe('fetchCatalogPrice — degrades to null, never throws', () => {
  it.each([
    ['42703 (undefined column)', { code: '42703', message: 'column model_catalog.input_usd_per_mtok does not exist' }],
    ['B-1176 long-context columns absent during rollout', { code: '42703', message: 'column model_catalog.long_context_threshold_tokens does not exist' }],
    ['PGRST204 (schema-cache miss)', { code: 'PGRST204', message: "Could not find the 'input_usd_per_mtok' column" }],
    ['any other error', { code: '500', message: 'boom' }],
  ])('a %s read returns null with ONE warning line', async (_label, error) => {
    expect(await fetchCatalogPrice(fakeClient({ data: null, error }).client, 'opus', 'claude-code')).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toMatch(/^harmony leg-cost:/);
  });

  it('a client that throws, or one with no .from at all, returns null with a warning', async () => {
    const throwing = { from: () => { throw new Error('network down'); } } as unknown as SupabaseClient;
    await expect(fetchCatalogPrice(throwing, 'opus', 'claude-code')).resolves.toBeNull();
    await expect(fetchCatalogPrice({} as unknown as SupabaseClient, 'opus', 'claude-code')).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(2);
    for (const call of errorSpy.mock.calls) expect(String(call[0])).toMatch(/^harmony leg-cost:/);
  });

  it('a null client or a null model returns null without reading or warning', async () => {
    const { client, calls } = fakeClient({ data: [priced({ alias: 'opus' })], error: null });
    expect(await fetchCatalogPrice(null, 'opus', 'claude-code')).toBeNull();
    expect(await fetchCatalogPrice(client, null, 'claude-code')).toBeNull();
    expect(calls.table).toBeUndefined();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
