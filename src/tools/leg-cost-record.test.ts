// B-916: unit coverage for the leg-cost shared-core accessors — above all, that the WRITE NEVER
// THROWS. That is not a nicety: harmony-web's `conduction_leg_costs` migration promotes on its own
// schedule, so between this plugin merging and that promotion every insert here is rejected by
// PostgREST with a table-absent error. A thrown error there would ride out of the CLI accessor into
// container/provision.sh's `set -euo pipefail` script and fail the leg — a diagnostic nicety
// killing the run it was meant to describe.

import { describe, it, expect, vi } from 'vitest';
import { recordLegCost, listLegCosts, resolveLegCostContext, ownUsageDelta, sumPriorSessionUsage } from './leg-cost-record.js';

/** A chainable supabase mock, same shape as conduction-record.test.ts's makeClient: terminal
 *  methods pop a queued response in call order. `insert` is terminal here (recordLegCost awaits the
 *  builder directly — no trailing .select()), so the chain is thenable. */
function makeClient(responses: Array<{ data?: unknown; error?: unknown; count?: number }>) {
  let i = 0;
  const next = () => responses[i++] ?? { data: null, error: null };
  const chain: any = { calls: [] as Array<{ method: string; args: unknown[] }> };
  for (const m of ['from', 'select', 'insert', 'eq', 'order']) {
    chain[m] = vi.fn((...args: unknown[]) => {
      chain.calls.push({ method: m, args });
      return chain;
    });
  }
  chain.maybeSingle = vi.fn(async () => next());
  chain.then = (resolve: (v: unknown) => void) => resolve(next());
  return chain;
}

/** A client whose every call explodes — the "not even a PostgrestError, the client itself is
 *  broken" case. */
function throwingClient() {
  const chain: any = {};
  chain.from = vi.fn(() => {
    throw new Error('kaboom');
  });
  return chain;
}

const TABLE_ABSENT = {
  code: '42P01',
  message: 'relation "public.conduction_leg_costs" does not exist',
};

const baseArgs = { conduction_id: 'cond-1', leg_key: 'leg-1', invocation_index: 0 };

describe('recordLegCost', () => {
  it('inserts ONE row per invocation, carrying every measured column', async () => {
    const client = makeClient([{ error: null }]);
    const ok = await recordLegCost(client, {
      ...baseArgs,
      task_id: 'task-1',
      gate: 'build',
      model: 'claude-opus-5',
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 900,
      cache_creation_1h_input_tokens: 400,
      cache_creation_5m_input_tokens: 500,
      thinking_tokens: 700,
      total_cost_usd: 1.25,
      cost_source: 'cli',
      num_turns: 12,
      duration_ms: 900_000,
      duration_api_ms: 400_000,
      session_id: 'sess-abc',
      is_error: true,
      service_tier: 'standard',
    });

    expect(ok).toBe(true);
    expect(client.from).toHaveBeenCalledWith('conduction_leg_costs');
    expect(client.insert).toHaveBeenCalledWith({
      conduction_id: 'cond-1',
      task_id: 'task-1',
      leg_key: 'leg-1',
      gate: 'build',
      model: 'claude-opus-5',
      invocation_index: 0,
      input_tokens: 1000,
      output_tokens: 2000,
      cache_read_input_tokens: 3000,
      cache_creation_input_tokens: 900,
      cache_creation_1h_input_tokens: 400,
      cache_creation_5m_input_tokens: 500,
      thinking_tokens: 700,
      total_cost_usd: 1.25,
      cost_source: 'cli',
      num_turns: 12,
      duration_ms: 900_000,
      duration_api_ms: 400_000,
      session_id: 'sess-abc',
      is_error: true,
      service_tier: 'standard',
      runtime: null,
      credential_kind: null,
      cost_regime: null,
    });
  });

  it("defaults an unmeasured row to nulls, is_error false and cost_source 'unknown' — recording THAT an invocation happened is itself worth having", async () => {
    const client = makeClient([{ error: null }]);
    expect(await recordLegCost(client, baseArgs)).toBe(true);
    const row = client.insert.mock.calls[0][0];
    expect(row.cost_source).toBe('unknown');
    expect(row.total_cost_usd).toBeNull();
    expect(row.is_error).toBe(false);
    expect(row.gate).toBeNull();
    expect(row.model).toBeNull();
  });

  it('NEVER THROWS on a MISSING TABLE — swallows it, warns once on stderr, and returns false (the B-846 pre-migration shape)', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: TABLE_ABSENT }]);

    await expect(recordLegCost(client, baseArgs)).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('relation "public.conduction_leg_costs" does not exist');
    warn.mockRestore();
  });

  it('NEVER THROWS when the client itself blows up mid-call', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(recordLegCost(throwingClient(), baseArgs)).resolves.toBe(false);
    expect(warn.mock.calls[0][0]).toContain('kaboom');
    warn.mockRestore();
  });

  it('skips (returns false, writes nothing) without a client, a conduction id, or a leg key', async () => {
    const client = makeClient([{ error: null }]);
    expect(await recordLegCost(null, baseArgs)).toBe(false);
    expect(await recordLegCost(client, { ...baseArgs, conduction_id: '' })).toBe(false);
    expect(await recordLegCost(client, { ...baseArgs, leg_key: '' })).toBe(false);
    expect(client.insert).not.toHaveBeenCalled();
  });

  it("derives invocation_index from this leg's already-recorded row count when the caller omits it", async () => {
    // Response 1 answers the count query; response 2 answers the insert.
    const client = makeClient([{ count: 3, error: null }, { error: null }]);
    await recordLegCost(client, { conduction_id: 'cond-1', leg_key: 'leg-1' });
    expect(client.insert.mock.calls[0][0].invocation_index).toBe(3);
  });

  it('degrades the derived invocation_index to 0 (never throws) when the count query fails', async () => {
    const client = makeClient([{ error: TABLE_ABSENT }, { error: null }]);
    await recordLegCost(client, { conduction_id: 'cond-1', leg_key: 'leg-1' });
    expect(client.insert.mock.calls[0][0].invocation_index).toBe(0);
  });
});

