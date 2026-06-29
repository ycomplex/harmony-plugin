import type { SupabaseClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface KnowledgeEntrySummary {
  id: string;
  title: string;
  type: string;
  status: string;
  domain: string[];
  tags: string[];
  project_id: string | null;
  updated_at: string;
}

export interface KnowledgeEntryFull {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  content: string;
  type: string;
  status: string;
  superseded_by: string | null;
  tags: string[];
  source_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  // Optional decision-axis columns the base table carries (B-468): editable through
  // updateKnowledgeEntry and echoed back when present. Not selected by every read
  // path (getKnowledgeEntry / create echo omit them), hence optional.
  domain?: string[];
  madr?: Record<string, unknown> | null;
  realization?: string | null;
  review_by?: string | null;
}

export interface KnowledgeDecisionFull {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  content: string;
  type: string;
  status: string;              // Asserted | Accepted | Superseded | Archived
  realization?: string | null;  // null ≡ live | agreed | live | deprecating | retired (orthogonal to status)
  domain: string[];
  confidence: number;
  review_by: string | null;
  drift_risk: boolean;
  superseded_by: string | null;
  affected_entity_ids: string[];
  madr: Record<string, unknown> | null;
  source_type: string;
  source_id: string | null;
  source_activity: string | null;
  tags: string[];
  source_task_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

const DECISION_COLS =
  'id, workspace_id, project_id, title, content, type, status, realization, domain, confidence, review_by, drift_risk, ' +
  'superseded_by, affected_entity_ids, madr, source_type, source_id, source_activity, tags, source_task_id, ' +
  'created_by, created_at, updated_at';

export interface KnowledgeFactFull {
  id: string; workspace_id: string; project_id: string | null;
  subject_entity_id: string; predicate: string; object: unknown;
  confidence: number; status: string; domain: string[];
  source_type: string; source_id: string | null;
  valid_from: string; valid_to: string | null; recorded_at: string; created_by: string;
}
const FACT_COLS =
  'id, workspace_id, project_id, subject_entity_id, predicate, object, confidence, status, domain, ' +
  'source_type, source_id, valid_from, valid_to, recorded_at, created_by';

export interface KnowledgeEntityFull {
  id: string; workspace_id: string; project_id: string | null;
  kind: string; name: string; description: string | null; metadata: unknown; created_at: string;
}
const ENTITY_COLS = 'id, workspace_id, project_id, kind, name, description, metadata, created_at';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const queryKnowledgeTool = {
  name: 'query_knowledge',
  description:
    'Search the knowledge base for architecture decisions, business decisions, conventions, and specifications scoped to this project. Check this before making significant implementation choices. Defaults to "Accepted" entries only. When `search` is given, retrieval is semantic (RRF) and composes only with `domain` (+ `limit`); the other structured filters (`type`, `status`, `tags`, `as_of`, `include_superseded`, `offset`) apply to the non-search structured path only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        description: 'Filter by entry type (e.g. "architecture", "business", "convention", "specification"). (structured-filter path; not combinable with `search`)',
      },
      status: {
        type: 'string',
        description: 'Filter by status. Default: "Accepted". (structured-filter path; not combinable with `search`)',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter to entries tagged with ANY of these domains: engineering, operations, data, product, customer, process. Query the relevant domain before deciding.',
      },
      as_of: {
        type: 'string',
        description: 'ISO timestamp — return entries valid at or before this instant (temporal query). (structured-filter path; not combinable with `search`)',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter entries that contain ALL of these tags. (structured-filter path; not combinable with `search`)',
      },
      search: {
        type: 'string',
        description: 'Free-text search query — hybrid semantic + trigram retrieval, ranked by relevance (RRF). Composes only with `domain` and `limit`.',
      },
      include_superseded: {
        type: 'boolean',
        description: 'When true and no explicit status given, return all statuses including superseded. Default false. (structured-filter path; not combinable with `search`)',
      },
      limit: { type: 'number', description: 'Max results to return. Default 50.' },
      offset: { type: 'number', description: 'Number of results to skip (for pagination). Default 0. (structured-filter path; not combinable with `search`)' },
    },
  },
};

export const getKnowledgeEntryTool = {
  name: 'get_knowledge_entry',
  description: 'Get the full content of a knowledge entry by ID or title. Scoped to this project.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entry_id: { type: 'string', description: 'Knowledge entry UUID' },
      title: { type: 'string', description: 'Entry title (exact match)' },
    },
  },
};

export const createKnowledgeEntryTool = {
  name: 'create_knowledge_entry',
  description:
    'Create a new knowledge entry in this project. Entries are created as "draft" by default — humans review and accept them. Use for architecture decisions, business decisions, conventions, and specifications (spec documents describing work to be built).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Entry title (must be unique within the project)' },
      content: { type: 'string', description: 'Markdown content of the entry' },
      type: {
        type: 'string',
        description: 'Entry type: "architecture", "business", "convention", or "specification"',
      },
      status: {
        type: 'string',
        description: 'Status override. Default: "draft".',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tags',
      },
      source_task_id: {
        type: 'string',
        description: 'Task ID that triggered this knowledge entry',
      },
    },
    required: ['title', 'content', 'type'],
  },
};

