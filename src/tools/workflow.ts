import { claimFields } from './knowledge-claim.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveTaskId, resolveTaskIds } from './resolve-task-id.js';
import { resolveOrCreateEntity, getWorkspaceId } from './knowledge.js';

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
    'Advance an opinionated-mode task along the config-led state machine for an AGENT/SYSTEM transition that has no human brief — e.g. building (Planned->Built) once tests pass, or a revising-* backflow. Derives the target state from the workflow_transitions table; the DB guard validates the edge. For HUMAN-gated transitions use compose_brief + resolve_brief instead. parking/cancelling are accepted; researching records the activity without changing state. B-964: unparking revives a Parked ticket — target state is resume_to (if given), else the task\'s own parked_from, else \'Proposed\'; writes workflow_activity: NULL (mirrors the web\'s own "Resume" action). unparking is deliberately NOT exempt from the stale guard below.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, number, or visual ID (e.g. B-43)' },
      activity: {
        type: 'string',
        description:
          "Workflow activity to apply, e.g. 'building', 'deploying', 'revising-designing', 'researching', 'parking', 'cancelling', 'unparking', 'capturing', 'proposing'.",
      },
      resume_to: {
        type: 'string',
        description:
          "B-964: optional target workflow_state override, used ONLY by the 'unparking' activity. When omitted, unparking falls back to the task's own parked_from column, then to 'Proposed' if that is also null. Ignored for every other activity.",
      },
    },
    required: ['task_id', 'activity'],
  },
};

export async function advanceWorkflow(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; activity: string; resume_to?: string },
) {
  const id = await resolveTaskId(client, projectId, args.task_id);

  const { data: task, error: e1 } = await client
    .from('tasks')
    .select('workflow_state, stale, parked_from')
    .eq('id', id)
    .eq('project_id', projectId)
    .single();
  if (e1) throw e1;

  const taskRow = task as { workflow_state: string | null; stale: boolean | null; parked_from: string | null };

  // B-715: mirror compose_brief's stale guard here — advance_workflow is the OTHER substrate write
  // path that can move workflow_state, and it has no human brief in front of it (it's the
  // AGENT/SYSTEM-transition path), so it needs its own backstop. Forward gate progress is refused on
  // a stale ticket; the two documented clear paths stay open: a 'revising-*' backflow (the reconciliation
  // itself) and the universal off-ramps (parking/cancelling) plus researching (records activity, never
  // advances state — nothing to refuse). B-964: 'unparking' is DELIBERATELY left out of this exemption
  // — a stale ticket's revive must throw exactly like any other forward activity, so create_conduction's
  // revive path can catch it and refuse cleanly (never unpark a ticket whose completed steps reference
  // superseded knowledge).
  const isStaleExempt =
    args.activity.startsWith('revising-') || args.activity === 'researching' || args.activity in UNIVERSAL;
  if (taskRow.stale === true && !isStaleExempt) {
    throw new Error(
      `Task is stale (tasks.stale=true) — cannot apply forward activity '${args.activity}'. ` +
      `Route through harmony-stale-patch (files a 'stale-patch-review' brief) or a 'revising-*' backflow first.`,
    );
  }

  const { data: transitions, error: e2 } = await client
    .from('workflow_transitions')
    .select('from_state, activity, to_state');
  if (e2) throw e2;

  const fromState: string | null = taskRow.workflow_state;
  // B-964: 'unparking' is a dynamic per-ticket target (a caller override, else the task's own
  // parked_from, else 'Proposed') — deliberately NOT added to the fixed UNIVERSAL map (that map
  // backs deriveToState, a pure function with no row access), so it is resolved here instead of
  // going through deriveToState at all.
  const toState =
    args.activity === 'unparking'
      ? args.resume_to ?? taskRow.parked_from ?? 'Proposed'
      : deriveToState(fromState, args.activity, (transitions ?? []) as WorkflowTransitionRow[]);

  // F8: researching records the activity-in-progress WITHOUT touching workflow_state. Writing toState
  // (=== fromState) would be a no-op for a stated task and a NULL→'' FK violation for an un-stated one.
  // B-964: unparking writes workflow_activity: NULL — mirrors the web's own live "Resume" action
  // exactly (confirmed activity-agnostic against both workflow_transition_guard migrations' Parked
  // branch); it does not get a newly-seeded activity name.
  const patch =
    args.activity === 'researching'
      ? { workflow_activity: args.activity }
      : args.activity === 'unparking'
      ? { workflow_state: toState, workflow_activity: null }
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
    "List the knowledge decisions a task references (ticket_references_knowledge), each with its type + status + source_activity (the gate/skill that authored it — use this to discriminate between multiple Accepted decisions of the same type, e.g. clarify's and decompose's specification records). Use task_id for the unchanged entry array, or task_ids (1–20 identifiers) for {tickets:[{task_id,entries}]} in first-requested order. Duplicate tickets collapse; shared entries appear under each owner; any unavailable ticket fails the whole request. Ticket-scoped read for gates that must know which design sub-tracks are already Accepted for THIS ticket — query_knowledge has no ticket filter (it projects no source_task_id).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Single task identifier — UUID, number, or visual ID; returns the existing entry array' },
      task_ids: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, pattern: '\\S' }, description: 'Batch of task identifiers; returns per-ticket groups keyed by resolved UUID' },
    },
    oneOf: [{ required: ['task_id'], not: { required: ['task_ids'] } }, { required: ['task_ids'], not: { required: ['task_id'] } }],
  },
};

