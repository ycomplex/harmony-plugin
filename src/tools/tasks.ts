import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';
import { resolveAssignee } from './members.js';
import { fetchPendingResolution } from './briefs.js';
import { detectRiskClasses } from './risk-class.js';

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

  // Fetch acceptance_criteria and test_case counts for returned tasks
  if (enriched.length > 0) {
    const taskIds = enriched.map((t: any) => t.id);

    const { data: acCounts } = await client
      .from('acceptance_criteria')
      .select('task_id')
      .in('task_id', taskIds);

    const { data: tcCounts } = await client
      .from('test_cases')
      .select('task_id')
      .in('task_id', taskIds);

    const acByTask: Record<string, number> = {};
    for (const row of acCounts ?? []) {
      acByTask[row.task_id] = (acByTask[row.task_id] ?? 0) + 1;
    }

    const tcByTask: Record<string, number> = {};
    for (const row of tcCounts ?? []) {
      tcByTask[row.task_id] = (tcByTask[row.task_id] ?? 0) + 1;
    }

    enriched = enriched.map((t: any) => ({
      ...t,
      acceptance_criteria_count: acByTask[t.id] ?? 0,
      test_case_count: tcByTask[t.id] ?? 0,
    }));
  }

  return enriched;
}

export const getTaskTool = {
  name: 'get_task',
  description: "Get full details of a specific task. Returns `pending_resolution` — the active brief's browser-submitted reshape marker ({command:'iterate', detail:<feedback>}) the running conductor polls for and consumes on auto-pickup (null when there's no active brief or no pending reshape). Also returns `risk_classes` — a deterministic, conservative set of high-consequence classes the work touches (auth, data-migration, irreversible-destructive, shared-core), computed from the ticket text + active brief (and any `changed_paths` you pass); the conductor uses this as a non-discretionary FLOOR: a non-empty `risk_classes` PAUSES a delegated gate for a human only in --escalate; under --unattended/--pause-at it does NOT pause mid-run — the risk is recorded and surfaced as an attention signal on the release brief (the human still sees it at the always-controlled release gate).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)' },
      changed_paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional changed file paths (e.g. `git diff --name-only` output) the build gate can pass so `risk_classes` also reflects path-based matches (e.g. **/auth/**, **/migrations/**). Additive; omit when unknown.',
      },
    },
    required: ['task_id'],
  },
};

export async function getTask(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; changed_paths?: string[] },
) {
  const resolvedId = await resolveTaskId(client, projectId, args.task_id);
  const { data, error } = await client
    .from('tasks')
    .select('*, task_labels(labels(id, name, color)), checklist_items(id, title, completed, position)')
    .eq('id', resolvedId)
    .eq('project_id', projectId)
    .single();
  if (error) throw error;
  const labels = (data.task_labels ?? []).map((tl: any) => tl.labels).filter(Boolean);
  const checklistItems = ((data as any).checklist_items ?? []).sort((a: any, b: any) => a.position - b.position);

  // The sibling enrichment reads are independent of one another, so fire them in parallel — get_task is
  // the hottest read in the system and serializing them would stack their round-trips. Each degrades on
  // its own (see below); none throws, so Promise.all never rejects on a missing-table/column drift.
  //
  // B-449 (attachments): include attachment metadata so an agent reading a task sees its files (no separate
  //   list tool). Additive + RLS-scoped: the `attachments` table's RLS already restricts visibility to the
  //   caller's workspace membership, and when the attachments module is off the select simply returns
  //   nothing. Only `finalized` rows are surfaced (in-flight `pending` rows aren't real attachments yet). A
  //   select error (e.g. the table absent on an older DB) is swallowed so get_task never regresses.
  // B-485 Phase 2 (pending_resolution): surface the active brief's `pending_resolution` so a running
  //   conductor that polls get_task can detect a browser-submitted reshape (a `{command:'iterate', detail}`
  //   marker) and consume it — see the auto-pickup loop in skills/harmony-conduct. fetchPendingResolution
  //   reads defensively (separate guarded query) and returns null on an older DB lacking the Phase-1 column
  //   rather than 400-ing the whole get_task read (B-383 class).
  const [acceptanceCriteriaRes, testCasesRes, attachments, pending_resolution] = await Promise.all([
    client.from('acceptance_criteria').select('*').eq('task_id', resolvedId).order('position'),
    client.from('test_cases').select('*').eq('task_id', resolvedId).order('position'),
    (async (): Promise<unknown[]> => {
      try {
        const { data: rows } = await client
          .from('attachments')
          .select('id, filename, content_type, byte_size, created_at')
          .eq('task_id', resolvedId)
          .eq('status', 'finalized')
          .order('created_at', { ascending: true });
        return rows ?? [];
      } catch {
        return [];
      }
    })(),
    fetchPendingResolution(client, resolvedId),
  ]);
  const acceptanceCriteria = acceptanceCriteriaRes.data;
  const testCases = testCasesRes.data;

  // B-493: compute the conductor's risk-class FLOOR signal. Deterministic + conservative
  // (over-detects on purpose) — NOT a semantic judgment. The text scanned is the ticket
  // title/description PLUS the active brief's rendered content (the gate's drafted decision),
  // so a class the decision introduces (e.g. "we'll add an RLS policy") trips the floor even
  // if the bare ticket text was clean. The active brief is read defensively: a missing/empty
  // brief or a select error (e.g. table absent on an older DB) just means no brief text — the
  // field stays additive and get_task never regresses. `changed_paths` (optional, passed by the
  // build gate) feeds path-glob matching. Labels feed the explicit-override path.
  let briefText: string;
  try {
    const { data: brief } = await client
      .from('briefs')
      .select('content')
      .eq('task_id', resolvedId)
      .eq('status', 'active')
      .maybeSingle();
    briefText = (brief as { content?: string } | null)?.content ?? '';
  } catch {
    briefText = '';
  }
  const riskText = [data.title, (data as any).description, briefText].filter(Boolean).join('\n');
  const risk_classes = detectRiskClasses({
    text: riskText,
    changedPaths: Array.isArray(args.changed_paths) ? args.changed_paths : undefined,
    labels: labels.map((l: any) => l?.name).filter((n: unknown): n is string => typeof n === 'string'),
  });

  const { task_labels, checklist_items: _checklistItems, ...rest } = data as any;
  return { ...rest, labels, checklist_items: checklistItems, acceptance_criteria: acceptanceCriteria ?? [], test_cases: testCases ?? [], attachments, pending_resolution, risk_classes };
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
      parent_task_id: { type: 'string', description: 'Parent task to nest this task under (UUID, task number, or visual ID e.g. B-43). Optional.' },
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
    parent_task_id?: string;
  }
) {
  // Resolve assignee (accepts name, email, or UUID)
  const assigneeId = args.assignee_id
    ? await resolveAssignee(client, projectId, args.assignee_id)
    : null;

  // Resolve parent_task_id if provided (accepts UUID, task number, or visual ID)
  const parentTaskId = args.parent_task_id
    ? await resolveTaskId(client, projectId, args.parent_task_id)
    : null;

  // A child inherits its parent's epic unless an epic is explicitly provided.
  // Epics are project-scoped, so only inherit when the parent lives in this
  // same project (a cross-project parent's epic would be invalid here).
  let epicId: string | null = args.epic_id ?? null;
  if (args.epic_id === undefined && parentTaskId) {
    const { data: parent, error: parentErr } = await client
      .from('tasks')
      .select('project_id, epic_id')
      .eq('id', parentTaskId)
      .single();
    if (parentErr) throw parentErr;
    if (parent?.project_id === projectId) {
      epicId = parent.epic_id ?? null;
    }
  }

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
      epic_id: epicId,
      description: args.description?.replace(/\\n/g, '\n') ?? null,
      due_date: args.due_date ?? null,
      field_values: args.field_values ?? {},
      position: nextPosition,
      created_by: userId,
      parent_task_id: parentTaskId,
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
      parent_task_id: {
        type: ['string', 'null'],
        description: 'New parent task identifier (UUID, task number, or visual ID). Pass `null` to detach.',
      } as any,
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

  // Resolve parent_task_id if provided
  if (updates.parent_task_id !== undefined) {
    updates.parent_task_id = updates.parent_task_id === null
      ? null
      : await resolveTaskId(client, projectId, updates.parent_task_id);
  }

  // Normalize escaped newlines in description
  if (typeof updates.description === 'string') {
    updates.description = updates.description.replace(/\\n/g, '\n');
  }

  // If field_values provided, merge with existing
  const payload: Record<string, any> = {};
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
    // Pre-flight: blocker gate. If the caller is changing status, ask the DB
    // whether this would land in the terminal column on a task with unresolved
    // dependencies. The DB trigger is still authoritative; this just produces
    // a clearer MCP error message.
    if (payload.status !== undefined) {
      const { data: projectRow, error: projErr } = await client
        .from('projects')
        .select('custom_statuses')
        .eq('id', projectId)
        .single();
      if (projErr) throw projErr;
      const statuses: string[] = (projectRow?.custom_statuses ?? []) as string[];
      const terminal = statuses.length > 0 ? statuses[statuses.length - 1] : 'Done';

      if (payload.status === terminal) {
        const { data: blocked, error: rpcErr } = await client.rpc('task_blocked_from_terminal', {
          _task_id: resolvedId,
        });
        if (rpcErr) throw rpcErr;
        if (blocked === true) {
          throw new Error(
            'This task has unfinished dependencies or subtasks and cannot move to the final stage. Use list_dependencies and list_subtasks to see them.',
          );
        }
      }
    }

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
  // One scoped max-position lookup per distinct status (not a full project scan),
  // seeding the in-memory counter the mapping below increments. No rows => -1, so
  // the first task in an empty status lands at position 0.
  const statuses = [...new Set(args.tasks.map(t => t.status ?? 'Backlog'))];
  const maxPositions: Record<string, number> = {};
  for (const status of statuses) {
    const { data: existing } = await client
      .from('tasks')
      .select('position')
      .eq('project_id', projectId)
      .eq('status', status)
      .order('position', { ascending: false })
      .limit(1);
    maxPositions[status] = existing?.[0]?.position ?? -1;
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
      description: task.description?.replace(/\\n/g, '\n') ?? null,
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
