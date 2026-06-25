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
//   2. MULTI-QUERY retrieval, fused by Reciprocal Rank Fusion (RRF) over THREE ranked
//      lists (B-574 follow-up):
//        (a) Route 1 (lexical content): search_tasks(_query_text = FULL), FULL = title+description.
//        (b) Route 1 (lexical content): search_tasks(_query_text = TITLE), TITLE = title only —
//            only run when TITLE is non-empty AND TITLE !== FULL (skip when description is empty,
//            to avoid double-counting). A title-framed query rescues siblings the full-text
//            framing dilutes (verified failure: B-563's sibling B-551 ranked #14 under single-query).
//        (c) Route 2 (intent semantic+lexical): search_ticket_intents(FULL, embedding) (B-551).
//      Every RPC returns rows in ranked order, so the array index IS the rank. We FUSE
//      all lists with RRF — a task's combined score is the SUM, over every list that
//      surfaced it, of 1/(K + rank), K=10 (the COMBINE-layer constant; see RRF_K below).
//      A task in BOTH route-1 framings (full + title) gets both contributions (correctly
//      rewards lexical agreement); its `routes` set still collapses to {'lexical'}. RRF
//      fuses by RANK, not raw value, so the two incommensurable score scales (route-2 RRF
//      vs route-1 trigram similarity ~0–1) can no longer let one route dominate the other.
//   3. Self-exclude the subject ticket.
//   4. Enrich each candidate via a tasks lookup → visual_id, title, workflow_state,
//      milestone_id, archived. Drop archived AND every NON-FOLDABLE state — terminal-dead
//      (Cancelled / Parked) AND done (Verified / Released). The clarify card folds/subsumes
//      only OPEN work, so only open/foldable candidates are returned.
//      (B-581: reversed B-574's keep-terminal decision — disproven by dogfood.)
//   5. Rank PURELY by combined RRF score (DESC); cap at limit (default 5). No
//      unmilestoned-first reordering — relevance order is authoritative (B-574).
//   6. Flag unmilestoned = (milestone_id IS NULL) for the renderer to BADGE (not a
//      filter and NOT a sort key — milestoned candidates are still returned in
//      relevance order). NOT keyed on any 'Tech Debt' epic (project-specific, non-portable).
//   7. Empty → explicit empty set (caller renders "none found"). Route-2 error/
//      unavailable → degrade gracefully (return route-1 results, mark degraded:true;
//      NEVER throw out of the clarify gate). Route-1 calls are best-effort and do NOT
//      set degraded.

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
  unmilestoned: boolean;            // milestone_id IS NULL (a renderer BADGE flag, NOT a sort key)
  score: number;                    // combined multi-query RRF score: SUM of 1/(K+rank) over every list that surfaced it (K=10)
  routes: string[];                 // which route(s) surfaced it: 'intent' and/or 'lexical'
}

export interface FindRelatedTicketsResult {
  subject_task_id: string;
  candidates: RelatedTicketCandidate[];
  degraded: boolean;                // true when route 2 was unavailable (route-1-only result)
}

const DEFAULT_LIMIT = 5;