export const updateKnowledgeEntryTool = {
  name: 'update_knowledge_entry',
  description: 'Update an existing knowledge entry in this project by ID or title. Can update title, content, type, status, tags, domain, madr, realization, or review_by. Works for all entry types, including the next-gen design types.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entry_id: { type: 'string', description: 'Knowledge entry UUID' },
      title: { type: 'string', description: 'Current entry title (used to find the entry if entry_id not provided)' },
      new_title: { type: 'string', description: 'New title for the entry' },
      content: { type: 'string', description: 'New markdown content' },
      type: { type: 'string', description: 'New entry type' },
      status: { type: 'string', description: 'New status: Asserted, Accepted, Superseded, or Archived (legacy lowercase draft/accepted/superseded also accepted)' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace tags with this list',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace domains with this list: engineering, operations, data, product, customer, process',
      },
      madr: {
        type: 'object',
        description: 'Replace the structured MADR body (full-object replace, not a key-merge): { context, decision_drivers, considered_options, decision_outcome, consequences }',
      },
      realization: {
        type: 'string',
        enum: ['agreed', 'live', 'deprecating', 'retired'],
        description: 'Implementation/realization state (orthogonal to status); NULL ≡ live; "agreed" = decided-not-yet-built',
      },
      review_by: { type: 'string', description: 'ISO timestamp; freshness/decay date (knowledge-model-v1 §3)' },
    },
  },
};

export const supersedeKnowledgeEntryTool = {
  name: 'supersede_knowledge_entry',
  description:
    'Supersede an existing knowledge entry in this project with a new replacement. Marks the old entry as "superseded" and creates the replacement as "accepted", linking them via superseded_by.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entry_id: { type: 'string', description: 'UUID of the entry to supersede' },
      title: { type: 'string', description: 'Title of the entry to supersede (used if entry_id not provided)' },
      new_title: { type: 'string', description: 'Title for the replacement entry' },
      new_content: { type: 'string', description: 'Content for the replacement entry' },
      type: { type: 'string', description: 'Type for the replacement (defaults to type of superseded entry)' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for the replacement (defaults to tags of superseded entry)',
      },
    },
    required: ['new_title', 'new_content'],
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function getWorkspaceId(client: SupabaseClient, projectId: string): Promise<string> {
  const { data, error } = await client
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();
  if (error) throw new Error(`Could not resolve workspace: ${error.message}`);
  return data.workspace_id;
}

// Best-effort: returns a pgvector literal '[…]' or null. A failed embed never blocks a write.
async function embedText(client: SupabaseClient, text: string): Promise<string | null> {
  try {
    const { data, error } = await (client as any).functions.invoke('embed-knowledge', { body: { text } });
    if (error || !data?.embedding) return null;
    return `[${(data.embedding as number[]).join(',')}]`;
  } catch {
    return null;
  }
}

/**
 * Re-embed a knowledge decision by id on the BASE table.
 *
 * Why this exists: createKnowledgeEntry / updateKnowledgeEntry write through the
 * `workspace_knowledge` compat VIEW, whose INSTEAD-OF triggers do NOT touch the
 * `embedding` column (B-375 / B-401). A view INSERT or content-changing UPDATE
 * therefore leaves the vector null/stale → the row is invisible to
 * knowledge_search_rrf (which filters `embedding IS NOT NULL`). The embed-knowledge
 * edge fn has no DB access, so we compute the vector client-side and persist it
 * straight to knowledge_decisions, scoped by workspace+project+id.
 *
 * Best-effort, mirroring recordDecision: if embedText returns null (key unset / fn
 * down) we leave the embedding untouched rather than failing the user's write.
 */
async function embedDecisionById(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
  id: string,
  title: string,
  content: string | null,
): Promise<void> {
  const embedding = await embedText(client, `${title}\n${content ?? ''}`);
  if (!embedding) return;
  await client
    .from('knowledge_decisions')
    .update({ embedding })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', id);
}

const LEGACY_STATUS_MAP: Record<string, string> = {
  draft: 'draft', accepted: 'accepted', superseded: 'superseded',
  Asserted: 'draft', Accepted: 'accepted', Superseded: 'superseded',
};

/**
 * Normalize a caller-supplied status into the LEGACY lowercase vocab the
 * `workspace_knowledge` compat view's INSTEAD-OF triggers understand (B-415).
 *
 * Why: those triggers map status with a CASE that only recognizes
 * 'draft' | 'accepted' | 'superseded' (migration 20260602171200…sql). Any v1-
 * capitalized value ('Accepted', …) falls through ELSE → the UPDATE silently keeps
 * the old status (no-op) and the INSERT defaults to 'Asserted' — while the trigger's
 * RETURN NEW echoes the caller's input back as a false success. The rest of the
 * knowledge layer speaks v1-capitalized vocab, so callers naturally pass 'Accepted'.
 *
 * We translate v1 → legacy here (and pass legacy through). Anything unrecognized —
 * including v1 'Archived', which the legacy view cannot express — is REJECTED loudly
 * rather than silently dropped.
 */
function toLegacyStatus(status: string): string {
  const legacy = LEGACY_STATUS_MAP[status];
  if (legacy === undefined) {
    throw new Error(
      `Unsupported status "${status}". Use Asserted/draft, Accepted/accepted, or Superseded/superseded — ` +
      `Archived cannot be set through this tool, which writes the legacy compat view (no Archived state).`,
    );
  }
  return legacy;
}

const BASE_STATUS_MAP: Record<string, string> = {
  draft: 'Asserted', accepted: 'Accepted', superseded: 'Superseded',
  Asserted: 'Asserted', Accepted: 'Accepted', Superseded: 'Superseded', Archived: 'Archived',
};

