import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { addComment } from './comments.js';

export const FASTTRACK_REASON = 'fast-track-merge-pending';
export type HandoffRef = { kind: 'fast-track-merge'; pr_url: string; pr_number?: number; repo?: string; head_sha: string; refusal_reason?: string; recording_until?: string; recording_id?: string };
export function handoffInstruction(ref: Partial<HandoffRef>): string {
  return `Merge ${ref.pr_number ? `PR #${ref.pr_number}` : 'the PR'}, then re-run fast-track (or harmony record) and confirm the work with an attestation sentence.`;
}
export async function handoffOperation(client: SupabaseClient, taskId: string, action: string, expected: unknown, refusal?: string) {
  const { data, error } = await client.rpc('fasttrack_handoff', { p_task_id: taskId, p_action: action, p_expected: expected, p_refusal: refusal ?? null });
  if (error) throw error;
  return data as { applied: boolean; reason?: string; ref?: HandoffRef };
}
export async function flagFasttrackHandoff(client: SupabaseClient, projectId: string, userId: string, args: { task_id: string }) {
  const taskId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client.from('tasks').select('field_values').eq('id', taskId).eq('project_id', projectId).single();
  if (error) throw error;
  const pr = data?.field_values?.build_pr;
  try {
    return await handoffOperation(client, taskId, 'set', pr);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code !== '42883' && code !== 'PGRST202') throw error;
    const message = 'The PR is recorded, but the pending state could not be saved: the board does not yet have the handoff function. Merge the PR, then re-run fast-track or harmony record with your own attestation sentence.';
    await addComment(client, projectId, userId, { task_id: taskId, content: message });
    return { applied: false, reason: 'function-unavailable', message };
  }
}
export const flagFasttrackHandoffTool = {
  name: 'flag_fasttrack_handoff',
  description: 'Mark a standalone interactive fast-track PR as waiting for the human to merge and record. Preserves workflow state and refuses other pause owners.',
  inputSchema: { type: 'object' as const, properties: { task_id: { type: 'string' } }, required: ['task_id'] },
};
