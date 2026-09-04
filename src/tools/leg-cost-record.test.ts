// B-916: unit coverage for the leg-cost shared-core accessors — above all, that the WRITE NEVER
// THROWS. That is not a nicety: harmony-web's `conduction_leg_costs` migration promotes on its own
// schedule, so between this plugin merging and that promotion every insert here is rejected by
// PostgREST with a table-absent error. A thrown error there would ride out of the CLI accessor into
// container/provision.sh's `set -euo pipefail` script and fail the leg — a diagnostic nicety
// killing the run it was meant to describe.

import { describe, it, expect, vi } from 'vitest';
import { recordLegCost, listLegCosts, resolveLegCostContext } from './leg-cost-record.js';

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
