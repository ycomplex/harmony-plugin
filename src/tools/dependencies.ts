import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const listDependenciesTool = {
  name: 'list_dependencies',
  description: 'List blockers (tasks that block this one) and downstream tasks (tasks blocked by this one).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
      },
    },
    required: ['task_id'],
  },
};

export async function listDependencies(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);

  const [blockedByRes, blockingRes] = await Promise.all([
    client
      .from('task_dependencies')
      .select('id, task_id, blocked_by_task_id, created_at, created_by, blocker:blocked_by_task_id(id, task_number, title, status)')
      .eq('task_id', resolvedId)
      .order('created_at', { ascending: true }),
    client
      .from('task_dependencies')
      .select('id, task_id, blocked_by_task_id, created_at, created_by, downstream:task_id(id, task_number, title, status)')
      .eq('blocked_by_task_id', resolvedId)
      .order('created_at', { ascending: true }),
  ]);

  if (blockedByRes.error) throw blockedByRes.error;
  if (blockingRes.error) throw blockingRes.error;

  return {
    blocked_by: blockedByRes.data ?? [],
    blocking: blockingRes.data ?? [],
  };
}