interface KnowledgeReferenceRow {
  task_id?: string;
  decision_id: string;
  knowledge_decisions: Record<string, unknown> | null;
}

type TicketKnowledgeEntry = Record<string, unknown> & {
  decision_id: string;
  affected_entities: AffectedEntityRow[];
};
interface TicketKnowledgeBatch { tickets: { task_id: string; entries: TicketKnowledgeEntry[] }[]; }
interface TicketKnowledgeArgs { task_id?: string; task_ids?: string[]; }
const KNOWLEDGE_PROJECTION = 'decision_id, knowledge_decisions(id, type, status, title, domain, source_activity, content)';
const KNOWLEDGE_PAGE_SIZE = 500;

export function listTicketKnowledge(client: SupabaseClient, projectId: string, args: { task_id: string }): Promise<TicketKnowledgeEntry[]>;
export function listTicketKnowledge(client: SupabaseClient, projectId: string, args: { task_ids: string[] }): Promise<TicketKnowledgeBatch>;
export function listTicketKnowledge(client: SupabaseClient, projectId: string, args: TicketKnowledgeArgs): Promise<TicketKnowledgeEntry[] | TicketKnowledgeBatch>;
export async function listTicketKnowledge(
  client: SupabaseClient,
  projectId: string,
  args: TicketKnowledgeArgs,
): Promise<TicketKnowledgeEntry[] | TicketKnowledgeBatch> {
  const single = args.task_id !== undefined;
  const batch = args.task_ids !== undefined;
  if (single === batch) throw new Error('Provide exactly one of task_id or task_ids.');
  const inputs = single ? [args.task_id] : args.task_ids;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 20 ||
      inputs.some(input => typeof input !== 'string' || !input.trim())) {
    throw new Error('Provide a non-blank task_id or task_ids containing 1–20 non-blank ticket identifiers.');
  }
  // The shared resolver passes UUIDs through. Verify existence AND current-project membership
  // for every resolved ID before reading any knowledge, including on the legacy single path.
  const resolved = single
    ? [await resolveTaskId(client, projectId, inputs[0]!)]
    : await resolveTaskIds(client, projectId, inputs as string[]);
  const ids = [...new Set(resolved.map(id => id.toLowerCase()))];
  const { data: tasks, error: taskError } = await client.from('tasks')
    .select('id').eq('project_id', projectId).in('id', ids);
  if (taskError) throw taskError;
  const found = new Set((tasks ?? []).map((task: { id: string }) => task.id.toLowerCase()));
  if (ids.some(id => !found.has(id))) throw new Error('One or more requested tickets were not found in this project.');

  const rows: KnowledgeReferenceRow[] = [];
  if (single) {
    // Preserve the legacy projection and query ordering for existing callers.
    const { data, error } = await client.from('ticket_references_knowledge')
      .select(KNOWLEDGE_PROJECTION).eq('task_id', ids[0]);
    if (error) throw error;
    rows.push(...(data ?? []) as unknown as KnowledgeReferenceRow[]);
  } else {
    // Page rather than sharing one PostgREST row limit across all requested tickets.
    for (let offset = 0; ; ) {
      const { data, error } = await client.from('ticket_references_knowledge')
        .select(`task_id, ${KNOWLEDGE_PROJECTION}`).in('task_id', ids)
        .order('task_id').order('decision_id').range(offset, offset + KNOWLEDGE_PAGE_SIZE - 1);
      if (error) throw error;
      if (!data?.length) break;
      rows.push(...data as unknown as KnowledgeReferenceRow[]);
      offset += data.length;
    }
  }
  const affected = await fetchAffectedEntities(client, rows.map(row => row.decision_id), batch);
  const projectEntry = (row: KnowledgeReferenceRow): TicketKnowledgeEntry => ({
    decision_id: row.decision_id,
    ...(row.knowledge_decisions ?? {}),
    ...claimFields(row.knowledge_decisions ?? {}),
    affected_entities: affected[row.decision_id] ?? [],
  });
  if (single) return rows.map(projectEntry);
  const groups = new Map(ids.map(id => [id, [] as TicketKnowledgeEntry[]]));
  for (const row of rows) groups.get(row.task_id!)?.push(projectEntry(row));
  return { tickets: ids.map(task_id => ({ task_id, entries: groups.get(task_id)! })) };
}

// ---------------------------------------------------------------------------
// Helper: fetchAffectedEntities (B-977)
// ---------------------------------------------------------------------------