describe('listLegCosts', () => {
  it("reads one conduction's rows oldest-first, optionally narrowed to one leg", async () => {
    const rows = [{ id: 'row-1', leg_key: 'leg-1' }];
    const client = makeClient([{ data: rows, error: null }]);
    const result = await listLegCosts(client, { conduction_id: 'cond-1', leg_key: 'leg-1' });
    expect(result).toEqual(rows);
    expect(client.eq).toHaveBeenCalledWith('conduction_id', 'cond-1');
    expect(client.eq).toHaveBeenCalledWith('leg_key', 'leg-1');
    expect(client.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(client.order).toHaveBeenCalledWith('invocation_index', { ascending: true });
  });

  it('NEVER THROWS on a missing table — returns [] and warns', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: TABLE_ABSENT }]);
    await expect(listLegCosts(client, { conduction_id: 'cond-1' })).resolves.toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns [] without a client or a conduction id', async () => {
    expect(await listLegCosts(null, { conduction_id: 'cond-1' })).toEqual([]);
    expect(await listLegCosts(makeClient([]), { conduction_id: '' })).toEqual([]);
  });
});

describe('resolveLegCostContext', () => {
  it("reads the conduction's task id and the owning task's workflow position in ONE embedded query", async () => {
    const client = makeClient([
      { data: { task_id: 'task-1', tasks: { workflow_state: 'Planned', workflow_activity: 'building' } } },
    ]);
    await expect(resolveLegCostContext(client, 'cond-1')).resolves.toEqual({
      task_id: 'task-1',
      workflow_state: 'Planned',
      workflow_activity: 'building',
    });
    expect(client.select).toHaveBeenCalledWith('task_id, tasks(workflow_state, workflow_activity)');
  });

  it('returns null (never throws) with no client, no id, an error, or a missing row', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await resolveLegCostContext(null, 'cond-1')).toBeNull();
    expect(await resolveLegCostContext(makeClient([]), '')).toBeNull();
    expect(await resolveLegCostContext(makeClient([{ error: TABLE_ABSENT }]), 'cond-1')).toBeNull();
    expect(await resolveLegCostContext(makeClient([{ data: null }]), 'cond-1')).toBeNull();
    expect(await resolveLegCostContext(throwingClient(), 'cond-1')).toBeNull();
    warn.mockRestore();
  });
});

describe('B-1078 runtime columns', () => {
  const COLUMN_ABSENT = {
    code: 'PGRST204',
    message: "Could not find the 'cost_regime' column of 'conduction_leg_costs' in the schema cache",
  };
  const inserted = (c: any) => c.calls.filter((x: any) => x.method === 'insert').map((x: any) => x.args[0]);

  it('includes runtime, credential_kind and cost_regime in the insert', async () => {
    const client = makeClient([{ error: null }]);
    const ok = await recordLegCost(client, {
      ...baseArgs,
      runtime: 'claude-code',
      credential_kind: 'subscription-token',
      cost_regime: 'plan-included',
    });
    expect(ok).toBe(true);
    expect(inserted(client)[0]).toMatchObject({
      runtime: 'claude-code',
      credential_kind: 'subscription-token',
      cost_regime: 'plan-included',
    });
  });

  it('writes nulls when the facts are absent', async () => {
    const client = makeClient([{ error: null }]);
    await recordLegCost(client, baseArgs);
    expect(inserted(client)[0]).toMatchObject({ runtime: null, credential_kind: null, cost_regime: null });
  });

  it('retries ONCE without the three fields on a column-absent error', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: COLUMN_ABSENT }, { error: null }]);
    const ok = await recordLegCost(client, { ...baseArgs, runtime: 'claude-code', credential_kind: 'api-key', cost_regime: 'metered' });
    expect(ok).toBe(true);
    const rows = inserted(client);
    expect(rows).toHaveLength(2);
    expect(rows[1]).not.toHaveProperty('runtime');
    expect(rows[1]).not.toHaveProperty('credential_kind');
    expect(rows[1]).not.toHaveProperty('cost_regime');
    expect(rows[1]).toMatchObject({ conduction_id: 'cond-1', leg_key: 'leg-1' });
    warn.mockRestore();
  });

  it('matches Postgres 42703 wording too', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: { code: '42703', message: 'column "runtime" of relation "conduction_leg_costs" does not exist' } }, { error: null }]);
    expect(await recordLegCost(client, baseArgs)).toBe(true);
    expect(inserted(client)).toHaveLength(2);
    warn.mockRestore();
  });

  it('does NOT retry on an unrelated error, and never throws', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: TABLE_ABSENT }, { error: null }]);
    expect(await recordLegCost(client, baseArgs)).toBe(false);
    expect(inserted(client)).toHaveLength(1);
    warn.mockRestore();
  });

  it('returns false (no throw) when the retry also fails', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ error: COLUMN_ABSENT }, { error: TABLE_ABSENT }]);
    expect(await recordLegCost(client, baseArgs)).toBe(false);
    warn.mockRestore();
  });

  it('listLegCosts selects the new columns, and falls back to the old set on a column error', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = makeClient([{ data: null, error: COLUMN_ABSENT }, { data: [{ id: 'r1' }], error: null }]);
    const rows = await listLegCosts(client, { conduction_id: 'cond-1' });
    expect(rows).toEqual([{ id: 'r1' }]);
    const selects = client.calls.filter((x: any) => x.method === 'select').map((x: any) => x.args[0]);
    expect(selects[0]).toContain('cost_regime');
    expect(selects[1]).not.toContain('cost_regime');
    warn.mockRestore();
  });
});

