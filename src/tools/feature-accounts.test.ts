import { describe, it, expect, vi } from 'vitest';
import {
  createFeatureAccount,
  readFeatureAccounts,
  previewFeatureAmendment,
  proposeFeatureAmendment,
  applyFeatureAmendment,
  featureAccountTools,
} from './feature-accounts.js';
import { handleToolCall, registerTools } from './index.js';
const id = '00000000-0000-0000-0000-000000000001';
const proposal = {
  account_id: id,
  expected_revision: 0,
  operations: [{ op: 'insert', clause_id: 'first', ordinal: 1, content: 'Future text' }],
  leaves_untouched: [{ owner_surface: 'Other surface' }],
  source_decision_id: id,
  source_task_id: id,
  idempotency_key: 'same-key',
};
const mock = (data: unknown, error: unknown = null) =>
  ({ rpc: vi.fn().mockResolvedValue({ data, error }) }) as any;
describe('current feature accounts shared MCP/CLI core', () => {
  it('keeps explicit missing capability separate from no account, and does not cache absence', async () => {
    const client = mock(null, {
      code: 'PGRST202',
      message: 'Could not find public.read_feature_accounts',
    });
    expect(await readFeatureAccounts(client, 'p')).toEqual({
      availability: 'unavailable',
      accounts: [],
    });
    client.rpc.mockResolvedValue({
      data: { availability: 'not-found', accounts: [] },
      error: null,
    });
    expect(await readFeatureAccounts(client, 'p', { owner_surface: 'none' })).toEqual({
      availability: 'not-found',
      accounts: [],
    });
    expect(client.rpc).toHaveBeenLastCalledWith('read_feature_accounts', {
      p_project_id: 'p',
      p_owner_surface: 'none',
    });
  });
  it.each(['42501', 'PGRST301', 'ECONNRESET'])(
    'does not swallow %s as unavailability',
    async (code) => {
      await expect(
        readFeatureAccounts(mock(null, { code, message: 'read_feature_accounts failed' }), 'p'),
      ).rejects.toThrow(code);
    },
  );
  it('does not swallow missing unrelated functions or malformed responses', async () => {
    await expect(
      readFeatureAccounts(mock(null, { code: '42883', message: 'other_function absent' }), 'p'),
    ).rejects.toThrow('other_function');
    await expect(readFeatureAccounts(mock({ accounts: [] }), 'p')).rejects.toThrow('Invalid');
  });
  it('writes fail visibly on old schema without falling back or losing fields', async () => {
    const client = mock(null, { code: 'PGRST202', message: 'propose_feature_amendment missing' });
    await expect(proposeFeatureAmendment(client, 'p', proposal)).rejects.toThrow(
      'no change was made',
    );
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('propose_feature_amendment', {
      p_project_id: 'p',
      ...Object.fromEntries(Object.entries(proposal).map(([key, value]) => [`p_${key}`, value])),
    });
  });
  it('publishing requires an explicit production action', async () => {
    const client = mock({ amendment_id: id, applied_revision: 1 });
    await expect(applyFeatureAmendment(client, 'p', { amendment_id: id })).rejects.toThrow(
      'production',
    );
    await expect(
      applyFeatureAmendment(client, 'p', {
        amendment_id: id,
        production_event_id: id,
        confirm_production: true,
      }),
    ).rejects.toThrow('production');
    expect(client.rpc).not.toHaveBeenCalled();
    await applyFeatureAmendment(client, 'p', { amendment_id: id, confirm_production: true });
    expect(client.rpc).toHaveBeenCalledWith('apply_feature_amendment', {
      p_project_id: 'p',
      p_amendment_id: id,
      p_confirm_production: true,
    });
  });
  it('passes stable concept identity and preview operations through the same core', async () => {
    const client = mock({ account_id: id });
    await createFeatureAccount(client, 'p', { owner_surface: 'Project view', concept_id: id });
    expect(client.rpc).toHaveBeenCalledWith('create_feature_account', {
      p_project_id: 'p',
      p_owner_surface: 'Project view',
      p_concept_id: id,
    });
    await previewFeatureAmendment(client, 'p', {
      account_id: id,
      expected_revision: 0,
      operations: proposal.operations,
    });
    expect(client.rpc).toHaveBeenLastCalledWith('preview_feature_amendment', {
      p_project_id: 'p',
      p_account_id: id,
      p_expected_revision: 0,
      p_operations: proposal.operations,
    });
  });
  it('rejects malformed operations and unknown args before writing', async () => {
    const client = mock({});
    await expect(
      proposeFeatureAmendment(client, 'p', {
        ...proposal,
        operations: [{ op: 'replace', clause_id: 'x', content: 'x', ordinal: 1 }],
      }),
    ).rejects.toThrow();
    await expect(
      proposeFeatureAmendment(client, 'p', { ...proposal, project_id: id }),
    ).rejects.toThrow();
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('does not echo proposal bodies through the MCP mutation boundary', async () => {
    const client = mock({
      amendment_id: id,
      account_id: id,
      proposal_event_id: id,
      operations: proposal.operations,
      leaves_untouched: proposal.leaves_untouched,
    });
    const result = await handleToolCall('propose_feature_amendment', proposal, client, 'p', 'u');
    expect(result.isError).not.toBe(true);
    const ack = JSON.parse(result.content[0].text);
    expect(ack).toMatchObject({ amendment_id: id, account_id: id, proposal_event_id: id });
    expect(ack).not.toHaveProperty('operations');
  });
  it('registers and dispatches every public tool', async () => {
    for (const tool of featureAccountTools)
      expect(registerTools().some((item) => item.name === tool.name)).toBe(true);
    const client = mock({ availability: 'available', accounts: [] });
    const response = await handleToolCall('read_feature_accounts', {}, client, 'p', 'u');
    expect(response.isError).not.toBe(true);
    expect(client.rpc).toHaveBeenCalledWith('read_feature_accounts', { p_project_id: 'p' });
  });
});
