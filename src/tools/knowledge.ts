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
}

export interface KnowledgeDecisionFull {
  id: string;
  workspace_id: string;
  project_id: string | null;
  title: string;
  content: string;
  type: string;
  status: string;              // Asserted | Accepted | Superseded | Archived
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
  'id, workspace_id, project_id, title, content, type, status, domain, confidence, review_by, drift_risk, ' +
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
    'Search the knowledge base for architecture decisions, business decisions, conventions, and specifications scoped to this project. Check this before making significant implementation choices. Defaults to "Accepted" entries only.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      type: {
        type: 'string',
        description: 'Filter by entry type (e.g. "architecture", "business", "convention", "specification")',
      },
      status: {
        type: 'string',
        description: 'Filter by status. Default: "Accepted".',
      },
      domain: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter to entries tagged with ANY of these domains: engineering, operations, data, product, customer, process. Query the relevant domain before deciding.',
      },
      as_of: {
        type: 'string',
        description: 'ISO timestamp — return entries valid at or before this instant (temporal query).',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter entries that contain ALL of these tags',
      },
      search: {
        type: 'string',
        description: 'Search term matched against title and content (case-insensitive)',
      },
      include_superseded: {
        type: 'boolean',
        description: 'When true and no explicit status given, return all statuses including superseded. Default false.',
      },
      limit: { type: 'number', description: 'Max results to return. Default 50.' },
      offset: { type: 'number', description: 'Number of results to skip (for pagination). Default 0.' },
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
  description: 'Update an existing knowledge entry in this project by ID or title. Can update title, content, type, status, or tags.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entry_id: { type: 'string', description: 'Knowledge entry UUID' },
      title: { type: 'string', description: 'Current entry title (used to find the entry if entry_id not provided)' },
      new_title: { type: 'string', description: 'New title for the entry' },
      content: { type: 'string', description: 'New markdown content' },
      type: { type: 'string', description: 'New entry type' },
      status: { type: 'string', description: 'New status' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replace tags with this list',
      },
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
// Internal helper
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

  let query = client
    .from('knowledge_decisions')
    .select('id, title, type, status, domain, tags, project_id, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('project_id', projectId);

  if (args.status) {
    query = query.eq('status', args.status);
  } else if (!args.include_superseded) {
    query = query.eq('status', 'Accepted');          // v1 lifecycle vocab
  }

  if (args.type) query = query.eq('type', args.type);
  if (args.domain && args.domain.length > 0) query = query.overlaps('domain', args.domain);
  if (args.as_of) query = query.lte('valid_from', args.as_of);
  if (args.tags && args.tags.length > 0) query = query.contains('tags', args.tags);
  if (args.search) query = query.or(`title.ilike.%${args.search}%,content.ilike.%${args.search}%`);

  query = query.order('type', { ascending: true });

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const { data, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(error.message);
  return (data ?? []) as KnowledgeEntrySummary[];
}

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

  let query = client
    .from('workspace_knowledge')
    .select(
      'id, workspace_id, project_id, title, content, type, status, superseded_by, tags, source_task_id, created_by, created_at, updated_at',
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
    status: args.status ?? 'draft',
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
  return data as KnowledgeEntryFull;
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
    args.tags !== undefined;

  if (!hasUpdates) {
    throw new Error('At least one field to update must be provided');
  }

  const workspaceId = await getWorkspaceId(client, projectId);

  const updates: Record<string, unknown> = {};
  if (args.new_title !== undefined) updates.title = args.new_title.trim();
  if (args.content !== undefined) updates.content = args.content;
  if (args.type !== undefined) updates.type = args.type;
  if (args.status !== undefined) updates.status = args.status;
  if (args.tags !== undefined) updates.tags = args.tags;

  let query = client
    .from('workspace_knowledge')
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
      'id, workspace_id, project_id, title, content, type, status, superseded_by, tags, source_task_id, created_by, created_at, updated_at',
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
  return data as KnowledgeEntryFull;
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
  if (args.source_id !== undefined) record.source_id = args.source_id;
  if (args.tags !== undefined) record.tags = args.tags;
  if (args.source_task_id !== undefined) record.source_task_id = args.source_task_id;

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
  type: string;
  title: string;
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
): Promise<{ superseded: KnowledgeDecisionFull; replacement: KnowledgeDecisionFull }> {
  if (!args.old_decision_id) throw new Error('old_decision_id is required');

  // 1) Create the replacement (Accepted — it is the new ruling decision).
  const replacement = await recordDecision(client, projectId, userId, {
    type: args.type,
    title: args.title,
    content: args.content,
    madr: args.madr,
    domain: args.domain,
    affected_entity_names: args.affected_entity_names,
    status: 'Accepted',
  });

  // 2) Mark the old decision Superseded + link it. The AFTER-UPDATE trigger (A8) flags referencing tickets stale.
  const workspaceId = await getWorkspaceId(client, projectId);
  const { data, error } = await client
    .from('knowledge_decisions')
    .update({ status: 'Superseded', superseded_by: replacement.id })
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
    'Supersede an existing decision with a new one. Records the replacement as "Accepted", marks the old decision "Superseded" and links them. Tickets referencing the old decision are automatically flagged stale.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      old_decision_id: { type: 'string', description: 'UUID of the decision being superseded' },
      type: { type: 'string', description: 'Type for the replacement decision' },
      title: { type: 'string', description: 'Title for the replacement decision' },
      content: { type: 'string', description: 'Optional markdown body for the replacement' },
      madr: { type: 'object', description: 'Structured MADR body for the replacement' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains for the replacement' },
      affected_entity_names: { type: 'array', items: { type: 'string' }, description: 'Entities the replacement touches' },
      reason: { type: 'string', description: 'Why the old decision is being superseded' },
    },
    required: ['old_decision_id', 'type', 'title'],
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
      source_type: { type: 'string', description: "ticket | adr | manual | inferred | research (default 'manual')" },
      source_id: { type: 'string', description: 'Pointer back to the producing ticket/source' },
      source_activity: { type: 'string', description: 'The gate/skill that authored it (e.g. design-decide, clarify)' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      source_task_id: { type: 'string', description: 'Task that triggered this decision' },
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
  if (args.source_id !== undefined) record.source_id = args.source_id;

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

  // Entity filter by name -> id (one extra lookup keeps the public API name-based).
  if (args.entity) {
    const { data: ent } = await client
      .from('knowledge_entities').select('id').eq('workspace_id', workspaceId).ilike('name', args.entity).maybeSingle();
    if (ent) query = query.eq('subject_entity_id', (ent as { id: string }).id);
    else return [];
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

  // Step 3: mark the old entry as superseded and set superseded_by in one update
  const workspaceId = await getWorkspaceId(client, projectId);
  const { data: supersededData, error } = await client
    .from('workspace_knowledge')
    .update({ status: 'superseded', superseded_by: replacement.id })
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
