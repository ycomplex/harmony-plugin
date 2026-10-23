// B-678: query-time knowledge reuse telemetry. When a gate reads knowledge for a ticket, each
// decision row the read returned is logged as a `knowledge-retrieved` knowledge_events row, so the
// exhaust miner can report how often prior decisions inform later, different tickets.
//
// Best-effort by construction: this runs AFTER the query result is built, and every failure —
// ticket resolution, workspace lookup, the insert itself — is swallowed. A retrieval record must
// never fail or slow a knowledge query. Self-reference vs cross-ticket reuse is NOT decided here:
// the row stores the reading ticket and the miner compares it with the decision's author ticket.
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConductionId, getLeg } from '../config/run-config.js';

export const RETRIEVAL_EVENT_TYPE = 'knowledge-retrieved';
/** Rows logged per query — bounds growth on broad searches. Highest-ranked decisions win. */
export const RETRIEVAL_LOG_CAP = 10;
/** The query waits at most this long for the log write before returning — the write is cut loose, not cancelled. */
export const RETRIEVAL_LOG_BUDGET_MS = 1500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RetrievalLogArgs {
  task_id?: string;
  gate?: string;
  search?: string;
}

interface Returned { id?: unknown; score?: unknown; source_kind?: unknown; kind?: unknown; type?: unknown; source_type?: unknown }

/** Decision rows only: definitions, concept placeholders, generated values and prose headings are
 *  separate result kinds with ids that are not knowledge_decisions ids. */
function decisionRows(result: unknown): Returned[] {
  const rows: Returned[] = Array.isArray(result)
    ? result
    : [...((result as { matches?: Returned[] } | null)?.matches ?? []), ...((result as { unscored_matches?: Returned[] } | null)?.unscored_matches ?? [])];
  return rows.filter(r => typeof r?.id === 'string' && UUID.test(r.id as string)
    && r.kind !== 'concept' && r.type !== 'definition' && r.source_type !== 'generated'
    && (r.source_kind === undefined || r.source_kind === 'knowledge'));
}

async function resolveTaskId(client: SupabaseClient, explicit?: string): Promise<string | null> {
  if (explicit) {
    if (UUID.test(explicit)) return explicit;
    const n = /^[A-Za-z]*-?(\d+)$/.exec(explicit.trim());
    if (!n) return null;
    const { data } = await client.from('tasks').select('id').eq('task_number', Number(n[1])).maybeSingle();
    return (data as { id?: string } | null)?.id ?? null;
  }
  const conductionId = getConductionId();
  if (!conductionId) return null;
  const { data } = await client.from('conductions').select('task_id').eq('id', conductionId).maybeSingle();
  return (data as { task_id?: string } | null)?.task_id ?? null;
}

/** Log one `knowledge-retrieved` row per returned decision (top RETRIEVAL_LOG_CAP). Never throws.
 *  Writes nothing when no ticket can be resolved or no decision row was returned. */
export async function logKnowledgeRetrieval(
  client: SupabaseClient,
  projectId: string,
  args: RetrievalLogArgs,
  result: unknown,
): Promise<void> {
  try {
    const rows = decisionRows(result).slice(0, RETRIEVAL_LOG_CAP);
    if (!rows.length) return;
    const taskId = await resolveTaskId(client, args.task_id);
    if (!taskId) return;
    const { data: project } = await client.from('projects').select('workspace_id').eq('id', projectId).single();
    const workspaceId = (project as { workspace_id?: string } | null)?.workspace_id;
    if (!workspaceId) return;
    const conductionId = getConductionId() ?? null;
    const leg = getLeg() ?? null;
    const query = args.search?.trim() ? args.search.trim().slice(0, 200) : null;
    await client.from('knowledge_events').insert(rows.map((r, i) => ({
      workspace_id: workspaceId,
      event_type: RETRIEVAL_EVENT_TYPE,
      decision_id: r.id as string,
      metadata: {
        task_id: taskId,
        gate: args.gate ?? null,
        query,
        rank: i + 1,
        score: typeof r.score === 'number' ? r.score : null,
      },
      source: 'rpc-typed',
      causation_conduction_id: conductionId,
      causation_leg: leg,
      aggregate_type: 'knowledge_decision',
      aggregate_id: r.id as string,
      contract_version: 1,
    })));
  } catch {
    // Telemetry only — see the module header.
  }
}
