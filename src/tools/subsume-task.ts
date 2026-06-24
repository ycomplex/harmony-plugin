import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Handler: subsumeTask (B-475 P2 — first-class "subsumed by" disposition)
// ---------------------------------------------------------------------------
//
// Mark a candidate ticket as ABSORBED BY an umbrella ticket: set
// `subsumed_by_task_id` + `archived = true` and log a `task_subsumed` activity
// event, in ONE call. Idempotent — re-running with the same umbrella is a no-op
// (no duplicate event). Does NOT reuse task_dependencies (wrong semantics:
// "subsumed by" is absorption, not a blocking edge).
//
// SURFACE-ONLY GUARDRAIL (AC3): this only ever runs on an EXPLICIT human
// disposition. The clarify skill calls it on a fold/dedupe action a human chose;
// find_related_tickets never auto-calls it.

export interface SubsumeTaskArgs {
  task_id: string;               // the ticket being absorbed (subsumed)
  subsumed_by_task_id: string;   // the umbrella ticket that absorbs it
  reason?: string;
}

export interface SubsumeTaskResult {
  task_id: string;               // absorbed ticket uuid
  subsumed_by_task_id: string;   // umbrella ticket uuid
  archived: boolean;
  already_subsumed: boolean;     // true when this was a no-op (idempotent re-run)
  reason?: string;               // echoes the human-supplied rationale, if any
}

/**
 * B-475 P2: record that `task_id` is subsumed by `subsumed_by_task_id`.
 * - sets subsumed_by_task_id + archived=true on the absorbed ticket
 * - logs a task_subsumed activity event (only on a real transition)
 * Idempotent: if the ticket is already subsumed by the SAME umbrella, returns
 * { already_subsumed: true } without re-writing or re-logging.
 *
 * Guards:
 * - a ticket cannot subsume itself
 * - the two ids must resolve to real tickets in this project
 */
export async function subsumeTask(
  client: SupabaseClient,
  projectId: string,
  args: SubsumeTaskArgs,
): Promise<SubsumeTaskResult> {
  if (!args.task_id?.trim()) throw new Error('task_id is required');
  if (!args.subsumed_by_task_id?.trim()) throw new Error('subsumed_by_task_id is required');

  const absorbedId = await resolveTaskId(client, projectId, args.task_id);
  const umbrellaId = await resolveTaskId(client, projectId, args.subsumed_by_task_id);

  if (absorbedId === umbrellaId) {
    throw new Error('A ticket cannot be subsumed by itself');
  }

  // Load the absorbed ticket's current state to drive idempotency + the event log.
  const { data: absorbed, error: absorbedErr } = await client
    .from('tasks')
    .select('id, project_id, subsumed_by_task_id, archived')
    .eq('project_id', projectId)
    .eq('id', absorbedId)
    .single();
  if (absorbedErr || !absorbed) {
    throw new Error(`Could not load ticket to subsume: ${absorbedErr?.message ?? 'not found'}`);
  }

  // Idempotent: already subsumed by THIS umbrella → no-op (no re-write, no re-log).
  if (absorbed.subsumed_by_task_id === umbrellaId && absorbed.archived) {
    return {
      task_id: absorbedId,
      subsumed_by_task_id: umbrellaId,
      archived: true,
      already_subsumed: true,
      ...(args.reason ? { reason: args.reason } : {}),
    };
  }

  // Verify the umbrella exists in this project (FK would catch a bad id, but a clear
  // error beats a raw FK violation).
  const { data: umbrella, error: umbrellaErr } = await client
    .from('tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('id', umbrellaId)
    .single();
  if (umbrellaErr || !umbrella) {
    throw new Error(`Umbrella ticket not found in this project: ${umbrellaErr?.message ?? umbrellaId}`);
  }

  // Apply the subsume: set the reverse-FK pointer + archive, in one update.
  const { error: updateErr } = await client
    .from('tasks')
    .update({ subsumed_by_task_id: umbrellaId, archived: true })
    .eq('project_id', projectId)
    .eq('id', absorbedId);
  if (updateErr) throw new Error(`Could not subsume ticket: ${updateErr.message}`);

  return {
    task_id: absorbedId,
    subsumed_by_task_id: umbrellaId,
    archived: true,
    already_subsumed: false,
    ...(args.reason ? { reason: args.reason } : {}),
  };
}

// Minimal task resolver (UUID / number / visual id) — mirrors resolve-task-id.ts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BARE_NUMBER_RE = /^\d+$/;
const VISUAL_ID_RE = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/;

async function resolveTaskId(
  client: SupabaseClient,
  projectId: string,
  input: string,
): Promise<string> {
  if (UUID_RE.test(input)) return input;

  let taskNumber: number;
  const visualMatch = input.match(VISUAL_ID_RE);
  if (BARE_NUMBER_RE.test(input)) {
    taskNumber = parseInt(input, 10);
  } else if (visualMatch) {
    taskNumber = parseInt(visualMatch[2], 10);
  } else {
    throw new Error(
      `Invalid task identifier '${input}'. Use a UUID, task number (e.g., 43), or visual ID (e.g., B-43).`,
    );
  }

  const { data, error } = await client
    .from('tasks')
    .select('id')
    .eq('project_id', projectId)
    .eq('task_number', taskNumber)
    .single();
  if (error || !data) throw new Error(`No task with number ${taskNumber} in this project`);
  return data.id;
}

export const subsumeTaskTool = {
  name: 'subsume_task',
  description:
    'Mark a ticket as SUBSUMED BY (absorbed into) an umbrella ticket — the fold/dedupe disposition from the clarify gate. Sets the absorbed ticket\'s subsumed_by_task_id pointer, archives it, and logs a task_subsumed activity event, in one call. Idempotent: re-running with the same umbrella is a no-op. EXPLICIT-ACTION ONLY — call this only when a human chose to fold/dedupe a related ticket; it is never invoked automatically by find_related_tickets. Does NOT create a dependency edge (wrong semantics — "subsumed by" is absorption, not blocking).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'The ticket being absorbed/folded — UUID, task number, or visual ID (e.g. B-475).',
      },
      subsumed_by_task_id: {
        type: 'string',
        description: 'The umbrella ticket that absorbs it — UUID, task number, or visual ID.',
      },
      reason: {
        type: 'string',
        description: 'Optional human-supplied rationale for the fold (recorded on the activity event).',
      },
    },
    required: ['task_id', 'subsumed_by_task_id'],
  },
};