/**
 * Normalize a caller-supplied status into the v1-capitalized vocab the
 * `knowledge_decisions` BASE table's CHECK constraint accepts (B-418).
 *
 * Inverse direction of toLegacyStatus: paths that write the base table directly
 * (updateKnowledgeEntry, supersedeKnowledgeEntry's mark-superseded step) must speak
 * 'Asserted'|'Accepted'|'Superseded'|'Archived', while legacy callers still pass the
 * lowercase view vocab. 'Archived' is legal here — only the compat view couldn't
 * express it. Anything unrecognized is REJECTED loudly rather than silently dropped.
 */
function toBaseStatus(status: string): string {
  const base = BASE_STATUS_MAP[status];
  if (base === undefined) {
    throw new Error(
      `Unsupported status "${status}". Use Asserted/draft, Accepted/accepted, Superseded/superseded, or Archived.`,
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Handler: queryKnowledge
// ---------------------------------------------------------------------------

export interface QueryKnowledgeArgs {
  type?: string;
  status?: string;
  domain?: string[];          // NEW: filter to entries tagged with ANY of these domains
  as_of?: string;             // NEW: ISO date — entries valid at/before this instant
  tags?: string[];
  search?: string;
  include_superseded?: boolean;
  limit?: number;
  offset?: number;
}

export async function queryKnowledge(
  client: SupabaseClient,
  projectId: string,
  args: QueryKnowledgeArgs,
): Promise<KnowledgeEntrySummary[]> {
  const workspaceId = await getWorkspaceId(client, projectId);

  // Semantic path: a free-text query => embed it + fuse vector ⊕ trigram via RRF (Phase C).
  if (args.search) {
    // Semantic retrieval (RRF) returns Accepted decisions ranked by relevance, optionally filtered by
    // `domain` (+ `limit`). It does NOT yet compose with the other structured filters — reject rather than
    // silently drop them (no silent wrong answer; e.g. search+include_superseded would otherwise return
    // Accepted-only with no error). Composable semantic+filter search is tracked as a follow-up.
    const incompatible: string[] = [];
    if (args.status) incompatible.push('status');
    if (args.include_superseded) incompatible.push('include_superseded');
    if (args.type) incompatible.push('type');
    if (args.tags && args.tags.length > 0) incompatible.push('tags');
    if (args.as_of) incompatible.push('as_of');
    if (args.offset) incompatible.push('offset');
    if (incompatible.length > 0) {
      throw new Error(
        `query_knowledge: "search" (semantic retrieval) cannot be combined with: ${incompatible.join(', ')}. ` +
        `Semantic search returns Accepted decisions ranked by relevance, optionally filtered by "domain". ` +
        `Omit "search" to use the structured filters.`,
      );
    }
    const queryEmbedding = await embedText(client, args.search);   // may be null -> fn degrades to trigram-only
    const { data, error } = await (client as any).rpc('knowledge_search_rrf', {
      _workspace_id: workspaceId,
      _project_id: projectId,
      _query_embedding: queryEmbedding,
      _query_text: args.search,
      _domain: args.domain && args.domain.length > 0 ? args.domain : null,
      _match_limit: args.limit ?? 50,
    });
    if (error) throw new Error(error.message);
    return (data ?? []).map((d: any) => ({
      id: d.id, title: d.title, type: d.type, status: d.status,
      domain: d.domain, tags: d.tags, project_id: d.project_id, updated_at: d.updated_at,
    })) as KnowledgeEntrySummary[];
  }

  // Filter-only path: structured filters over knowledge_decisions (no relevance ranking needed).
  let query = client
    .from('knowledge_decisions')
    .select('id, title, type, status, domain, tags, project_id, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId);

  if (args.status) {
    query = query.eq('status', args.status);
  } else if (!args.include_superseded) {
    query = query.eq('status', 'Accepted');
  }
  if (args.type) query = query.eq('type', args.type);
  if (args.domain && args.domain.length > 0) query = query.overlaps('domain', args.domain);
  if (args.as_of) query = query.lte('valid_from', args.as_of);
  if (args.tags && args.tags.length > 0) query = query.contains('tags', args.tags);

  query = query.order('type', { ascending: true });
  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeEntrySummary[];
}

// ---------------------------------------------------------------------------
// Handler: searchTicketIntents (B-551 Phase 2 — the intent-only retrieval surface)
// ---------------------------------------------------------------------------

export interface TicketIntentMatch {
  id: string;              // the knowledge_decisions intent-row id
  source_task_id: string;  // the originating TICKET (what the caller actually wants)
  content: string;         // title + description (raw ticket intent)
  score: number;           // RRF fusion score (higher = more relevant)
}

export interface SearchTicketIntentsArgs {
  query: string;
  limit?: number;
}

/**
 * B-551 Phase 2 (READ half): find tickets whose raw intent overlaps a query, via the
 * intent-only retrieval surface (search_ticket_intents). This is the MIRROR IMAGE of
 * query_knowledge's RRF search — same hybrid pgvector ⊕ pg_trgm RRF mechanism — but it
 * returns ONLY type='intent' rows (status-agnostic), surfacing the originating ticket.
 *
 * Unlike query_knowledge (Accepted-only design-grounding, physically intent-free), this
 * surface never returns a design/spec/convention decision and never bleeds into the design
 * corpus. Its purpose is dedup-on-create / "is someone already asking for this?" (B-475).
 *
 * NULL-embedding tolerant (mirrors queryKnowledge): we best-effort embed the query; if the
 * embed fn is down we pass null and the RPC degrades to trigram-only. A freshly-created,
 * not-yet-embedded intent is still found by lexical overlap on its content.
 */
export async function searchTicketIntents(
  client: SupabaseClient,
  projectId: string,
  args: SearchTicketIntentsArgs,
): Promise<TicketIntentMatch[]> {
  if (!args.query?.trim()) throw new Error('query is required');

  const workspaceId = await getWorkspaceId(client, projectId);

  const queryEmbedding = await embedText(client, args.query);   // may be null -> RPC degrades to trigram-only
  const { data, error } = await (client as any).rpc('search_ticket_intents', {
    _workspace_id: workspaceId,
    _project_id: projectId,
    _query_embedding: queryEmbedding,
    _query_text: args.query,
    _match_limit: args.limit ?? 50,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<Record<string, unknown>>).map((d) => ({
    id: d.id,
    source_task_id: d.source_task_id,
    content: d.content,
    score: d.score,
  })) as unknown as TicketIntentMatch[];
}

export const searchTicketIntentsTool = {
  name: 'search_ticket_intents',
  description:
    'Find existing TICKETS whose raw intent (title + description) overlaps a query — the intent-only retrieval surface (hybrid semantic + trigram RRF, ranked by relevance). Use this to check whether a ticket already captures what someone is about to ask for (dedup / "is this already requested?"). This is SEPARATE from query_knowledge: it returns ONLY ticket-intent rows (status-agnostic) and never a design/spec/convention decision, so the two corpora never bleed. Returns each match as { source_task_id, content, score }; resolve source_task_id with get_task to inspect the ticket.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Free-text query describing the intent to look for — matched against ticket title+description via hybrid semantic + trigram retrieval (RRF).',
      },
      limit: { type: 'number', description: 'Max matches to return. Default 50.' },
    },
    required: ['query'],
  },
};

// ---------------------------------------------------------------------------
// Handler: getKnowledgeEntry
// ---------------------------------------------------------------------------

export async function getKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  args: { entry_id?: string; title?: string },
): Promise<KnowledgeEntryFull> {
  if (!args.entry_id && !args.title) {
    throw new Error('Either entry_id or title must be provided');
  }

  const workspaceId = await getWorkspaceId(client, projectId);

  // Read the knowledge_decisions BASE table, not the workspace_knowledge compat view:
  // the view filters to the legacy four types, so next-gen-typed entries
  // (technical-design / product-design / ux-ui-design / deferral) are invisible there
  // → .single() "Cannot coerce" (B-418). Status comes back in v1 vocab ('Accepted').
  let query = client
    .from('knowledge_decisions')
    .select(
      'id, workspace_id, project_id, title, content, type, status, realization, superseded_by, tags, source_task_id, created_by, created_at, updated_at',
    )
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId);

  if (args.entry_id) {
    query = query.eq('id', args.entry_id);
  } else {
    query = query.eq('title', args.title!);
  }

  const { data, error } = await query.single();
  if (error) throw error;
  return data as KnowledgeEntryFull;
}

