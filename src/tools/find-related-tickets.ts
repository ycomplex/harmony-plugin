import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Handler: findRelatedTickets (B-475 P1 — surface related/duplicate/overlapping
//          tickets at the clarify gate)
// ---------------------------------------------------------------------------
//
// GENERAL related/duplicate/overlapping-work surfacing. Given a subject ticket,
// run the dedup pipeline:
//   1. Resolve the subject ticket → title+description (query text) + its intent-row
//      embedding (knowledge_decisions WHERE source_task_id=<task> AND type='intent')
//      to pass as _query_embedding (else NULL → trigram-only degrade).
//   2. Route 2 (intent semantic+lexical): search_ticket_intents RPC (B-551).
//      Route 1 (lexical content): search_tasks RPC (B-552) — catches exact/near dupes.
//   3. Self-exclude the subject ticket.
//   4. Enrich each candidate via a tasks lookup → visual_id, title, workflow_state,
//      milestone_id, archived. Drop archived candidates.
//   5. Rank by score; cap at limit (default 5).
//   6. Flag unmilestoned = (milestone_id IS NULL); SORT unmilestoned first (a flag/
//      sort, NOT a filter — milestoned candidates are still returned). NOT keyed on
//      any 'Tech Debt' epic (project-specific, non-portable).
//   7. Empty → explicit empty set (caller renders "none found"). Route-2 error/
//      unavailable → degrade gracefully (return route-1 results, mark degraded:true;
//      NEVER throw out of the clarify gate).

export interface FindRelatedTicketsArgs {
  task_id: string;
  limit?: number;
}

export interface RelatedTicketCandidate {
  id: string;                       // candidate task uuid
  task_number: number;
  visual_id: string;                // e.g. "B-475"
  title: string;
  workflow_state: string | null;
  milestone_id: string | null;
  unmilestoned: boolean;            // milestone_id IS NULL (elevated; sorted first)
  score: number;                    // best route score (RRF for route 2, similarity for route 1)
  routes: string[];                 // which route(s) surfaced it: 'intent' and/or 'lexical'
}

export interface FindRelatedTicketsResult {
  subject_task_id: string;
  candidates: RelatedTicketCandidate[];
  degraded: boolean;                // true when route 2 was unavailable (route-1-only result)
}

const DEFAULT_LIMIT = 5;

/**
 * B-475 P1: find tickets related to / duplicating / overlapping a subject ticket.
 * Surface-only — this NEVER mutates a ticket (no scope change, no closure). The
 * clarify skill renders the result as a card; fold/dedupe/subsume is an explicit
 * human action via subsume_task.
 *
 * Resilient by contract: route 2 (intent retrieval) being down degrades to route 1
 * (lexical) + `degraded: true` rather than throwing — the clarify gate must not
 * hard-fail on a dead retrieval surface (AC6).
 */
export async function findRelatedTickets(
  client: SupabaseClient,
  projectId: string,
  args: FindRelatedTicketsArgs,
): Promise<FindRelatedTicketsResult> {
  if (!args.task_id?.trim()) throw new Error('task_id is required');
  const limit = args.limit ?? DEFAULT_LIMIT;

  // 1. Resolve the subject ticket: title + description (query text), and its
  //    intent-row embedding if one exists.
  const subjectId = await resolveTaskId(client, projectId, args.task_id);
  const { data: subject, error: subjectErr } = await client
    .from('tasks')
    .select('id, title, description')
    .eq('project_id', projectId)
    .eq('id', subjectId)
    .single();
  if (subjectErr || !subject) {
    throw new Error(`Could not resolve subject ticket: ${subjectErr?.message ?? 'not found'}`);
  }
  const queryText = `${subject.title ?? ''} ${subject.description ?? ''}`.trim();

  const workspaceId = await getWorkspaceId(client, projectId);
  const subjectEmbedding = await resolveIntentEmbedding(client, workspaceId, projectId, subjectId);

  // accumulate best score + routes per candidate task id
  const byTask = new Map<string, { score: number; routes: Set<string> }>();
  let degraded = false;

  // 2a. Route 2 — intent semantic+lexical retrieval (best-effort; degrade on failure).
  try {
    const { data, error } = await (client as any).rpc('search_ticket_intents', {
      _workspace_id: workspaceId,
      _project_id: projectId,
      _query_embedding: subjectEmbedding,   // may be null → trigram-only
      _query_text: queryText || subject.title || '',
      // over-fetch so self-exclusion + archived-drop don't starve the top-N
      _match_limit: Math.max(limit * 4, 20),
    });
    if (error) {
      degraded = true;
    } else {
      for (const row of (data ?? []) as Array<Record<string, unknown>>) {
        const tid = row.source_task_id as string | null;
        if (!tid) continue;
        accumulate(byTask, tid, Number(row.score ?? 0), 'intent');
      }
    }
  } catch {
    // route 2 unavailable — degrade gracefully, never throw out of the clarify gate
    degraded = true;
  }

  // 2b. Route 1 — lexical content match over tasks (catches exact/near string dupes).
  //     Best-effort too: if it fails we keep whatever route 2 gave us.
  if (queryText) {
    try {
      const { data, error } = await (client as any).rpc('search_tasks', {
        _project_id: projectId,
        _query_text: queryText,
        _match_limit: Math.max(limit * 4, 20),
        _include_archived: false,
      });
      if (!error) {
        for (const row of (data ?? []) as Array<Record<string, unknown>>) {
          const tid = row.task_id as string | null;
          if (!tid) continue;
          accumulate(byTask, tid, Number(row.similarity ?? 0), 'lexical');
        }
      }
    } catch {
      // route 1 unavailable — keep route 2's contribution
    }
  }

  // 3. Self-exclude the subject ticket.
  byTask.delete(subjectId);

  if (byTask.size === 0) {
    return { subject_task_id: subjectId, candidates: [], degraded };
  }

  // 4. Enrich each candidate via a tasks lookup. Drop archived candidates.
  const candidateIds = [...byTask.keys()];
  const { data: rows, error: enrichErr } = await client
    .from('tasks')
    .select('id, task_number, title, workflow_state, milestone_id, archived, projects(key)')
    .eq('project_id', projectId)
    .in('id', candidateIds);
  if (enrichErr) throw new Error(`Could not enrich candidates: ${enrichErr.message}`);

  const candidates: RelatedTicketCandidate[] = [];
  for (const r of (rows ?? []) as Array<Record<string, any>>) {
    if (r.archived) continue;                    // drop archived candidates
    const agg = byTask.get(r.id);
    if (!agg) continue;
    const projectKey = r.projects?.key ?? '?';
    candidates.push({
      id: r.id,
      task_number: r.task_number,
      visual_id: `${projectKey}-${r.task_number}`,
      title: r.title,
      workflow_state: r.workflow_state ?? null,
      milestone_id: r.milestone_id ?? null,
      unmilestoned: r.milestone_id == null,      // elevation FLAG (not a filter)
      score: agg.score,
      routes: [...agg.routes].sort(),
    });
  }

  // 5 + 6. Rank by score, then SORT unmilestoned-first (flag elevates, never filters —
  //        milestoned candidates remain in the set). Cap at limit.
  candidates.sort((a, b) => {
    if (a.unmilestoned !== b.unmilestoned) return a.unmilestoned ? -1 : 1;  // unmilestoned first
    return b.score - a.score;                                               // then score DESC
  });

  return {
    subject_task_id: subjectId,
    candidates: candidates.slice(0, limit),
    degraded,
  };
}

// --- helpers ---------------------------------------------------------------

function accumulate(
  byTask: Map<string, { score: number; routes: Set<string> }>,
  taskId: string,
  score: number,
  route: string,
): void {
  const existing = byTask.get(taskId);
  if (existing) {
    existing.score = Math.max(existing.score, score);
    existing.routes.add(route);
  } else {
    byTask.set(taskId, { score, routes: new Set([route]) });
  }
}

async function getWorkspaceId(client: SupabaseClient, projectId: string): Promise<string> {
  const { data, error } = await client
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();
  if (error) throw new Error(`Could not resolve workspace: ${error.message}`);
  return data.workspace_id;
}

/** Resolve the subject's intent-row embedding (a pgvector literal '[…]' or null).
 *  Best-effort: a missing/null embedding degrades route 2 to trigram-only. The
 *  embedding column is selected back as the pgvector string literal by PostgREST. */
async function resolveIntentEmbedding(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
  taskId: string,
): Promise<string | null> {
  try {
    const { data, error } = await client
      .from('knowledge_decisions')
      .select('embedding')
      .eq('workspace_id', workspaceId)
      .eq('project_id', projectId)
      .eq('source_task_id', taskId)
      .eq('type', 'intent')
      .not('embedding', 'is', null)
      .limit(1)
      .maybeSingle();
    if (error || !data?.embedding) return null;
    // pgvector serializes to a string literal '[...]' over PostgREST; pass through.
    return typeof data.embedding === 'string'
      ? data.embedding
      : `[${(data.embedding as number[]).join(',')}]`;
  } catch {
    return null;
  }
}

// Local copy of the visual-id/number/uuid task resolver (mirrors resolve-task-id.ts)
// so this tool can resolve a UUID / number / visual id without a cross-module import
// cycle. Kept minimal — full validation lives in resolve-task-id.ts.
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

export const findRelatedTicketsTool = {
  name: 'find_related_tickets',
  description:
    'Surface tickets related to / duplicating / overlapping a subject ticket — the dedup pipeline used at the clarify gate. Runs intent retrieval (semantic+lexical over ticket intents) UNIONed with lexical content matching over tasks, self-excludes the subject, enriches each candidate (visual id, title, workflow_state, milestone), drops archived, ranks by score and SORTS unmilestoned candidates first (an elevation flag — milestoned candidates are still returned, never filtered out). Returns the top ~5 (respect `limit`, default 5). SURFACE-ONLY: this never changes scope or closes a ticket. Degrades gracefully (returns lexical-only results with degraded:true) if intent retrieval is unavailable.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      task_id: {
        type: 'string',
        description: 'The subject ticket — UUID, task number (e.g. 475), or visual ID (e.g. B-475). Its title+description is the query and its intent embedding (if any) grounds semantic retrieval.',
      },
      limit: { type: 'number', description: 'Max candidates to return. Default 5.' },
    },
    required: ['task_id'],
  },
};
