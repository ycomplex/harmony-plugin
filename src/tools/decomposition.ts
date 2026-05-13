import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const listSubtasksTool = {
  name: 'list_subtasks',
  description: 'List the immediate subtasks (children) of a task. With depth>1, walks the tree breadth-first; depth=-1 returns the full subtree.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number, or visual ID (e.g., B-43)' },
      depth: { type: 'integer', description: 'How deep to walk. 1 = immediate children only (default). -1 = unbounded.', default: 1 },
    },
    required: ['task_id'],
  },
};

export async function listSubtasks(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; depth?: number },
) {
  const rootId = await resolveTaskId(client, projectId, args.task_id);
  const depth = args.depth ?? 1;

  // Breadth-first walk up to `depth` levels.
  const all: any[] = [];
  let frontier: string[] = [rootId];
  let level = 0;
  while (frontier.length > 0 && (depth === -1 || level < depth)) {
    const { data, error } = await client
      .from('tasks')
      .select('id, parent_task_id, task_number, title, status, project_id, archived, created_at')
      .in('parent_task_id', frontier)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = data ?? [];
    if (rows.length === 0) break;
    all.push(...rows);
    frontier = rows.map((r: any) => r.id);
    level++;
  }
  return all;
}

export const listParentTool = {
  name: 'list_parent',
  description: 'Get the immediate parent of a task, or null if it has none.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number, or visual ID (e.g., B-43)' },
    },
    required: ['task_id'],
  },
};

export async function listParent(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);
  const { data: task, error: taskErr } = await client
    .from('tasks')
    .select('parent_task_id')
    .eq('id', resolvedId)
    .single();
  if (taskErr) throw taskErr;
  if (!task?.parent_task_id) return null;

  const { data: parent, error: parentErr } = await client
    .from('tasks')
    .select('id, task_number, title, status, project_id, archived')
    .eq('id', task.parent_task_id)
    .single();
  if (parentErr) throw parentErr;
  return parent;
}