// ---------------------------------------------------------------------------
// Handler: createKnowledgeEntry
// ---------------------------------------------------------------------------

export interface CreateKnowledgeEntryArgs {
  title: string;
  content: string;
  type: string;
  status?: string;
  tags?: string[];
  source_task_id?: string;
}

export async function createKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: CreateKnowledgeEntryArgs,
): Promise<KnowledgeEntryFull> {
  if (!args.title?.trim()) {
    throw new Error('title is required');
  }

  const workspaceId = await getWorkspaceId(client, projectId);

  const record: Record<string, unknown> = {
    workspace_id: workspaceId,
    project_id: projectId,
    title: args.title.trim(),
    content: args.content ?? '',
    type: args.type,
    status: args.status !== undefined ? toLegacyStatus(args.status) : 'draft',
    created_by: userId,
  };

  if (args.tags !== undefined) record.tags = args.tags;
  if (args.source_task_id !== undefined) record.source_task_id = args.source_task_id;

  const { data, error } = await client
    .from('workspace_knowledge')
    .insert(record)
    .select(
      'id, workspace_id, project_id, title, content, type, status, superseded_by, tags, source_task_id, created_by, created_at, updated_at',
    )
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        `A knowledge entry titled "${args.title.trim()}" already exists in this project`,
      );
    }
    throw error;
  }
  const created = data as KnowledgeEntryFull;
  await embedDecisionById(client, workspaceId, projectId, created.id, created.title, created.content);
  // The view's INSTEAD-OF INSERT trigger RETURN NEWs the input, so `created` echoes what we
  // sent (status vocab, timestamps). Re-read (getKnowledgeEntry: workspace lookup + base-table
  // select) for the authoritative persisted row (B-415) — status in v1 vocab.
  return getKnowledgeEntry(client, projectId, { entry_id: created.id });
}

// ---------------------------------------------------------------------------
// Handler: updateKnowledgeEntry
// ---------------------------------------------------------------------------

export interface UpdateKnowledgeEntryArgs {
  entry_id?: string;
  title?: string;
  new_title?: string;
  content?: string;
  type?: string;
  status?: string;
  tags?: string[];
  domain?: string[];
  madr?: Record<string, unknown>;
  realization?: string;
  review_by?: string;
}

