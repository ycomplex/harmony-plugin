import type { SupabaseClient } from '@supabase/supabase-js';

// B-931: project-scoped read over `activity_events`, the same undifferentiated stream
// `list_activity` reads per-task — this reads it PROJECT-scoped instead, so "what did the board
// deliver between two dates" is one call instead of one call per ticket. Defaults to the
// `workflow_state` field_change stream (the idx_activity_events_project(project_id, created_at)
// index exists for exactly this query) but `field_name` is itself an overridable filter.

const DEFAULT_FIELD_NAME = 'workflow_state';
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export interface ListWorkflowTransitionsArgs {
  from: string;
  to: string;
  field_name?: string;
  new_value?: string;
  old_value?: string;
  milestone_id?: string;
  epic_id?: string;
  view?: 'lean' | 'full';
  limit?: number;
  offset?: number;
}

export const listWorkflowTransitionsTool = {
  name: 'list_workflow_transitions',
  description:
    'List workflow_state (or another field_change) transitions across the WHOLE project between two ' +
    'timestamps — "what did the board deliver last week" in one call instead of one list_activity call ' +
    'per ticket. Reads activity_events (event_type=field_change), project-scoped (implicit project). ' +
    'The from/to created_at range is REQUIRED. Rows are LEAN by default (task_id, visual_id, old_value, ' +
    "new_value, created_at); view:'full' adds title. Multi-hop transitions from a single accept (e.g. " +
    'Deployed→Built then Built→Planned) are rendered in true causal order via a client-side chain-sort; ' +
    "a row whose group's chain couldn't be causally resolved is tagged order:'fallback' (id order).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      from: { type: 'string', description: 'Start of the created_at range (inclusive), ISO timestamp. Required.' },
      to: { type: 'string', description: 'End of the created_at range (exclusive), ISO timestamp. Required.' },
      field_name: {
        type: 'string',
        description: "activity_events.field_name to filter on. Default 'workflow_state' — override to read a different field_change stream.",
      },
      new_value: { type: 'string', description: 'Filter to transitions landing on this value.' },
      old_value: { type: 'string', description: 'Filter to transitions leaving this value.' },
      milestone_id: { type: 'string', description: "Filter to tasks on this milestone (embedded filter against tasks.milestone_id)." },
      epic_id: { type: 'string', description: "Filter to tasks on this epic (embedded filter against tasks.epic_id)." },
      view: {
        type: 'string',
        enum: ['lean', 'full'],
        description: "Row shape. Default 'lean' — task_id, visual_id, old_value, new_value, created_at. 'full' adds title.",
      },
      limit: { type: 'number', description: 'Max results to return. Default 100, hard cap 500.' },
      offset: { type: 'number', description: 'Number of results to skip (for pagination). Default 0.' },
    },
    required: ['from', 'to'],
  },
};

// ---------------------------------------------------------------------------
// The chain-sort (AC2) — its own exported, independently unit-testable function.
// ---------------------------------------------------------------------------

/** The minimal shape the chain-sort needs. `id` and `tx_id` are internal grouping/fallback keys —
 *  neither is ever present on a `list_workflow_transitions` RETURNED row (the handler strips both
 *  after calling this function); test fixtures pass them because the function operates on them. */
export interface WorkflowTransitionChainRow {
  id: string;
  task_id: string;
  tx_id: number;
  old_value: string | null;
  new_value: string | null;
}

export type ChainSorted<T> = T & { order?: 'fallback' };

/**
 * B-931 (AC2) — THE LOAD-BEARING ordering piece. The PostgREST read itself is ordered
 * `created_at ASC, tx_id ASC`; this function does the SECOND stage: group the already-ordered rows
 * by `(task_id, tx_id)` and, for any group of size > 1 (a multi-hop transition from a single accept —
 * e.g. Deployed→Built then Built→Planned, sharing a tx_id), resolve rendering order by walking the
 * old_value → new_value adjacency chain — the row that is nobody's `new_value` renders first, then
 * each subsequent row is the one whose `old_value` equals the current row's `new_value`. A group
 * whose chain cannot be resolved this way (ambiguous — more or less than one "first" row — or cyclic)
 * falls back to `id` order and tags EVERY row in that group with `order: 'fallback'` so a caller can
 * see the ordering wasn't causally resolved. A group of size 1 needs no chain-sort and passes through
 * untouched (no `order` tag).
 *
 * Groups are re-assembled in the order their key was FIRST seen in the input — this only reorders
 * WITHIN a (task_id, tx_id) group, it never reorders across groups (rows sharing a tx_id already sit
 * adjacent in practice: they're written in the same Postgres transaction, so they share — or nearly
 * share — the same created_at, which is the read's primary sort key).
 */
