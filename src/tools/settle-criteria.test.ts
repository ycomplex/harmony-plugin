// B-1410 — settle_acceptance_criterion / get_verify_readiness: the absent-function degrade, the
// refusal mapping, the success passthrough and the unknown-argument refusal.
import { describe, expect, it, vi } from 'vitest';
import {
  settleAcceptanceCriterion,
  getVerifyReadiness,
  parseSettleRefusal,
  SETTLE_UNAVAILABLE_MESSAGE,
  READINESS_UNAVAILABLE_MESSAGE,
} from './settle-criteria.js';
import { registerTools, handleToolCall } from './index.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn(async (_c: unknown, _p: string, input: string) => `uuid-of-${input}`),
}));

const CRITERION = '11111111-1111-4111-8111-111111111111';

function makeClient(
  rpcResult: { data: unknown; error: unknown },
  criterionRow: unknown = { id: CRITERION },
) {
  const builder: any = {};
  for (const m of ['select', 'eq']) builder[m] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({ data: criterionRow, error: null }));
  return {
    from: vi.fn(() => builder),
    rpc: vi.fn(async () => rpcResult),
    builder,
  };
}

const settled = {
  settlement_id: 's-1',
  action: 'carried',
  source_task_id: 'uuid-of-B-7',
  destination_task_id: 'uuid-of-B-12',
  destination_minted: false,
  destination_criterion_id: 'c-2',
  already_settled: false,
};