describe('B-1149 refusal columns + resumed-thread delta', () => {
  const REFUSAL_ABSENT = { code: 'PGRST204', message: "Could not find the 'refusal_kind' column of 'conduction_leg_costs' in the schema cache" };

  it('writes refusal_kind / refusal_resets_at when a refusal is present', async () => {
    const client = makeClient([{ error: null }]);
    expect(await recordLegCost(client, { ...baseArgs, refusal_kind: 'quota', refusal_resets_at: '2026-10-17T20:00:00.000Z' })).toBe(true);
    const inserted = client.calls.filter((c: { method: string }) => c.method === 'insert');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].args[0]).toMatchObject({ refusal_kind: 'quota', refusal_resets_at: '2026-10-17T20:00:00.000Z' });
  });

  it('omits the refusal columns entirely when there is no refusal (an ordinary row is unchanged)', async () => {
    const client = makeClient([{ error: null }]);
    await recordLegCost(client, baseArgs);
    const row = client.calls.find((c: { method: string }) => c.method === 'insert').args[0];
    expect('refusal_kind' in row).toBe(false);
    expect('refusal_resets_at' in row).toBe(false);
  });

  it('TOLERANT: the columns not existing yet ⇒ retried once without them, and the row lands', async () => {
    const client = makeClient([{ error: REFUSAL_ABSENT }, { error: null }]);
    expect(await recordLegCost(client, { ...baseArgs, refusal_kind: 'rate-limit', refusal_resets_at: null })).toBe(true);
    const inserts = client.calls.filter((c: { method: string }) => c.method === 'insert');
    expect(inserts).toHaveLength(2);
    expect('refusal_kind' in inserts[1].args[0]).toBe(false);
    expect(inserts[1].args[0]).toMatchObject({ runtime: null }); // the runtime group is still sent
  });

  it('ownUsageDelta subtracts the earlier rows of the same thread, clamped at 0', () => {
    expect(ownUsageDelta({ inputTokens: 5400, cacheReadInputTokens: 4100, outputTokens: 610 }, { input_tokens: 1200, cache_read_input_tokens: 300, output_tokens: 90 })).toEqual({ inputTokens: 4200, cacheReadInputTokens: 3800, outputTokens: 520 });
    expect(ownUsageDelta({ inputTokens: 100, cacheReadInputTokens: null, outputTokens: 5 }, { input_tokens: 500, cache_read_input_tokens: 0, output_tokens: 9 })).toEqual({ inputTokens: 0, cacheReadInputTokens: null, outputTokens: 0 });
    expect(ownUsageDelta({ inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 }, null)).toEqual({ inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 });
  });

  it('sumPriorSessionUsage sums the thread\'s earlier rows; null on a read error', async () => {
    const ok = makeClient([{ data: [{ input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 5 }, { input_tokens: 50, cache_read_input_tokens: null, output_tokens: 1 }], error: null }]);
    expect(await sumPriorSessionUsage(ok, { conduction_id: 'cond-1', session_id: 'th-1' })).toEqual({ input_tokens: 150, cache_read_input_tokens: 10, output_tokens: 6 });
    expect(ok.calls.filter((c: { method: string }) => c.method === 'eq').map((c: { args: unknown[] }) => c.args)).toEqual([['conduction_id', 'cond-1'], ['session_id', 'th-1']]);
    const bad = makeClient([{ data: null, error: TABLE_ABSENT }]);
    expect(await sumPriorSessionUsage(bad, { conduction_id: 'cond-1', session_id: 'th-1' })).toBeNull();
  });
});
