import { describe, it, expect, vi } from 'vitest';
import { truthCompatibleRead, truthStatePatch } from './knowledge-truth.js';
import { updateKnowledgeEntry } from './knowledge.js';

describe('truth-state compatibility', () => {
  it('returns explicit missing values on an old schema without hiding ordinary errors', async () => {
    const read = vi.fn().mockResolvedValueOnce({ data: null, error: { code: '42703', message: 'column verified_against does not exist' } })
      .mockResolvedValueOnce({ data: [{ id: 'd' }], error: null });
    expect((await truthCompatibleRead(read)).data).toEqual([{ id: 'd', verified_against: null, rollout_state: null, open_steps: null }]);
    expect(read.mock.calls.map(c => c[0])).toEqual([', verified_against, rollout_state, open_steps', '']);
    const denied = vi.fn().mockResolvedValue({ data: null, error: { code: '42501', message: 'permission denied' } });
    expect((await truthCompatibleRead(denied)).error?.code).toBe('42501');
    expect(denied).toHaveBeenCalledTimes(1);
  });
  it('never retries an unrelated missing column', async () => {
    const read = vi.fn().mockResolvedValue({ data: null, error: { code: '42703', message: 'column title does not exist' } });
    expect((await truthCompatibleRead(read)).error).not.toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('preserves populated values and explicit null-clears while omitting unrequested fields', async () => {
    const stamp = { plugin_version: '0.16.8', web_sha: 'abc1234', at: '2026-10-22T12:00:00Z' };
    const read = vi.fn().mockResolvedValue({ data: { id: 'd', verified_against: stamp, rollout_state: 'partly-live', open_steps: ['Restart conductor'] }, error: null });
    expect((await truthCompatibleRead(read)).data.verified_against).toEqual(stamp);
    expect(truthStatePatch({ verified_against: null, open_steps: [] })).toEqual({ verified_against: null, open_steps: [] });
  });
  it('uses one atomic guarded RPC for truth plus content, and fails visibly before migration', async () => {
    const rowQuery = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), single: async () => ({ data: { id: 'd', title: 'Recorded behavior', content: 'Existing content.' }, error: null }) };
    const client = { from: vi.fn((table: string) => table === 'projects'
      ? { select: () => ({ eq: () => ({ single: async () => ({ data: { workspace_id: 'w' }, error: null }) }) }) }
      : rowQuery), rpc: vi.fn().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'RPC not found' } }) };
    await expect(updateKnowledgeEntry(client as never, 'p', { entry_id: 'd', acting_task_id: 'ticket-uuid', content: 'New amendment', content_mode: 'append_section', rollout_state: 'partly-live', open_steps: ['Promote'] })).rejects.toThrow('No fields were changed');
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith('knowledge_amend_entry_truth', expect.objectContaining({ p_acting_task_id: 'ticket-uuid', p_content_mode: 'append_section', p_content: 'New amendment', p_truth_state: { rollout_state: 'partly-live', open_steps: ['Promote'] } }));
  });
});