// Reciprocal Rank Fusion constant for the COMBINE layer (fusing the three ranked
// lists here in this handler). This is DISTINCT from route-2's INTERNAL SQL k=60
// (the `_k DEFAULT 60` inside the search_ticket_intents RPC, which fuses that route's
// own semantic+lexical arms). A lower K restores top-end discrimination — 1/(K+rank)
// drops off faster, so a strong both-route / both-framing match leads instead of being
// flattened toward the long tail (B-574 follow-up: K=60 buried genuine siblings).
const RRF_K = 10;

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

  // accumulate combined multi-query RRF score + routes per candidate task id
  const byTask = new Map<string, { score: number; routes: Set<string> }>();
  let degraded = false;

  // Over-fetch per route so self-exclusion + archived/terminal-drop don't starve the
  // top-N AND so diluted-but-present siblings still contribute. The floor of 50 is the
  // RECALL WINDOW for diluted siblings: a genuine relative the full-text framing buries
  // (B-563's sibling B-551 sits ~rank 27 in route-1-full) must be inside the fetched pool
  // to add ANY RRF contribution. RRF down-weights deep ranks (1/(K+rank)), so a deeper
  // pool adds negligible noise but recovers recall (B-574 follow-up: floor 20 dropped B-551).
  const matchLimit = Math.max(limit * 4, 50);
  const fullText = queryText;                                // title + description
  const titleText = (subject.title ?? '').trim();            // title only

  // Ingest one already-ranked RPC result list into the RRF accumulator. The array
  // index IS the rank (RPCs return ORDER BY score/similarity DESC), so row i → rank i+1.
  // `idKey` names the task-id column ('source_task_id' for intents, 'task_id' for tasks).
  const ingest = (rows: Array<Record<string, unknown>> | null, idKey: string, route: string) => {
    (rows ?? []).forEach((row, i) => {
      const tid = row[idKey] as string | null;
      if (!tid) return;
      accumulateRrf(byTask, tid, i + 1, route);
    });
  };

  // 2a. Route 2 — intent semantic+lexical retrieval (best-effort; degrade on failure).
  //     This is the ONLY call that sets `degraded` — its absence is the gate's risk.
  try {
    const { data, error } = await (client as any).rpc('search_ticket_intents', {
      _workspace_id: workspaceId,
      _project_id: projectId,
      _query_embedding: subjectEmbedding,   // may be null → trigram-only
      _query_text: fullText || titleText || '',
      // over-fetch so self-exclusion + archived-drop don't starve the top-N
      _match_limit: matchLimit,
    });
    if (error) {
      degraded = true;
    } else {
      ingest((data ?? []) as Array<Record<string, unknown>>, 'source_task_id', 'intent');
    }
  } catch {
    // route 2 unavailable — degrade gracefully, never throw out of the clarify gate
    degraded = true;
  }

  // 2b. Route 1 (FULL framing) — lexical content match over tasks on title+description.
  //     Best-effort: a failure keeps whatever the other lists gave us, but does NOT
  //     set `degraded` (route-1 absence is not the gate's resilience contract).
  if (fullText) {
    try {
      const { data, error } = await (client as any).rpc('search_tasks', {
        _project_id: projectId,
        _query_text: fullText,
        _match_limit: matchLimit,
        _include_archived: false,
      });
      if (!error) ingest((data ?? []) as Array<Record<string, unknown>>, 'task_id', 'lexical');
    } catch {
      // route 1 (full) unavailable — keep the other lists' contributions
    }
  }

  // 2c. Route 1 (TITLE framing) — a SECOND lexical query on the title ALONE. A
  //     title-only query rescues genuine siblings the full-text framing dilutes
  //     (B-563's sibling B-551 ranked #14 under single-query). Only run when the
  //     title is non-empty AND differs from the full text (i.e. description is
  //     non-empty), to avoid double-counting the identical query. A task surfaced by
  //     both framings accumulates BOTH contributions (rewards lexical agreement); its
  //     `routes` set still collapses to {'lexical'}.
  if (titleText && titleText !== fullText) {
    try {
      const { data, error } = await (client as any).rpc('search_tasks', {
        _project_id: projectId,
        _query_text: titleText,
        _match_limit: matchLimit,
        _include_archived: false,
      });
      if (!error) ingest((data ?? []) as Array<Record<string, unknown>>, 'task_id', 'lexical');
    } catch {
      // route 1 (title) unavailable — keep the other lists' contributions
    }
  }

  // 3. Self-exclude the subject ticket.
  byTask.delete(subjectId);

  if (byTask.size === 0) {
    return { subject_task_id: subjectId, candidates: [], degraded };
  }

  // 4. Enrich each candidate via a tasks lookup. Drop archived AND every NON-FOLDABLE
  //    candidate — terminal-dead (Cancelled / Parked) AND done (Verified / Released).
  //    The clarify card folds/subsumes only OPEN work, so done tickets are excluded too.
  //    (B-581: reversed B-574's keep-terminal decision — disproven by dogfood.)
  const candidateIds = [...byTask.keys()];
  const { data: rows, error: enrichErr } = await client
    .from('tasks')
    .select('id, task_number, title, workflow_state, milestone_id, archived, projects(key)')
    .eq('project_id', projectId)
    .in('id', candidateIds);
  if (enrichErr) throw new Error(`Could not enrich candidates: ${enrichErr.message}`);

  const candidates: RelatedTicketCandidate[] = [];
  for (const r of (rows ?? []) as Array<Record<string, any>>) {
    if (r.archived) continue;                            // drop archived candidates
    if (EXCLUDED_WORKFLOW_STATES.has(r.workflow_state)) continue;  // drop non-foldable: Cancelled / Parked (dead) + Verified / Released (done)
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
      unmilestoned: r.milestone_id == null,      // renderer BADGE flag (not a filter, not a sort key)
      score: agg.score,
      routes: [...agg.routes].sort(),
    });
  }

  // 5. Rank PURELY by combined RRF score (DESC) — relevance order is authoritative.
  //    The unmilestoned flag is carried for the renderer to badge, NOT reordered. Cap at limit.
  candidates.sort((a, b) => b.score - a.score);

  return {
    subject_task_id: subjectId,
    candidates: candidates.slice(0, limit),
    degraded,
  };
}

