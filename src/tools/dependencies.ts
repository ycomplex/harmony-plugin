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

export const manageDependenciesTool = {
  name: 'manage_dependencies',
  description: 'Add or remove blockers on a task. Add: provide blocker_task_ids to declare what blocks this task. Remove: provide dependency_ids (returned from list_dependencies) to remove specific links.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number, or visual ID. This is the task that is BLOCKED.',
      },
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Blocker task identifiers to add. Same resolution rules as task_id.',
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: 'task_dependencies row IDs to delete (UUIDs from list_dependencies).',
      },
    },
    required: ['task_id'],
  },
};

export async function manageDependencies(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { task_id: string; add?: string[]; remove?: string[] },
) {
  const resolvedTaskId = await resolveTaskId(client, projectId, args.task_id);
  const result: { added: any[]; removed: string[] } = { added: [], removed: [] };

  if (args.add && args.add.length > 0) {
    const blockerIds = await Promise.all(
      args.add.map(id => resolveTaskId(client, projectId, id)),
    );
    for (const bid of blockerIds) {
      if (bid === resolvedTaskId) {
        throw new Error('A task cannot block itself.');
      }
    }
    const rows = blockerIds.map(bid => ({
      task_id: resolvedTaskId,
      blocked_by_task_id: bid,
      created_by: userId,
    }));
    const { data, error } = await client
      .from('task_dependencies')
      .insert(rows)
      .select();
    if (error) throw error;
    result.added = data ?? [];
  }

  if (args.remove && args.remove.length > 0) {
    const { error } = await client
      .from('task_dependencies')
      .delete()
      .in('id', args.remove)
      .eq('task_id', resolvedTaskId);
    if (error) throw error;
    result.removed = args.remove;
  }

  return result;
}
