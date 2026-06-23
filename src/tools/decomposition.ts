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

export const manageSubtasksTool = {
  name: 'manage_subtasks',
  description: 'Add or remove subtasks (children) of a task. Use `add` to attach existing tasks by id; use `add_new` to create new tasks and attach them in one call (the new tasks inherit project_id and epic_id from the parent unless overridden). Use `remove` to detach children.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Parent task identifier — UUID, task number, or visual ID.' },
      add: {
        type: 'array',
        items: { type: 'string' },
        description: 'Existing task identifiers to attach as children.',
      },
      add_new: {
        type: 'array',
        description: 'New tasks to create and attach as children. Each item supports the same fields as create_task; project_id and epic_id inherit from the parent unless overridden.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            description: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            status: { type: 'string' },
            assignee_id: { type: 'string' },
            due_date: { type: 'string' },
            project_id: { type: 'string' },
            epic_id: { type: 'string' },
            cycle_id: { type: 'string' },
            milestone_id: { type: 'string' },
          },
          required: ['title'],
        },
      },
      remove: {
        type: 'array',
        items: { type: 'string' },
        description: 'Child task identifiers to detach (parent_task_id is cleared on each).',
      },
    },
    required: ['task_id'],
  },
};

export async function manageSubtasks(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: {
    task_id: string;
    add?: string[];
    add_new?: Array<{
      title: string;
      description?: string;
      priority?: 'high' | 'medium' | 'low';
      status?: string;
      assignee_id?: string;
      due_date?: string;
      project_id?: string;
      epic_id?: string;
      cycle_id?: string;
      milestone_id?: string;
    }>;
    remove?: string[];
  },
) {
  const parentId = await resolveTaskId(client, projectId, args.task_id);
  const result: { attached: string[]; created: any[]; detached: string[] } = {
    attached: [],
    created: [],
    detached: [],
  };

  const { data: parent, error: parentErr } = await client
    .from('tasks')
    .select('project_id, epic_id')
    .eq('id', parentId)
    .single();
  if (parentErr) throw parentErr;

  if (args.add && args.add.length > 0) {
    const childIds = await Promise.all(args.add.map(id => resolveTaskId(client, projectId, id)));
    for (const cid of childIds) {
      if (cid === parentId) throw new Error('A task cannot be its own subtask.');
    }
    const { error } = await client
      .from('tasks')
      .update({ parent_task_id: parentId })
      .in('id', childIds);
    if (error) throw error;
    result.attached = childIds;
  }

  if (args.add_new && args.add_new.length > 0) {
    const rows = args.add_new.map(input => ({
      title: input.title,
      description: input.description,
      priority: input.priority ?? 'medium',
      status: input.status ?? 'Backlog',  // B-465: default explicitly (matches the DB default; don't rely on supabase-js dropping undefined)
      assignee_id: input.assignee_id,
      due_date: input.due_date,
      project_id: input.project_id ?? (parent as any)!.project_id,
      epic_id: input.epic_id ?? (parent as any)!.epic_id,
      cycle_id: input.cycle_id,
      milestone_id: input.milestone_id,
      parent_task_id: parentId,
      created_by: userId,
    }));
    const { data, error } = await client
      .from('tasks')
      .insert(rows)
      .select('id, task_number, title, status, project_id, parent_task_id');
    if (error) throw error;
    result.created = data ?? [];
  }

  if (args.remove && args.remove.length > 0) {
    const childIds = await Promise.all(args.remove.map(id => resolveTaskId(client, projectId, id)));
    const { error } = await client
      .from('tasks')
      .update({ parent_task_id: null })
      .in('id', childIds);
    if (error) throw error;
    result.detached = childIds;
  }

  return result;
}