export async function updateKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  args: UpdateKnowledgeEntryArgs,
): Promise<KnowledgeEntryFull> {
  if (!args.entry_id && !args.title) {
    throw new Error('Either entry_id or title must be provided to identify the entry');
  }

  const hasUpdates =
    args.new_title !== undefined ||
    args.content !== undefined ||
    args.type !== undefined ||
    args.status !== undefined ||
    args.tags !== undefined ||
    args.domain !== undefined ||
    args.madr !== undefined ||
    args.realization !== undefined ||
    args.review_by !== undefined;

  if (!hasUpdates) {
    throw new Error('At least one field to update must be provided');
  }

  const workspaceId = await getWorkspaceId(client, projectId);

  const updates: Record<string, unknown> = {};
  if (args.new_title !== undefined) updates.title = args.new_title.trim();
  if (args.content !== undefined) updates.content = args.content;
  if (args.type !== undefined) updates.type = args.type;
  if (args.status !== undefined) updates.status = toBaseStatus(args.status);
  if (args.tags !== undefined) updates.tags = args.tags;
  // Decision-axis columns recordDecision already writes but this path omitted (B-468).
  // Pass-through only (mirrors recordDecision — no strict validation; the DB CHECK/FK
  // constraints are the backstop). madr is a FULL-OBJECT replace, not a key-merge.
  if (args.domain !== undefined) updates.domain = args.domain;
  if (args.madr !== undefined) updates.madr = args.madr;
  if (args.realization !== undefined) updates.realization = args.realization;
  if (args.review_by !== undefined) updates.review_by = args.review_by;

  // Update the knowledge_decisions BASE table, not the workspace_knowledge compat view:
  // the view's INSTEAD-OF UPDATE never fires for rows outside its WHERE (the legacy four
  // types), so next-gen-typed entries matched zero rows → "Cannot coerce" — making them
  // un-editable in place (B-418). The base-table UPDATE … RETURNING is authoritative
  // (no trigger echo), so the B-415 re-read is unnecessary on this path.
  let query = client
    .from('knowledge_decisions')
    .update(updates)
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId);

  if (args.entry_id) {
    query = query.eq('id', args.entry_id);
  } else {
    query = query.eq('title', args.title!);
  }

  const { data, error } = await query
    .select(
      'id, workspace_id, project_id, title, content, type, status, superseded_by, tags, source_task_id, created_by, created_at, updated_at, domain, madr, realization, review_by',
    )
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(
        `A knowledge entry titled "${updates.title as string}" already exists in this project`,
      );
    }
    throw error;
  }

  // Re-embed only when the embedded text (title\ncontent) actually changed. Nothing in
  // the DB maintains the embedding column on writes (architecture rule: every knowledge
  // writer self-embeds), so without this an edited row keeps a stale (or null) vector
  // and is invisible to knowledge_search_rrf. embedDecisionById writes the fresh vector
  // by id, using the merged title/content returned by the update above.
  const updated = data as KnowledgeEntryFull;
  if (args.new_title !== undefined || args.content !== undefined) {
    await embedDecisionById(client, workspaceId, projectId, updated.id, updated.title, updated.content);
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Helper: resolveOrCreateEntity
// ---------------------------------------------------------------------------

export async function resolveOrCreateEntity(
  client: SupabaseClient,
  workspaceId: string,
  projectId: string,
  name: string,
  kind = 'concept',
): Promise<string> {
  const { data: existing, error: lookupErr } = await client
    .from('knowledge_entities')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('name', name)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  if (existing) return (existing as { id: string }).id;

  const { data, error } = await client
    .from('knowledge_entities')
    .insert({ workspace_id: workspaceId, project_id: projectId, kind, name })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Handler: recordDecision
// ---------------------------------------------------------------------------

export interface RecordDecisionArgs {
  type: string;
  title: string;
  content?: string;
  madr?: Record<string, unknown>;
  domain?: string[];
  affected_entity_names?: string[];
  status?: string;
  source_type?: string;
  source_id?: string;
  source_activity?: string;
  tags?: string[];
  source_task_id?: string;
  review_by?: string;   // ISO timestamp; freshness/decay date (knowledge-model-v1 §3)
  realization?: string; // implementation state (orthogonal to status); omit ⇒ NULL ≡ live. agreed | live | deprecating | retired
}

export async function recordDecision(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: RecordDecisionArgs,
): Promise<KnowledgeDecisionFull> {
  if (!args.title?.trim()) throw new Error('title is required');
  if (!args.type) throw new Error('type is required');

  const workspaceId = await getWorkspaceId(client, projectId);

  const affectedIds: string[] = [];
  for (const name of args.affected_entity_names ?? []) {
    affectedIds.push(await resolveOrCreateEntity(client, workspaceId, projectId, name));
  }

  const embedding = await embedText(client, `${args.title}\n${args.content ?? ''}`);

  const record: Record<string, unknown> = {
    workspace_id: workspaceId,
    project_id: projectId,
    title: args.title.trim(),
    content: args.content ?? '',
    type: args.type,
    status: args.status ?? 'Asserted',
    domain: args.domain ?? [],
    madr: args.madr ?? null,
    affected_entity_ids: affectedIds,
    source_type: args.source_type ?? 'manual',
    source_activity: args.source_activity ?? null,
    created_by: userId,
  };
  if (embedding) record.embedding = embedding;
  if (args.source_id !== undefined) record.source_id = args.source_id;
  if (args.tags !== undefined) record.tags = args.tags;
  if (args.source_task_id !== undefined) record.source_task_id = args.source_task_id;
  if (args.review_by !== undefined) record.review_by = args.review_by;
  if (args.realization !== undefined) record.realization = args.realization;

  const { data, error } = await client
    .from('knowledge_decisions')
    .insert(record)
    .select(DECISION_COLS)
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new Error(`A decision titled "${args.title.trim()}" already exists in this project`);
    }
    throw error;
  }
  return data as unknown as KnowledgeDecisionFull;
}

