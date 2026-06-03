import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId } from './resolve-task-id.js';

export interface WorkflowTransitionRow {
  from_state: string | null;
  activity: string;
  to_state: string;
}

// Universal lifecycle moves are validated in P1's guard, not seeded in workflow_transitions
// (web/supabase/migrations/20260602170400_workflow_transition_guard.sql). Mirror them here so
// advance_workflow can compute the target state the guard will then validate.
const UNIVERSAL: Record<string, string> = {
  parking: 'Parked',
  cancelling: 'Cancelled',
};

/**
 * Pure: given the current state, an activity, and the seeded transition rows, return the target
 * state. researching never changes state; parking/cancelling are universal; everything else is a
 * config-led lookup (covers forward + revising-* backflow + the NULL->Captured initial edge).
 */
export function deriveToState(
  fromState: string | null,
  activity: string,
  transitions: WorkflowTransitionRow[],
): string | null {
  if (activity === 'researching') return fromState; // research never changes state — may be null (F8)
  if (activity in UNIVERSAL) return UNIVERSAL[activity];
  const row = transitions.find((t) => t.from_state === fromState && t.activity === activity);
  if (!row) {
    throw new Error(
      `No workflow transition from '${fromState ?? '(none)'}' via activity '${activity}'`,
    );
  }
  return row.to_state;
}

export const advanceWorkflowTool = {
  name: 'advance_workflow',
  description:
    'Advance an opinionated-mode task along the config-led state machine for an AGENT/SYSTEM transition that has no human brief — e.g. building (Planned->Built) once tests pass, or a revising-* backflow. Derives the target state from the workflow_transitions table; the DB guard validates the edge. For HUMAN-gated transitions use compose_brief + resolve_brief instead. parking/cancelling are accepted; researching records the activity without changing state.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, number, or visual ID (e.g. B-43)' },
      activity: {
        type: 'string',
        description:
          "Workflow activity to apply, e.g. 'building', 'releasing', 'revising-designing', 'researching', 'parking', 'cancelling', 'capturing', 'promoting'.",
      },
    },
    required: ['task_id', 'activity'],
  },
};

export async function advanceWorkflow(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; activity: string },
) {
  const id = await resolveTaskId(client, projectId, args.task_id);

  const { data: task, error: e1 } = await client
    .from('tasks')
    .select('workflow_state')
    .eq('id', id)
    .eq('project_id', projectId)
    .single();
  if (e1) throw e1;

  const { data: transitions, error: e2 } = await client
    .from('workflow_transitions')
    .select('from_state, activity, to_state');
  if (e2) throw e2;

  const fromState: string | null = (task as { workflow_state: string | null }).workflow_state;
  const toState = deriveToState(fromState, args.activity, (transitions ?? []) as WorkflowTransitionRow[]);

  // F8: researching records the activity-in-progress WITHOUT touching workflow_state. Writing toState
  // (=== fromState) would be a no-op for a stated task and a NULL→'' FK violation for an un-stated one.
  const patch =
    args.activity === 'researching'
      ? { workflow_activity: args.activity }
      : { workflow_state: toState, workflow_activity: args.activity };

  const { data: updated, error: e3 } = await client
    .from('tasks')
    .update(patch)
    .eq('id', id)
    .eq('project_id', projectId)
    .select('id, workflow_state, workflow_activity')
    .single();
  if (e3) throw e3; // P1 guard raises P0001 here on an illegal edge — surfaced to the caller.

  return {
    task_id: id,
    from_state: fromState,
    to_state: toState,
    activity: args.activity,
    task: updated,
  };
}

export const referenceKnowledgeTool = {
  name: 'reference_knowledge',
  description:
    'Record that a task depends on a knowledge decision (ticket_references_knowledge). This is what makes P2 supersession flag the ticket Stale. Idempotent. Call after record_decision so the gate-authored decision is coupled to its ticket.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, number, or visual ID' },
      decision_id: { type: 'string', description: 'knowledge_decisions.id this task references' },
    },
    required: ['task_id', 'decision_id'],
  },
};

export async function referenceKnowledge(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; decision_id: string },
) {
  const id = await resolveTaskId(client, projectId, args.task_id);
  // PK is (task_id, decision_id) — P2 migration 20260602171500_knowledge_graph_joins.sql.
  const { error } = await client
    .from('ticket_references_knowledge')
    .upsert({ task_id: id, decision_id: args.decision_id }, { onConflict: 'task_id,decision_id', ignoreDuplicates: true });
  if (error) throw error;
  return { task_id: id, decision_id: args.decision_id, linked: true };
}

export const listTicketKnowledgeTool = {
  name: 'list_ticket_knowledge',
  description:
    "List the knowledge decisions a task references (ticket_references_knowledge), each with its type + status. Ticket-scoped read for gates that must know which design sub-tracks are already Accepted for THIS ticket — query_knowledge has no ticket filter (it projects no source_task_id).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, number, or visual ID' },
    },
    required: ['task_id'],
  },
};

export async function listTicketKnowledge(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string },
) {
  const id = await resolveTaskId(client, projectId, args.task_id);
  // Embed the parent decision via the FK ticket_references_knowledge.decision_id -> knowledge_decisions.id.
  // knowledge_decisions RLS applies to the embed; ticket_references_knowledge is members-rw (P2 plan A6).
  const { data, error } = await client
    .from('ticket_references_knowledge')
    .select('decision_id, knowledge_decisions(id, type, status, title, domain)')
    .eq('task_id', id);
  if (error) throw error;
  // PostgREST types the embed as an array, but the decision_id->id FK is to-one so it returns a single
  // object (or null) at runtime — cast through unknown to the real shape.
  const rows = (data ?? []) as unknown as {
    decision_id: string;
    knowledge_decisions: Record<string, unknown> | null;
  }[];
  return rows.map((r) => ({
    decision_id: r.decision_id,
    ...(r.knowledge_decisions ?? {}),
  }));
}