export interface AffectedEntityRow { entity_id: string; name: string; kind: string; }
type EntityEdge = { decision_id: string; entity_id: string; knowledge_entities: { name?: string; kind?: string } | null };

async function fetchAffectedEntities(
  client: SupabaseClient,
  decisionIds: string[],
  paged = false,
): Promise<Record<string, AffectedEntityRow[]>> {
  if (decisionIds.length === 0) return {};
  const rows: EntityEdge[] = [];
  if (!paged) {
    // Keep existing single-ticket behavior and entity order.
    const { data, error } = await client.from('decision_affects_entity')
      .select('decision_id, entity_id, knowledge_entities(name, kind)').in('decision_id', decisionIds);
    if (error) throw error;
    rows.push(...(data ?? []) as EntityEdge[]);
  } else {
    const unique = [...new Set(decisionIds)];
    // Bound URL size as well as paging the response; shared decisions are fetched only once.
    for (let start = 0; start < unique.length; start += 100) {
      for (let offset = 0; ; ) {
        const { data, error } = await client.from('decision_affects_entity')
          .select('decision_id, entity_id, knowledge_entities(name, kind)')
          .in('decision_id', unique.slice(start, start + 100))
          .order('decision_id').order('entity_id').range(offset, offset + KNOWLEDGE_PAGE_SIZE - 1);
        if (error) throw error;
        if (!data?.length) break;
        rows.push(...data as EntityEdge[]);
        offset += data.length;
      }
    }
  }
  const map: Record<string, AffectedEntityRow[]> = {};
  for (const row of rows) {
    const entity = row.knowledge_entities;
    if (!entity?.name) continue;
    const list = map[row.decision_id] ?? (map[row.decision_id] = []);
    list.push({ entity_id: row.entity_id, name: entity.name, kind: entity.kind ?? '' });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Handler: linkTicketEntities (B-977)
// ---------------------------------------------------------------------------
//
// The AC1 write half: a just-promoted design/visual-handoff decision names the entity/entities it
// implements/affects. For each name, resolve-or-create the entity (default kind 'feature' — the
// pinned birth point for AC1/AC4's feature entities) then upsert BOTH edges in the same write:
// ticket_implements_entity (the creating ticket) and decision_affects_entity (the affecting
// decision) — mirroring referenceKnowledge's upsert-with-onConflict pattern. A genuine RLS/
// permission denial throws (both tables' policies are confirmed live — no degrade path for a
// problem that does not exist).

export const linkTicketEntitiesTool = {
  name: 'link_ticket_entities',
  description:
    "Link a task and a just-promoted design/visual-handoff decision to one or more knowledge entities " +
    "(B-977) — writes BOTH ticket_implements_entity (task -> entity) and decision_affects_entity " +
    "(decision -> entity) in the same call. Each name is resolved-or-created via the same path as " +
    "record_decision's affected_entity_names, default kind 'feature'. Call this right after the " +
    "design/visual-handoff gate's resolve_brief promotes the decision, passing the entity name(s) " +
    "confirmed at clarify (field_values.implements_entities) — or any other entity names worth binding " +
    "to this ticket/decision pair. Idempotent (upsert, ignore-duplicates).",
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: { type: 'string', description: 'Task identifier — UUID, number, or visual ID' },
      decision_id: { type: 'string', description: 'knowledge_decisions.id — the just-promoted design/visual-handoff decision' },
      entity_names: { type: 'array', items: { type: 'string' }, description: 'One or more entity names to resolve-or-create and link' },
      entity_kind: { type: 'string', description: "Kind used ONLY for entities that don't already exist under any kind. Default 'feature'." },
    },
    required: ['task_id', 'decision_id', 'entity_names'],
  },
};

export async function linkTicketEntities(
  client: SupabaseClient,
  projectId: string,
  args: { task_id: string; decision_id: string; entity_names: string[]; entity_kind?: string },
) {
  if (!args.decision_id) throw new Error('decision_id is required');
  const names = (args.entity_names ?? []).map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) throw new Error('entity_names must contain at least one non-empty name');

  const id = await resolveTaskId(client, projectId, args.task_id);
  const workspaceId = await getWorkspaceId(client, projectId);
  const kind = args.entity_kind ?? 'feature';

  const entityIds: string[] = [];
  for (const name of names) {
    entityIds.push(await resolveOrCreateEntity(client, workspaceId, projectId, name, kind));
  }

  for (const entityId of entityIds) {
    const { error: implementsErr } = await client
      .from('ticket_implements_entity')
      .upsert({ task_id: id, entity_id: entityId }, { onConflict: 'task_id,entity_id', ignoreDuplicates: true });
    if (implementsErr) throw implementsErr;

    const { error: affectsErr } = await client
      .from('decision_affects_entity')
      .upsert({ decision_id: args.decision_id, entity_id: entityId }, { onConflict: 'decision_id,entity_id', ignoreDuplicates: true });
    if (affectsErr) throw affectsErr;
  }

  return { task_id: id, decision_id: args.decision_id, entity_ids: entityIds, linked: true };
}
