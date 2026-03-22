import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { resolveAssignee } from './members.js';

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
      label_ids: { type: 'array', items: { type: 'string' }, description: 'Filter by label IDs (OR logic)' },
      limit: { type: 'number', description: 'Max results to return. Default 50.' },
      offset: { type: 'number', description: 'Number of results to skip (for pagination). Default 0.' },
    },
  },
};

export async function listTasks(
  client: SupabaseClient,
  projectId: string,
  args: { status?: string; epic_id?: string; assignee_id?: string; archived?: boolean; label_ids?: string[]; limit?: number; offset?: number }
) {
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  let query = client
    .from('tasks')
    .select('id, title, status, priority, task_number, assignee_id, epic_id, description, field_values, archived, due_date, task_labels(labels(id, name, color))')
    .eq('project_id', projectId)
    .eq('archived', args.archived ?? false)
    .order('position')
    .range(offset, offset + limit - 1);

  if (args.status) query = query.eq('status', args.status);
  if (args.epic_id) query = query.eq('epic_id', args.epic_id);
  if (args.assignee_id) query = query.eq('assignee_id', args.assignee_id);

  const { data, error } = await query;
  if (error) throw error;

  let enriched = (data ?? []).map((t: any) => {
    const labels = (t.task_labels ?? []).map((tl: any) => tl.labels).filter(Boolean);
    const { task_labels, ...rest } = t;
    return { ...rest, labels };
  });

  if (args.label_ids && args.label_ids.length > 0) {
    enriched = enriched.filter(t => t.labels.some((l: any) => args.label_ids!.includes(l.id)));
  }

  return enriched;
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
    .select('*, task_labels(labels(id, name, color)), subtasks(id, title, completed, position)')
    .eq('id', resolvedId)
    .eq('project_id', projectId)
    .single();
  if (error) throw error;
  const labels = (data.task_labels ?? []).map((tl: any) => tl.labels).filter(Boolean);
  const subtasks = ((data as any).subtasks ?? []).sort((a: any, b: any) => a.position - b.position);
  const { task_labels, subtasks: _subtasks, ...rest } = data as any;
  return { ...rest, labels, subtasks };
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
      assignee_id: { type: 'string', description: 'Assignee — UUID, display name, or email. Use list_members to find users.' },
      epic_id: { type: 'string', description: 'Epic ID to assign to' },
      description: { type: 'string', description: 'Task description (markdown)' },
      due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format' },
      field_values: { type: 'object', description: 'Custom field values keyed by field definition ID' },
      cycle_id: { type: 'string', description: 'Assign to a cycle. Optional.' },
      milestone_id: { type: 'string', description: 'Assign to a milestone. Optional.' },
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
    assignee_id?: string;
    epic_id?: string;
    description?: string;
    due_date?: string;
    field_values?: Record<string, any>;
    cycle_id?: string;
    milestone_id?: string;
  }
) {
  // Resolve assignee (accepts name, email, or UUID)
  const assigneeId = args.assignee_id
    ? await resolveAssignee(client, projectId, args.assignee_id)
    : null;

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
      assignee_id: assigneeId,
      epic_id: args.epic_id ?? null,
      description: args.description ?? null,
      due_date: args.due_date ?? null,
      field_values: args.field_values ?? {},
      position: nextPosition,
      created_by: userId,
      ...(args.cycle_id !== undefined ? { cycle_id: args.cycle_id } : {}),
      ...(args.milestone_id !== undefined ? { milestone_id: args.milestone_id } : {}),
    })
    .select()
    .single();
  if (error) throw error;
  // Log 'created' activity event
  await client.from('activity_events').insert({
    task_id: data.id,
    project_id: data.project_id,
    user_id: userId,
    event_type: 'created',
  });
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
      assignee_id: { type: 'string', description: 'Assignee — UUID, display name, or email (null to unassign). Use list_members to find users.' },
      epic_id: { type: 'string', description: 'New epic ID (null to unassign)' },
      description: { type: 'string', description: 'New description' },
      due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format (null to clear)' },
      archived: { type: 'boolean', description: 'Archive or unarchive' },
      field_values: { type: 'object', description: 'Custom field values to merge (keyed by field definition ID)' },
      label_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs to assign. Replaces all existing labels. Omit to leave unchanged.',
      },
      cycle_id: { type: 'string', description: 'Assign to a cycle. Optional.' },
      milestone_id: { type: 'string', description: 'Assign to a milestone. Optional.' },
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
  const { task_id: _discarded, field_values, label_ids, ...updates } = args;

  // Resolve assignee if provided (accepts name, email, or UUID)
  if (updates.assignee_id && updates.assignee_id !== 'null') {
    updates.assignee_id = await resolveAssignee(client, projectId, updates.assignee_id);
  } else if (updates.assignee_id === 'null') {
    updates.assignee_id = null;
  }

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

  let taskData: any;
  // Only run task update if there are actual task field changes
  if (Object.keys(payload).length > 0) {
    const { data, error } = await client
      .from('tasks')
      .update(payload)
      .eq('id', resolvedId)
      .eq('project_id', projectId)
      .select()
      .single();
    if (error) throw error;
    taskData = data;
  } else {
    // Fetch current task data if no field updates
    const { data, error } = await client
      .from('tasks')
      .select('*')
      .eq('id', resolvedId)
      .eq('project_id', projectId)
      .single();
    if (error) throw error;
    taskData = data;
  }

  // Sync labels if label_ids provided
  if (label_ids !== undefined) {
    await client.from('task_labels').delete().eq('task_id', resolvedId);
    if (label_ids.length > 0) {
      await client.from('task_labels').insert(
        label_ids.map((id: string) => ({ task_id: resolvedId, label_id: id }))
      );
    }
  }

  return taskData;
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
  // Log 'created' activity event for each task in the batch
  await client.from('activity_events').insert(
    (data ?? []).map((task: any) => ({
      task_id: task.id,
      project_id: task.project_id,
      user_id: userId,
      event_type: 'created',
    }))
  );
  return data;
}
