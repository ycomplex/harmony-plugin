import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueryTasksArgs {
  status?: string;
  assignee_id?: string;
  epic_id?: string;
  priority?: string;
  label_ids?: string[];
  due_date_from?: string;
  due_date_to?: string;
  stale_days?: number;
  archived?: boolean;
  sort_by?: 'position' | 'due_date' | 'priority' | 'updated_at';
  limit?: number;
}

export const queryTasksTool = {
  name: 'query_tasks',
  description:
    'Search and filter tasks with rich criteria. All filters optional, combined with AND logic. Use for targeted queries; use list_tasks for simple unfiltered listing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'Exact status match (e.g. "To Do", "In Progress")' },
      assignee_id: { type: 'string', description: 'Assignee UUID' },
      epic_id: { type: 'string', description: 'Epic UUID' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
      label_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs — tasks must have ALL of these labels',
      },
      due_date_from: { type: 'string', description: 'Due date on or after (YYYY-MM-DD)' },
      due_date_to: { type: 'string', description: 'Due date on or before (YYYY-MM-DD)' },
      stale_days: { type: 'number', description: 'Tasks not updated in this many days' },
      archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
      sort_by: {
        type: 'string',
        enum: ['position', 'due_date', 'priority', 'updated_at'],
        description: 'Sort field. Default: position.',
      },
      limit: { type: 'number', description: 'Max results to return. Default 50.' },
    },
  },
};

export async function queryTasks(
  client: SupabaseClient,
  projectId: string,
  args: QueryTasksArgs,
) {
  let query = client
    .from('tasks')
    .select(
      'id, title, status, priority, task_number, assignee_id, epic_id, description, field_values, archived, due_date, created_at, updated_at, task_labels(labels(id, name, color))',
    )
    .eq('project_id', projectId)
    .eq('archived', args.archived ?? false);

  if (args.status) query = query.eq('status', args.status);
  if (args.assignee_id) query = query.eq('assignee_id', args.assignee_id);
  if (args.epic_id) query = query.eq('epic_id', args.epic_id);
  if (args.priority) query = query.eq('priority', args.priority);
  if (args.due_date_from) query = query.gte('due_date', args.due_date_from);
  if (args.due_date_to) query = query.lte('due_date', args.due_date_to);

  if (args.stale_days) {
    const cutoff = new Date(Date.now() - args.stale_days * 86400000);
    query = query.lte('updated_at', cutoff.toISOString());
  }

  // Sort
  const sortBy = args.sort_by ?? 'position';
  const ascending = sortBy !== 'updated_at'; // updated_at sorts descending (most recent first)
  query = query.order(sortBy, { ascending });

  const { data, error } = await query.limit(args.limit ?? 50);
  if (error) throw new Error(error.message);

  // Flatten task_labels → labels
  let enriched = (data ?? []).map((t: any) => {
    const labels = (t.task_labels ?? []).map((tl: any) => tl.labels).filter(Boolean);
    const { task_labels, ...rest } = t;
    return { ...rest, labels };
  });

  // Client-side filter: tasks must have ALL specified label_ids
  if (args.label_ids && args.label_ids.length > 0) {
    enriched = enriched.filter((t: any) =>
      args.label_ids!.every((lid) => t.labels.some((l: any) => l.id === lid)),
    );
  }

  return enriched;
}
