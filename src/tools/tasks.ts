import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export const listTasksTool = {
  name: 'list_tasks',
  description: 'List tasks in the project with optional filters',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'Filter by status (e.g. "To Do")' },
      epic_id: { type: 'string', description: 'Filter by epic ID' },
      assignee_id: { type: 'string', description: 'Filter by assignee user ID' },
      archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
    },
  },
};

export async function listTasks(
  client: SupabaseClient,
  projectId: string,
  args: { status?: string; epic_id?: string; assignee_id?: string; archived?: boolean }
) {
  let query = client
    .from('tasks')
    .select('id, title, status, priority, task_number, assignee_id, epic_id, description, field_values, archived, due_date')
    .eq('project_id', projectId)
    .eq('archived', args.archived ?? false)
    .order('position');

  if (args.status) query = query.eq('status', args.status);
  if (args.epic_id) query = query.eq('epic_id', args.epic_id);
  if (args.assignee_id) query = query.eq('assignee_id', args.assignee_id);

  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export const getTaskTool = {
  name: 'get_task',
  description: 'Get full details of a specific task',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
    },
    required: ['task_id'],
  },
};

export async function getTask(client: SupabaseClient, projectId: string, args: { task_id: string }) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client
    .from('tasks')
    .select('*')
    .eq('id', resolvedId)
    .eq('project_id', projectId)
    .single();
  if (error) throw error;
  return data;
}

export const createTaskTool = {
  name: 'create_task',
  description: 'Create a new task in the project',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Task title' },
      status: { type: 'string', description: 'Status (e.g. "Backlog", "To Do"). Defaults to first status.' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority. Default medium.' },
      epic_id: { type: 'string', description: 'Epic ID to assign to' },
      description: { type: 'string', description: 'Task description (markdown)' },
      due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
      field_values: { type: 'object', description: 'Custom field values keyed by field definition ID' },
    },
    required: ['title'],
  },
};

export async function createTask(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: {
    title: string;
    status?: string;
    priority?: string;
    epic_id?: string;
    description?: string;
    due_date?: string;
    field_values?: Record<string, any>;
  }
) {
  // Get next position for the target status
  const status = args.status ?? 'Backlog';
  const { data: existing } = await client
    .from('tasks')
    .select('position')
    .eq('project_id', projectId)
    .eq('status', status)
    .order('position', { ascending: false })
    .limit(1);
  const nextPosition = (existing?.[0]?.position ?? -1) + 1;

  const { data, error } = await client
    .from('tasks')
    .insert({
      project_id: projectId,
      title: args.title,
      status,
      priority: args.priority ?? 'medium',
      epic_id: args.epic_id ?? null,
      description: args.description ?? null,
      due_date: args.due_date ?? null,
      field_values: args.field_values ?? {},
      position: nextPosition,
      created_by: userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export const updateTaskTool = {
  name: 'update_task',
  description: 'Update an existing task',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
      title: { type: 'string', description: 'New title' },
      status: { type: 'string', description: 'New status' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'New priority' },
      assignee_id: { type: 'string', description: 'New assignee user ID (null to unassign)' },
      epic_id: { type: 'string', description: 'New epic ID (null to unassign)' },
      description: { type: 'string', description: 'New description' },
      due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (null to clear)' },
      archived: { type: 'boolean', description: 'Archive or unarchive' },
      field_values: { type: 'object', description: 'Custom field values to merge (keyed by field definition ID)' },
    },
    required: ['task_id'],
  },
};

export async function updateTask(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; [key: string]: any }
) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);
  const { task_id: _discarded, field_values, ...updates } = args;

  // If field_values provided, merge with existing
  let payload: Record<string, any> = {};
  for (const [k, v] of Object.entries(updates)) {
    if (v !== undefined) payload[k] = v;
  }

  if (field_values) {
    const { data: existing } = await client
      .from('tasks')
      .select('field_values')
      .eq('id', resolvedId)
      .eq('project_id', projectId)
      .single();
    payload.field_values = { ...(existing?.field_values ?? {}), ...field_values };
  }

  const { data, error } = await client
    .from('tasks')
    .update(payload)
    .eq('id', resolvedId)
    .eq('project_id', projectId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export const bulkCreateTasksTool = {
  name: 'bulk_create_tasks',
  description: 'Create multiple tasks at once',
  inputSchema: {
    type: 'object' as const,
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            epic_id: { type: 'string' },
            description: { type: 'string' },
            due_date: { type: 'string' },
            field_values: { type: 'object' },
          },
          required: ['title'],
        },
        description: 'Array of tasks to create',
      },
    },
    required: ['tasks'],
  },
};

export async function bulkCreateTasks(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { tasks: Array<{ title: string; status?: string; priority?: string; epic_id?: string; description?: string; due_date?: string; field_values?: Record<string, any> }> }
) {
  // Get current max positions per status
  const { data: allTasks } = await client
    .from('tasks')
    .select('status, position')
    .eq('project_id', projectId)
    .order('position', { ascending: false });

  const maxPositions: Record<string, number> = {};
  for (const t of allTasks ?? []) {
    if (!(t.status in maxPositions)) maxPositions[t.status] = t.position;
  }

  const rows = args.tasks.map(task => {
    const status = task.status ?? 'Backlog';
    const pos = (maxPositions[status] ?? -1) + 1;
    maxPositions[status] = pos;
    return {
      project_id: projectId,
      title: task.title,
      status,
      priority: task.priority ?? 'medium',
      epic_id: task.epic_id ?? null,
      description: task.description ?? null,
      due_date: task.due_date ?? null,
      field_values: task.field_values ?? {},
      position: pos,
      created_by: userId,
    };
  });

  const { data, error } = await client
    .from('tasks')
    .insert(rows)
    .select();
  if (error) throw error;
  return data;
}
