import { describe, it, expect, vi } from 'vitest';
import { flagFasttrackHandoff, handoffInstruction, handoffOperation } from './fasttrack-handoff.js';
vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: async () => 'ticket' }));
vi.mock('./comments.js', () => ({ addComment: vi.fn(async () => ({})) }));
import { addComment } from './comments.js';
const pr = { pr_url: 'https://github.com/example/atlas/pull/72', pr_number: 72, head_sha: 'abc' };
function client(code?: string) { const c = { rpc: vi.fn(async () => ({ data: { applied: true }, error: code ? { code } : null })), from: vi.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { field_values: { build_pr: pr } } }) }) }) }) })) };return c as any; }
describe('interactive handoff', () => {
  it('sets with the exact recorded PR identity', async () => { const c=client();expect(await flagFasttrackHandoff(c,'project','user',{task_id:'B-1'})).toEqual({applied:true});expect(c.rpc).toHaveBeenCalledWith('fasttrack_handoff',expect.objectContaining({p_action:'set',p_expected:pr})); });
  it.each(['42883','PGRST202'])('only missing function %s falls back with an explicit unsaved-state notice', async code => { const r=await flagFasttrackHandoff(client(code),'project','user',{task_id:'B-1'});expect(r).toMatchObject({applied:false,reason:'function-unavailable'});expect(addComment).toHaveBeenCalledWith(expect.anything(),'project','user',expect.objectContaining({content:expect.stringContaining('pending state could not be saved')})); });
  it.each(['42501','PGRST301','08006'])('other failure %s stays an error', async code => { await expect(flagFasttrackHandoff(client(code),'project','user',{task_id:'B-1'})).rejects.toEqual({code}); });
  it('forwards matching identity on clear', async () => { const c=client();await handoffOperation(c,'ticket','clear',pr);expect(c.rpc).toHaveBeenCalledWith('fasttrack_handoff',expect.objectContaining({p_action:'clear',p_expected:pr})); });
  it('renders the accepted sentence without inventing an absent number', () => { expect(handoffInstruction({pr_number:72})).toBe('Merge PR #72, then re-run fast-track (or harmony record) and confirm the work with an attestation sentence.');expect(handoffInstruction({})).toContain('Merge the PR,'); });
});