// --- helpers ---------------------------------------------------------------

// Workflow states EXCLUDED from the fold list — every NON-FOLDABLE state. Two kinds:
// terminal-dead (Cancelled / Parked — neither foldable nor a useful signal) AND done
// (Verified / Released — already delivered, so not foldable either). The clarify card
// folds/subsumes only OPEN work. (B-581: reversed B-574's keep-terminal decision —
// disproven by dogfood; Verified / Released used to be retained here as dedup signals.)
const EXCLUDED_WORKFLOW_STATES = new Set(['Cancelled', 'Parked', 'Verified', 'Released']);

/** Add one ranked list's Reciprocal Rank Fusion contribution for a task. A task
 *  surfaced by multiple lists (e.g. both route-1 framings + route-2) accumulates a
 *  contribution from EACH (SUM), fusing the lists by RANK — not by raw value — so
 *  incommensurable score scales can't dominate each other. The `routes` Set dedups,
 *  so two 'lexical' framings still collapse to a single 'lexical' route label. */
function accumulateRrf(
  byTask: Map<string, { score: number; routes: Set<string> }>,
  taskId: string,
  rank: number,
  route: string,
): void {
  const contribution = 1 / (RRF_K + rank);
  const existing = byTask.get(taskId);
  if (existing) {
    existing.score += contribution;
    existing.routes.add(route);
  } else {
    byTask.set(taskId, { score: contribution, routes: new Set([route]) });
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
    'Surface tickets related to / duplicating / overlapping a subject ticket — the dedup pipeline used at the clarify gate. MULTI-QUERY retrieval fused by Reciprocal Rank Fusion (RRF by rank, not a raw max, so the routes’ incommensurable score scales can’t dominate each other) over THREE ranked lists: lexical content match on title+description (route 1, full), a SECOND lexical match on the title ALONE (route 1, title — rescues siblings the full-text framing dilutes), and intent retrieval (route 2, semantic+lexical over ticket intents). Self-excludes the subject, enriches each candidate (visual id, title, workflow_state, milestone), and ranks PURELY by relevance (combined RRF score). Returns only OPEN / foldable candidates — excludes archived + Cancelled + Parked + Verified + Released (the clarify card folds/subsumes only open work; B-581 reversed B-574’s keep-terminal decision). Unmilestoned candidates are FLAGGED (`unmilestoned: true`) for the renderer to badge — they are NOT reordered (relevance order is authoritative). Returns the top ~5 (respect `limit`, default 5). SURFACE-ONLY: this never changes scope or closes a ticket. Degrades gracefully (returns lexical-only results with degraded:true) if intent retrieval is unavailable.',
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
