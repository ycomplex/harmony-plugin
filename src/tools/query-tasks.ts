import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueryTasksArgs {
  status?: string;
  assignee_id?: string;
  epic_id?: string;
  cycle_id?: string;
  milestone_id?: string;
  priority?: string;
  label_ids?: string[];
  due_date_from?: string;
  due_date_to?: string;
  stale_days?: number;
  awaiting_human_input?: boolean;
  workflow_state?: string | string[];
  workflow_activity?: string;
  stale?: boolean;
  archived?: boolean;
  sort_by?: 'position' | 'due_date' | 'priority' | 'updated_at';
  view?: 'lean' | 'full';
  limit?: number;
  offset?: number;
}

// B-690: the three OPINIONATED-ONLY filters. Passing any of them at a manual-mode project is an
// explicit error, not a silent mis-filter (the B-599/B-607 mode-conditional rule).
//
// `stale` is deliberately NOT in this list and must never be added. Its writer
// (knowledge_decision_supersede_stale) flags any task referencing a superseded decision with NO
// project-mode gate — unlike tasks_default_workflow_state, which early-returns for non-opinionated
// projects. So a manual-mode project that uses knowledge entries can legitimately carry stale tasks,
// and `stale: true` is a meaningful query there. Mode-validating it would reject a VALID query.
// A negative test in query-tasks.test.ts pins this, because the exclusion is otherwise just an
// absent identifier in the condition below and a later "complete the set" pass would undo it.
const OPINIONATED_ONLY_FILTERS = ['workflow_state', 'workflow_activity', 'awaiting_human_input'] as const;

export const queryTasksTool = {
  name: 'query_tasks',
  description:
    'Search and filter tasks with rich criteria. All filters optional, combined with AND logic. Use for targeted queries; use list_tasks for simple unfiltered listing. Rows are LEAN by default — description is omitted (a query navigates; read bodies via get_task or pass view:\'full\'). The workflow_state, workflow_activity and awaiting_human_input filters apply to opinionated-mode projects only and error on a manual-mode project; the stale filter is mode-independent and always applies.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      status: { type: 'string', description: 'Exact status match (e.g. "To Do", "In Progress")' },
      assignee_id: { type: 'string', description: 'Assignee UUID' },
      epic_id: { type: 'string', description: 'Epic UUID' },
      cycle_id: { type: 'string', description: 'Filter by cycle ID' },
      milestone_id: { type: 'string', description: 'Filter by milestone ID' },
      priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'Priority level' },
      label_ids: {
        type: 'array',
        items: { type: 'string' },
        description: 'Label IDs — tasks must have ALL of these labels',
      },
      due_date_from: { type: 'string', description: 'Due date on or after (YYYY-MM-DD)' },
      due_date_to: { type: 'string', description: 'Due date on or before (YYYY-MM-DD)' },
      stale_days: { type: 'number', description: 'Tasks not updated in this many days' },
      awaiting_human_input: { type: 'boolean', description: 'Only tasks where the ball is in the human\'s court (the opinionated-mode queue signal). Opinionated-mode projects only — errors on a manual-mode project.' },
      workflow_state: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Opinionated-mode state, e.g. "Built", "Designed". String for one state, array for a set (e.g. the non-terminal states). Opinionated-mode projects only — errors on a manual-mode project; use the status filter there.',
      },
      workflow_activity: { type: 'string', description: 'Opinionated-mode activity in progress, e.g. "building". Opinionated-mode projects only — errors on a manual-mode project.' },
      stale: { type: 'boolean', description: 'Only tasks flagged Stale (a referenced knowledge entry was superseded — P2 A8 sets this, NOT awaiting_human_input). The queue reads this separately. Mode-INDEPENDENT: the supersession coupling has no project-mode gate, so this filter is valid in manual-mode projects too and is never mode-validated.' },
      archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
      sort_by: {
        type: 'string',
        enum: ['position', 'due_date', 'priority', 'updated_at'],
        description: 'Sort field. Default: position.',
      },
      view: {
        type: 'string',
        enum: ['lean', 'full'],
        description: "Row shape. Default 'lean' — omits description so broad queries stay under the tool-result cap. 'full' restores the pre-B-690 shape including description.",
      },
      limit: { type: 'number', description: 'Max results to return. Default 50.' },
      offset: { type: 'number', description: 'Number of results to skip (for pagination). Default 0.' },
    },
  },
};

export async function queryTasks(
  client: SupabaseClient,
  projectId: string,
  args: QueryTasksArgs,
) {
  // B-690: mode-validate the opinionated-only filters LAZILY — one read, only when at least one of
  // them is present, so the common path pays nothing. Erroring (not ignoring) keeps the B-599/B-607
  // rule: a lifecycle filter must never silently mis-filter. Note the `!== undefined` tests: a
  // truthy test would skip `awaiting_human_input: false`, which is precisely the dangerous value —
  // in manual mode it matches EVERY row (the column is NOT NULL DEFAULT false).
  const passedOpinionatedFilters = OPINIONATED_ONLY_FILTERS.filter((f) => args[f] !== undefined);
  if (passedOpinionatedFilters.length > 0) {
    const { data: proj, error: projError } = await client
      .from('projects')
      .select('mode')
      .eq('id', projectId)
      .single();
    if (projError) throw projError;
    if (proj?.mode !== 'opinionated') {
      const names = passedOpinionatedFilters.join(', ');
      throw new Error(
        `The ${names} filter${passedOpinionatedFilters.length > 1 ? 's apply' : ' applies'} to opinionated-mode projects only; this project is manual-mode — use the status filter instead.`,
      );
    }
  }

  // Lean rows omit description (the bulk of a broad result's weight); view:'full' restores it.
  // Trimmed at the SELECT, not fetch-then-strip: nothing here computes over the body.
  const baseCols =
    'id, title, status, priority, task_number, assignee_id, epic_id, field_values, archived, due_date, created_at, updated_at, workflow_state, workflow_activity, awaiting_human_input, awaiting_human_reason, awaiting_human_ref, stale';
  const cols = args.view === 'full' ? `${baseCols}, description` : baseCols;

  let query = client
    .from('tasks')
    .select(`${cols}, task_labels(labels(id, name, color))`)
    .eq('project_id', projectId)
    .eq('archived', args.archived ?? false);

  if (args.status) query = query.eq('status', args.status);
  if (args.assignee_id) query = query.eq('assignee_id', args.assignee_id);
  if (args.epic_id) query = query.eq('epic_id', args.epic_id);
  if (args.cycle_id) query = query.eq('cycle_id', args.cycle_id);
  if (args.milestone_id) query = query.eq('milestone_id', args.milestone_id);
  if (args.priority) query = query.eq('priority', args.priority);
  if (args.awaiting_human_input !== undefined) query = query.eq('awaiting_human_input', args.awaiting_human_input);
  if (args.workflow_state !== undefined) {
    query = Array.isArray(args.workflow_state)
      ? query.in('workflow_state', args.workflow_state)
      : query.eq('workflow_state', args.workflow_state);
  }
  if (args.workflow_activity !== undefined) query = query.eq('workflow_activity', args.workflow_activity);
  if (args.stale !== undefined) query = query.eq('stale', args.stale);
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

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const { data, error } = await query.range(offset, offset + limit - 1);
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
