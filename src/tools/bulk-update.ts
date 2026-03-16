import type { SupabaseClient } from '@supabase/supabase-js';

export interface BulkUpdateArgs {
  task_ids: string[];
  status?: string;
  priority?: string;
  assignee_id?: string | null;
  archived?: boolean;
}

export const bulkUpdateTasksTool = {
  name: 'bulk_update_tasks',
  description:
    'Update multiple tasks at once. Supports changing status, priority, assignee, and archiving. Useful for triage and pipeline workflows.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task UUIDs to update',
      },
      status: { type: 'string', description: 'New status' },
      priority: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'New priority',
      },
      assignee_id: {
        type: ['string', 'null'],
        description: 'New assignee user ID (null to unassign)',
      },
      archived: { type: 'boolean', description: 'Archive or unarchive' },
    },
    required: ['task_ids'],
  },
};

export async function bulkUpdateTasks(
  client: SupabaseClient,
  projectId: string,
  args: BulkUpdateArgs,
) {
  if (!args.task_ids || args.task_ids.length === 0) {
    throw new Error('task_ids must not be empty');
  }

  // Build payload from defined fields only
  const payload: Record<string, unknown> = {};
  if (args.status !== undefined) payload.status = args.status;
  if (args.priority !== undefined) payload.priority = args.priority;
  if (args.assignee_id !== undefined) payload.assignee_id = args.assignee_id;
  if (args.archived !== undefined) payload.archived = args.archived;

  if (Object.keys(payload).length === 0) {
    throw new Error('At least one update field must be provided');
  }

  const { data, error } = await client
    .from('tasks')
    .update(payload)
    .eq('project_id', projectId)
    .in('id', args.task_ids)
    .select();

  if (error) throw new Error(error.message);
  return data;
}
