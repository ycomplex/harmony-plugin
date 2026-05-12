import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const listDependenciesTool = {
  name: 'list_dependencies',
  description: 'List a task\'s dependencies (tasks it depends on) and the tasks that depend on it (which it blocks).',
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

  const [dependsOnRes, blocksRes] = await Promise.all([
    client
      .from('task_dependencies')
      .select('id, task_id, blocked_by_task_id, created_at, created_by, dependency:blocked_by_task_id(id, task_number, title, status)')
      .eq('task_id', resolvedId)
      .order('created_at', { ascending: true }),
    client
      .from('task_dependencies')
      .select('id, task_id, blocked_by_task_id, created_at, created_by, dependent:task_id(id, task_number, title, status)')
      .eq('blocked_by_task_id', resolvedId)
      .order('created_at', { ascending: true }),
  ]);

  if (dependsOnRes.error) throw dependsOnRes.error;
  if (blocksRes.error) throw blocksRes.error;

  return {
    depends_on: dependsOnRes.data ?? [],
    blocks: blocksRes.data ?? [],
  };
}

export const manageDependenciesTool = {
  name: 'manage_dependencies',
  description: 'Add or remove a task\'s dependencies. Add: provide task IDs that this task depends on. Remove: provide dependency_ids (returned from list_dependencies) to remove specific links.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'Task identifier — UUID, task number, or visual ID. This is the task whose dependencies are being managed.',
      },
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task identifiers this task should depend on. Same resolution rules as task_id.',
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
    const dependencyIds = await Promise.all(
      args.add.map(id => resolveTaskId(client, projectId, id)),
    );
    for (const did of dependencyIds) {
      if (did === resolvedTaskId) {
        throw new Error('A task cannot depend on itself.');
      }
    }
    const rows = dependencyIds.map(did => ({
      task_id: resolvedTaskId,
      blocked_by_task_id: did,
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
