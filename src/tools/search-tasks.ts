import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Handler: searchTasks (B-552 Phase 2 — lexical/trigram ticket search)
// ---------------------------------------------------------------------------
//
// Route 1 of B-499: a thin MCP pass-through over the web-side `public.search_tasks`
// RPC (harmony-web PR #286). The RPC does lexical/trigram content search over
// `tasks.title || ' ' || coalesce(description,'')`, project-scoped, archived-excluded
// by default, ranked by `similarity` DESC. LEXICAL-ONLY — no embedding (that is the
// semantic surface's job; this surface intentionally never embeds).

export interface SearchTasksArgs {
  query: string;
  limit?: number;
  include_archived?: boolean;
}

/** One row as returned by the `public.search_tasks` RPC. The RPC return is untyped
 *  in the generated Supabase types, so the `.rpc(...)` result is cast through this
 *  shape (see B-556's additive-select pattern — but this is `.rpc`, not `.select`). */
export interface SearchTasksRow {
  task_id: string;
  task_number: number;
  project_key: string;
  title: string;
  workflow_state: string | null;
  status: string | null;
  archived: boolean;
  similarity: number;
}

export interface SearchTasksMatch {
  id: string;             // task_id
  task_number: number;
  visual_id: string;      // `${project_key}-${task_number}`, e.g. "B-552"
  title: string;
  workflow_state: string | null;
  status: string | null;
  archived: boolean;
  similarity: number;     // trigram similarity score (higher = closer); use to dedup
}

/**
 * B-552: find tickets whose content (title + description) overlaps a query, via
 * lexical/trigram matching. Project-scoped to the server's configured project (the
 * project is IMPLICIT — same scoping the other task tools use). Thin pass-through:
 * no extra logic, no embedding. Returns matches ranked by similarity DESC so an agent
 * can spot near-duplicate or related tickets (dedup-on-create).
 */
export async function searchTasks(
  client: SupabaseClient,
  projectId: string,
  args: SearchTasksArgs,
): Promise<SearchTasksMatch[]> {
  if (!args.query?.trim()) throw new Error('query is required');

  const { data, error } = await (client as any).rpc('search_tasks', {
    _project_id: projectId,
    _query_text: args.query,
    _match_limit: args.limit ?? 20,
    _include_archived: args.include_archived ?? false,
  });
  if (error) throw new Error(error.message);

  return ((data ?? []) as unknown as SearchTasksRow[]).map((r) => ({
    id: r.task_id,
    task_number: r.task_number,
    visual_id: `${r.project_key}-${r.task_number}`,
    title: r.title,
    workflow_state: r.workflow_state,
    status: r.status,
    archived: r.archived,
    similarity: r.similarity,
  }));
}

export const searchTasksTool = {
  name: 'search_tasks',
  description:
    'Search tasks by content (title + description) using lexical/trigram matching — finds near-duplicate or related tickets. Project-scoped to the current project; excludes archived tasks by default. Returns matches ranked by similarity (higher = closer); each match has its visual ID (e.g. "B-552"), title, workflow_state and similarity score so an agent can dedup. Lexical-only — for semantic/intent retrieval use search_ticket_intents instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'The content to search for — matched against task title+description via lexical/trigram similarity.',
      },
      limit: { type: 'number', description: 'Max matches to return. Default 20.' },
      include_archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
    },
    required: ['query'],
  },
};