// ---------------------------------------------------------------------------
// Handler: supersedeDecision
// ---------------------------------------------------------------------------

export interface SupersedeDecisionArgs {
  old_decision_id: string;
  // type+title are BOTH required for successor-mode, BOTH omitted for retire-mode (B-534).
  type?: string;
  title?: string;
  content?: string;
  madr?: Record<string, unknown>;
  domain?: string[];
  affected_entity_names?: string[];
  reason?: string;
}

export async function supersedeDecision(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: SupersedeDecisionArgs,
): Promise<{ superseded: KnowledgeDecisionFull; replacement: KnowledgeDecisionFull | null }> {
  if (!args.old_decision_id) throw new Error('old_decision_id is required');

  // Two modes (B-534):
  //   - SUCCESSOR (both type+title): create the Accepted replacement and link it bidirectionally
  //     (the long-standing behaviour).
  //   - RETIRE   (neither type nor title): supersede WITHOUT a successor — mark the old decision
  //     Superseded with superseded_by=null and create NO replacement. This is what harmony-revise-
  //     scope's no-successor supersede needs: the revised decision is authored LATER, by the target
  //     gate's native re-run (B-529), not here.
  // Exactly one of type/title is ambiguous → reject loudly rather than guess the caller's intent.
  const hasType = !!args.type;
  const hasTitle = !!args.title?.trim();
  if (hasType !== hasTitle) {
    throw new Error(
      'supersede_decision: provide BOTH type and title to supersede with a successor, or NEITHER ' +
      'to retire the decision without a successor (retire-mode). Exactly one of type/title is ambiguous.',
    );
  }
  const retire = !hasType;

  const workspaceId = await getWorkspaceId(client, projectId);

  // Fetch-first guard (mirrors supersedeKnowledgeEntry): verify the target exists, scoped to this
  // workspace+project, BEFORE creating the replacement — so a wrong/foreign/already-gone id can't
  // leave an orphaned 'Accepted' decision with no superseded_by linkage.
  const { data: existing, error: fetchErr } = await client
    .from('knowledge_decisions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', args.old_decision_id)
    .single();
  if (fetchErr || !existing) {
    throw new Error(`Decision ${args.old_decision_id} not found in this project`);
  }

  // 1) Create the replacement (Accepted — it is the new ruling decision) UNLESS this is a retire,
  //    in which case there is no successor to author here.
  const replacement = retire
    ? null
    : await recordDecision(client, projectId, userId, {
        type: args.type!,
        title: args.title!,
        content: args.content,
        madr: args.madr,
        domain: args.domain,
        affected_entity_names: args.affected_entity_names,
        status: 'Accepted',
      });

  // 2) Mark the old decision Superseded + link it (superseded_by=null in retire-mode). The
  //    AFTER-UPDATE trigger (A8) flags referencing tickets stale in BOTH modes.
  const { data, error } = await client
    .from('knowledge_decisions')
    .update({ status: 'Superseded', superseded_by: replacement ? replacement.id : null })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', args.old_decision_id)
    .select(DECISION_COLS)
    .single();
  if (error) throw error;
  return { superseded: data as unknown as KnowledgeDecisionFull, replacement };
}

export const supersedeDecisionTool = {
  name: 'supersede_decision',
  description:
    'Supersede an existing decision. Two modes. (1) SUCCESSOR — provide BOTH type and title: records the ' +
    'replacement as "Accepted", marks the old decision "Superseded" and links them bidirectionally. ' +
    '(2) RETIRE — omit BOTH type and title: marks the old decision "Superseded" with superseded_by=null and ' +
    'creates NO successor (use when the replacement is authored later, e.g. revise-scope backing a ticket up ' +
    'to a gate that re-authors the decision natively). Providing exactly one of type/title is rejected. ' +
    'Either way, tickets referencing the old decision are automatically flagged stale.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      old_decision_id: { type: 'string', description: 'UUID of the decision being superseded' },
      type: { type: 'string', description: 'Type for the replacement decision. Omit BOTH type and title to retire the decision without a successor (retire-mode).' },
      title: { type: 'string', description: 'Title for the replacement decision. Omit BOTH type and title to retire the decision without a successor (retire-mode).' },
      content: { type: 'string', description: 'Optional markdown body for the replacement (successor-mode only)' },
      madr: { type: 'object', description: 'Structured MADR body for the replacement (successor-mode only)' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains for the replacement (successor-mode only)' },
      affected_entity_names: { type: 'array', items: { type: 'string' }, description: 'Entities the replacement touches (successor-mode only)' },
      reason: { type: 'string', description: 'Why the old decision is being superseded' },
    },
    required: ['old_decision_id'],
  },
};