export function chainSortWorkflowTransitions<T extends WorkflowTransitionChainRow>(
  rows: T[],
): ChainSorted<T>[] {
  const groupOrder: string[] = [];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = `${row.task_id}::${row.tx_id}`;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
      groupOrder.push(key);
    }
    group.push(row);
  }

  const result: ChainSorted<T>[] = [];
  for (const key of groupOrder) {
    const group = groups.get(key)!;
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    result.push(...resolveChain(group));
  }
  return result;
}

function resolveChain<T extends WorkflowTransitionChainRow>(group: T[]): ChainSorted<T>[] {
  const newValues = group.map((r) => r.new_value);
  // "First" = nobody's new_value equals this row's old_value (no predecessor within the group).
  const firstCandidates = group.filter((r) => !newValues.includes(r.old_value));
  if (firstCandidates.length !== 1) return fallbackOrder(group);

  const ordered: T[] = [firstCandidates[0]];
  let remaining = group.filter((r) => r !== firstCandidates[0]);
  let current = firstCandidates[0];

  while (remaining.length > 0) {
    const matches = remaining.filter((r) => r.old_value === current.new_value);
    if (matches.length !== 1) return fallbackOrder(group);
    const next = matches[0];
    ordered.push(next);
    remaining = remaining.filter((r) => r !== next);
    current = next;
  }
  return ordered;
}

function fallbackOrder<T extends WorkflowTransitionChainRow>(group: T[]): ChainSorted<T>[] {
  return [...group]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ ...r, order: 'fallback' as const }));
}

// ---------------------------------------------------------------------------
// The MCP tool handler.
// ---------------------------------------------------------------------------

interface TransitionQueryRow {
  id: string;
  task_id: string;
  tx_id: number;
  old_value: string | null;
  new_value: string | null;
  created_at: string;
  tasks: { task_number: number; title: string } | null;
}

export async function listWorkflowTransitions(
  client: SupabaseClient,
  projectId: string,
  args: ListWorkflowTransitionsArgs,
) {
  if (!args.from || !args.to) {
    throw new Error('list_workflow_transitions requires both `from` and `to` (ISO created_at range).');
  }

  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const offset = args.offset ?? 0;
  const fieldName = args.field_name ?? DEFAULT_FIELD_NAME;

  // Project-scoped like every other task tool, so the project's `key` is a single constant across
  // every returned row — one small lookup rather than an embed through to `projects` per row.
  const { data: project, error: projectError } = await client
    .from('projects')
    .select('key')
    .eq('id', projectId)
    .single();
  if (projectError) throw projectError;
  const projectKey = (project as { key?: string } | null)?.key ?? '?';

  // milestone_id/epic_id live on `tasks`, not on `activity_events` itself, so they're filtered via
  // an embedded relationship (`tasks!inner(...)` + dot-path `.eq('tasks.milestone_id', …)`).
  let query = client
    .from('activity_events')
    .select(
      'id, task_id, tx_id, old_value, new_value, created_at, tasks!inner(task_number, title, milestone_id, epic_id, parent_task_id)',
    )
    .eq('project_id', projectId)
    .eq('event_type', 'field_change')
    .eq('field_name', fieldName)
    .gte('created_at', args.from)
    .lt('created_at', args.to);

  if (args.new_value !== undefined) query = query.eq('new_value', args.new_value);
  if (args.old_value !== undefined) query = query.eq('old_value', args.old_value);
  if (args.milestone_id !== undefined) query = query.eq('tasks.milestone_id', args.milestone_id);
  if (args.epic_id !== undefined) query = query.eq('tasks.epic_id', args.epic_id);

  // The two-stage ordering (AC2): the PostgREST read itself is ordered created_at ASC, tx_id ASC —
  // the client-side chain-sort below is stage two, resolving WITHIN a (task_id, tx_id) group.
  const { data, error } = await query
    .order('created_at', { ascending: true })
    .order('tx_id', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);

  const rows = ((data ?? []) as unknown as TransitionQueryRow[]).map((r) => ({
    id: r.id,
    task_id: r.task_id,
    tx_id: r.tx_id,
    old_value: r.old_value,
    new_value: r.new_value,
    created_at: r.created_at,
    task_number: r.tasks?.task_number,
    title: r.tasks?.title,
  }));

  const sorted = chainSortWorkflowTransitions(rows);
  const full = args.view === 'full';

  return sorted.map((r) => {
    const row: Record<string, unknown> = {
      task_id: r.task_id,
      visual_id: `${projectKey}-${r.task_number}`,
      old_value: r.old_value,
      new_value: r.new_value,
      created_at: r.created_at,
    };
    if (full) row.title = r.title;
    if (r.order === 'fallback') row.order = 'fallback';
    return row;
  });
}