describe('settleAcceptanceCriterion', () => {
  it('passes the RPC result through on success, with the resolved destination', async () => {
    const client = makeClient({ data: settled, error: null });
    const result = await settleAcceptanceCriterion(client as any, 'p', {
      criterion_id: CRITERION, action: 'carry', destination_task_id: 'B-12',
    });
    expect(result).toEqual({ status: 'settled', ...settled });
    expect(client.rpc).toHaveBeenCalledWith('settle_acceptance_criterion', {
      p_criterion_id: CRITERION,
      p_action: 'carry',
      p_destination_task_id: 'uuid-of-B-12',
      p_mint_title: null,
      p_mint_milestone: null,
      p_landing_reason: null,
      p_drop_reason: null,
    });
  });

  it('maps a mint to the p_mint_* arguments', async () => {
    const client = makeClient({ data: { ...settled, destination_minted: true }, error: null });
    await settleAcceptanceCriterion(client as any, 'p', {
      criterion_id: CRITERION, action: 'carry',
      mint: { title: 'Follow-on', milestone: 'source', landing_reason: 'the title is false without it' },
    });
    expect(client.rpc).toHaveBeenCalledWith('settle_acceptance_criterion', expect.objectContaining({
      p_destination_task_id: null,
      p_mint_title: 'Follow-on',
      p_mint_milestone: 'source',
      p_landing_reason: 'the title is false without it',
      p_drop_reason: null,
    }));
  });

  it('maps a drop to p_drop_reason only', async () => {
    const client = makeClient({ data: { ...settled, action: 'dropped', destination_task_id: null }, error: null });
    await settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'drop', drop_reason: 'superseded' });
    expect(client.rpc).toHaveBeenCalledWith('settle_acceptance_criterion', expect.objectContaining({
      p_action: 'drop', p_destination_task_id: null, p_mint_title: null, p_drop_reason: 'superseded',
    }));
  });

  it("maps a 'settle refused:' exception to a structured refusal", async () => {
    const client = makeClient({
      data: null,
      error: { code: 'P0001', message: 'settle refused: last-criterion: The last remaining criterion cannot be carried or dropped.' },
    });
    const result = await settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'drop', drop_reason: 'x' });
    expect(result).toEqual({
      status: 'refused',
      code: 'last-criterion',
      message: 'The last remaining criterion cannot be carried or dropped.',
    });
  });

  it.each(['42883', 'PGRST202'])('degrades to unavailable when the function is absent (%s)', async (code) => {
    const client = makeClient({ data: null, error: { code, message: 'function public.settle_acceptance_criterion does not exist' } });
    const result = await settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'drop', drop_reason: 'x' });
    expect(result).toEqual({ status: 'unavailable', message: SETTLE_UNAVAILABLE_MESSAGE });
  });

  it('propagates any other error', async () => {
    const client = makeClient({ data: null, error: { code: '42501', message: 'permission denied for function' } });
    await expect(settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'drop', drop_reason: 'x' }))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('refuses an unknown argument before any client call', async () => {
    const client = makeClient({ data: settled, error: null });
    await expect(settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'drop', reason: 'x' } as any))
      .rejects.toThrow('settle_acceptance_criterion does not accept: reason');
    await expect(settleAcceptanceCriterion(client as any, 'p', {
      criterion_id: CRITERION, action: 'carry', mint: { title: 't', milestone: 'none', why: 'x' },
    } as any)).rejects.toThrow('mint.why');
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it('refuses an invalid action, and carry with both a destination and a mint, without calling the RPC', async () => {
    const client = makeClient({ data: settled, error: null });
    expect(await settleAcceptanceCriterion(client as any, 'p', { criterion_id: CRITERION, action: 'tick' }))
      .toMatchObject({ status: 'refused', code: 'invalid-action' });
    expect(await settleAcceptanceCriterion(client as any, 'p', {
      criterion_id: CRITERION, action: 'carry', destination_task_id: 'B-12', mint: { title: 't', milestone: 'none' },
    })).toMatchObject({ status: 'refused', code: 'destination-required' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('refuses a criterion that is not on the named task, before the RPC', async () => {
    const client = makeClient({ data: settled, error: null }, null);
    const result = await settleAcceptanceCriterion(client as any, 'p', {
      task_id: 'B-7', criterion_id: CRITERION, action: 'drop', drop_reason: 'x',
    });
    expect(result).toMatchObject({ status: 'refused', code: 'criterion-not-found' });
    expect(client.builder.eq).toHaveBeenCalledWith('task_id', 'uuid-of-B-7');
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe('parseSettleRefusal', () => {
  it('reads the code and sentence, and ignores other messages', () => {
    expect(parseSettleRefusal({ message: 'settle refused: reason-required: A drop needs a reason.' }))
      .toEqual({ code: 'reason-required', message: 'A drop needs a reason.' });
    expect(parseSettleRefusal({ message: 'duplicate key value' })).toBeNull();
    expect(parseSettleRefusal(null)).toBeNull();
  });
});

describe('getVerifyReadiness', () => {
  const readiness = {
    build_carrying: true, is_exempt: false, exempt_reason: null, has_test_cases: true, criteria_count: 2,
    unchecked: [{ id: 'c-1', content: 'One' }], settled: [], blocked: true, missing: ['1 unticked criterion'],
  };

  it('passes the readiness through with the resolved task id', async () => {
    const client = makeClient({ data: readiness, error: null });
    expect(await getVerifyReadiness(client as any, 'p', { task_id: 'B-7' })).toEqual({ status: 'ok', ...readiness });
    expect(client.rpc).toHaveBeenCalledWith('task_verify_readiness', { p_task_id: 'uuid-of-B-7' });
  });

  it.each(['42883', 'PGRST202'])('degrades to unavailable when the function is absent (%s)', async (code) => {
    const client = makeClient({ data: null, error: { code, message: 'missing' } });
    expect(await getVerifyReadiness(client as any, 'p', { task_id: 'B-7' }))
      .toEqual({ status: 'unavailable', message: READINESS_UNAVAILABLE_MESSAGE });
  });

  it('propagates any other error', async () => {
    const client = makeClient({ data: null, error: { code: 'XX000', message: 'boom' } });
    await expect(getVerifyReadiness(client as any, 'p', { task_id: 'B-7' })).rejects.toMatchObject({ code: 'XX000' });
  });
});

describe('registration', () => {
  it('registers both tools, and dispatches settle through handleToolCall', async () => {
    const names = registerTools().map((t) => t.name);
    expect(names).toContain('settle_acceptance_criterion');
    expect(names).toContain('get_verify_readiness');
    expect(registerTools({ acceptance: true } as any).map((t) => t.name)).not.toContain('settle_acceptance_criterion');

    const client = makeClient({ data: null, error: { code: '42883', message: 'missing' } });
    const response = await handleToolCall('settle_acceptance_criterion',
      { criterion_id: CRITERION, action: 'drop', drop_reason: 'x' }, client as any, 'p', 'u');
    expect(JSON.stringify(response)).toContain(SETTLE_UNAVAILABLE_MESSAGE);
    expect((response as { isError?: boolean }).isError).toBeFalsy();
  });
});