export const recordDecisionTool = {
  name: 'record_decision',
  description:
    'Record a knowledge decision (MADR-shaped) produced by a gate/skill. Created as "Asserted" by default; a human promotes it to "Accepted". Use type product-design / technical-design / ux-ui-design for the design sub-tracks, or architecture / business / convention / specification / deferral.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', description: 'product-design | technical-design | ux-ui-design | architecture | business | convention | specification | deferral' },
      title: { type: 'string', description: 'Decision title (unique within the project)' },
      content: { type: 'string', description: 'Optional human-readable markdown body' },
      madr: { type: 'object', description: 'Structured MADR body: { context, decision_drivers, considered_options, decision_outcome, consequences }' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains: engineering, operations, data, product, customer, process' },
      affected_entity_names: { type: 'array', items: { type: 'string' }, description: 'Entity names this decision touches (resolved/created in knowledge_entities)' },
      status: { type: 'string', description: 'Override status (default "Asserted")' },
      realization: { type: 'string', enum: ['agreed', 'live', 'deprecating', 'retired'], description: 'Implementation/realization state (orthogonal to status); omit ⇒ NULL ≡ live; "agreed" = decided-not-yet-built' },
      source_type: { type: 'string', description: "ticket | adr | manual | inferred | research (default 'manual')" },
      source_id: { type: 'string', description: 'Pointer back to the producing ticket/source' },
      source_activity: { type: 'string', description: 'The gate/skill that authored it (e.g. design-decide, clarify)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      source_task_id: { type: 'string', description: 'Task that triggered this decision' },
      review_by: { type: 'string', description: 'ISO timestamp; freshness/decay date. Researched knowledge sets this ~90 days out so Drift-Risk/review_by resurfacing fires.' },
    },
    required: ['type', 'title'],
  },
};

// ---------------------------------------------------------------------------
// Handler: queryEntities
// ---------------------------------------------------------------------------

export interface QueryEntitiesArgs { kind?: string; name?: string; }

export async function queryEntities(
  client: SupabaseClient,
  projectId: string,
  args: QueryEntitiesArgs,
): Promise<KnowledgeEntityFull[]> {
  const workspaceId = await getWorkspaceId(client, projectId);
  let query = client.from('knowledge_entities').select(ENTITY_COLS).eq('workspace_id', workspaceId);
  if (args.kind) query = query.eq('kind', args.kind);
  if (args.name) query = query.ilike('name', `%${args.name}%`);
  const { data, error } = await query.order('name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeEntityFull[];
}

export const queryEntitiesTool = {
  name: 'query_entities',
  description: 'Resolve or discover knowledge entities (components, features, integrations, concepts) in this workspace by kind and/or name.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', description: "Entity kind: 'component', 'feature', 'integration', 'concept', 'persona'" },
      name: { type: 'string', description: 'Case-insensitive substring match on entity name' },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler: assertFact
// ---------------------------------------------------------------------------

export interface AssertFactArgs {
  subject_entity: string;
  subject_entity_kind?: string;
  predicate: string;
  object: unknown;
  source_type: string;
  source_id?: string;
  confidence?: number;
  domain?: string[];
  review_by?: string;   // ISO timestamp; freshness/decay date (knowledge-model-v1 §3)
}

export async function assertFact(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: AssertFactArgs,
): Promise<KnowledgeFactFull> {
  if (!args.subject_entity?.trim()) throw new Error('subject_entity is required');
  if (!args.predicate?.trim()) throw new Error('predicate is required');
  if (!args.source_type) throw new Error('source_type is required');

  const workspaceId = await getWorkspaceId(client, projectId);
  const subjectId = await resolveOrCreateEntity(
    client, workspaceId, projectId, args.subject_entity, args.subject_entity_kind ?? 'concept',
  );

  const embedding = await embedText(client, `${args.subject_entity} ${args.predicate} ${JSON.stringify(args.object)}`);

  const record: Record<string, unknown> = {
    workspace_id: workspaceId,
    project_id: projectId,
    subject_entity_id: subjectId,
    predicate: args.predicate,
    object: args.object,
    confidence: args.confidence ?? 1.0,
    status: 'Asserted',
    domain: args.domain ?? [],
    source_type: args.source_type,
    created_by: userId,
  };
  if (embedding) record.embedding = embedding;
  if (args.source_id !== undefined) record.source_id = args.source_id;
  if (args.review_by !== undefined) record.review_by = args.review_by;

  const { data, error } = await client.from('knowledge_facts').insert(record).select(FACT_COLS).single();
  if (error) throw error;
  return data as unknown as KnowledgeFactFull;
}

export const assertFactTool = {
  name: 'assert_fact',
  description: 'Assert an atomic fact about an entity (subject-predicate-object) with provenance. Facts enter "Asserted"; research-sourced facts need human promotion before agents act on them autonomously.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      subject_entity: { type: 'string', description: 'Name of the subject entity (resolved/created in knowledge_entities)' },
      subject_entity_kind: { type: 'string', description: "Kind if the entity must be created (default 'concept')" },
      predicate: { type: 'string', description: "e.g. 'implements', 'depends_on', 'uses'" },
      object: { description: 'Entity ref, scalar, or structured JSON value' },
      source_type: { type: 'string', description: 'ticket | adr | manual | inferred | research (required — provenance)' },
      source_id: { type: 'string', description: 'Pointer back to the source ticket/decision' },
      confidence: { type: 'number', description: '0..1 (default 1.0)' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains this fact belongs to' },
      review_by: { type: 'string', description: 'ISO timestamp; freshness/decay date. Researched knowledge sets this ~90 days out so Drift-Risk/review_by resurfacing fires.' },
    },
    required: ['subject_entity', 'predicate', 'object', 'source_type'],
  },
};

// ---------------------------------------------------------------------------
// Handler: invalidateFact
// ---------------------------------------------------------------------------

export interface InvalidateFactArgs { fact_id: string; reason?: string; }

export async function invalidateFact(
  client: SupabaseClient,
  projectId: string,
  args: InvalidateFactArgs,
): Promise<KnowledgeFactFull> {
  if (!args.fact_id) throw new Error('fact_id is required');
  const workspaceId = await getWorkspaceId(client, projectId);
  const { data, error } = await client
    .from('knowledge_facts')
    .update({ valid_to: new Date().toISOString(), status: 'Superseded' })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', args.fact_id)
    .select(FACT_COLS)
    .single();
  if (error) throw error;
  return data as unknown as KnowledgeFactFull;
}

export const invalidateFactTool = {
  name: 'invalidate_fact',
  description: 'Mark a fact as no longer valid (sets valid_to=now, status=Superseded). Graphiti invalidation pattern — the fact is retained for temporal queries, not deleted.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fact_id: { type: 'string', description: 'UUID of the fact to invalidate' },
      reason: { type: 'string', description: 'Why it is no longer valid' },
    },
    required: ['fact_id'],
  },
};

// ---------------------------------------------------------------------------
// Handler: queryFacts
// ---------------------------------------------------------------------------

export interface QueryFactsArgs {
  entity?: string;
  predicate?: string;
  as_of?: string;
  min_confidence?: number;
  include_invalidated?: boolean;
}

export async function queryFacts(
  client: SupabaseClient,
  projectId: string,
  args: QueryFactsArgs,
): Promise<KnowledgeFactFull[]> {
  const workspaceId = await getWorkspaceId(client, projectId);
  let query = client.from('knowledge_facts').select(FACT_COLS).eq('workspace_id', workspaceId);

  if (!args.include_invalidated && !args.as_of) query = query.is('valid_to', null);  // currently valid
  if (args.as_of) {
    query = query.lte('valid_from', args.as_of).or(`valid_to.is.null,valid_to.gt.${args.as_of}`);
  }
  if (args.predicate) query = query.eq('predicate', args.predicate);
  if (args.min_confidence !== undefined) query = query.gte('confidence', args.min_confidence);

  // Entity filter by name -> ids. A name can legitimately exist under multiple kinds
  // (UNIQUE is (workspace_id, kind, name)), so resolve ALL matches and filter with .in(),
  // and surface a real lookup error rather than masking it as an empty result.
  if (args.entity) {
    const { data: ents, error: entErr } = await client
      .from('knowledge_entities')
      .select('id')
      .eq('workspace_id', workspaceId)
      .ilike('name', args.entity);
    if (entErr) throw new Error(entErr.message);
    const ids = (ents ?? []).map((e) => (e as { id: string }).id);
    if (ids.length === 0) return [];
    query = query.in('subject_entity_id', ids);
  }

  const { data, error } = await query.order('recorded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as KnowledgeFactFull[];
}

export const queryFactsTool = {
  name: 'query_facts',
  description: 'Query facts: "what is true (or was true) about X". Returns currently-valid facts by default; pass as_of for a point-in-time view.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entity: { type: 'string', description: 'Subject entity name (case-insensitive exact match)' },
      predicate: { type: 'string', description: 'Filter by predicate' },
      as_of: { type: 'string', description: 'ISO timestamp — facts valid at this instant' },
      min_confidence: { type: 'number', description: 'Only facts with confidence >= this' },
      include_invalidated: { type: 'boolean', description: 'Include facts whose valid_to is set' },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler: supersedeKnowledgeEntry
// ---------------------------------------------------------------------------

export interface SupersedeKnowledgeEntryArgs {
  entry_id?: string;
  title?: string;
  new_title: string;
  new_content: string;
  type?: string;
  tags?: string[];
}

export async function supersedeKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: SupersedeKnowledgeEntryArgs,
): Promise<{ superseded: KnowledgeEntryFull; replacement: KnowledgeEntryFull }> {
  if (!args.entry_id && !args.title) {
    throw new Error('Either entry_id or title must be provided to identify the entry to supersede');
  }

  // Step 1: fetch the existing entry (scoped to projectId via getKnowledgeEntry)
  const existing = await getKnowledgeEntry(client, projectId, {
    entry_id: args.entry_id,
    title: args.title,
  });

  // Step 2: create the replacement entry (status='accepted'), scoped to the token's project
  const replacement = await createKnowledgeEntry(client, projectId, userId, {
    title: args.new_title,
    content: args.new_content,
    type: args.type ?? existing.type,
    status: 'accepted',
    tags: args.tags ?? existing.tags,
    source_task_id: existing.source_task_id ?? undefined,
  });

  // Step 3: mark the old entry as superseded and set superseded_by in one update.
  // Must hit the BASE table (v1 vocab): a workspace_knowledge view update silently
  // matches zero rows for next-gen-typed entries (outside the view's WHERE) and would
  // error here AFTER step 2 — orphaning the already-created replacement (B-418).
  const workspaceId = await getWorkspaceId(client, projectId);
  const { data: supersededData, error } = await client
    .from('knowledge_decisions')
    .update({ status: 'Superseded', superseded_by: replacement.id })
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId)
    .eq('id', existing.id)
    .select(
      'id, workspace_id, project_id, title, content, type, status, superseded_by, tags, source_task_id, created_by, created_at, updated_at',
    )
    .single();

  if (error) throw error;

  return {
    superseded: supersededData as KnowledgeEntryFull,
    replacement,
  };
}
