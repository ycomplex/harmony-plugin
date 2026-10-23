import { readKnowledgeNames, withRetiredWording } from './knowledge-names.js';
import { readSourceValues } from './knowledge-sources.js';
import { questionProjection } from './knowledge-questions.js';
import { metadataCapable, metadataRpc, type KnowledgeScope } from './knowledge-metadata.js';
import { readClaimContexts, withClaimContexts, type ClaimContext, type QuestionReference } from './claim-context.js';
import { readDefinitions, type Definition } from './knowledge-definitions.js';
import { searchKnowledge, normalizeTags, type KnowledgeSearchResult } from './knowledge-search.js';
import { projectSupersession } from './knowledge-supersession.js';
import { withInvalidations, type InvalidationLink } from './knowledge-invalidations.js';
import { truthCompatibleRead, truthStatePatch, type KnowledgeTruthState } from './knowledge-truth.js';
import { BOOKKEEPING_TAG, SUBSTANTIVE_TAG_FILTER, bookkeepingPage } from './knowledge-bookkeeping.js';
import { claimFields, encodeClaim, editedClaimContent, claimContent, matchedPassage, proposeClaim } from './knowledge-claim.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeHtmlEntities } from './text-normalize.js';
import { getConductionId, getLeg } from '../config/run-config.js';
import { guardKnowledgeWriteProvenance } from './provenance.js';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface KnowledgeEntrySummary extends KnowledgeTruthState {
  scope?: KnowledgeScope | null;
  snippet?: string | null;
  claim?: string | null;
  claim_context?: ClaimContext;
  claim_source?: 'authored' | 'derived' | null;
  question_state?: 'open' | 'parked' | 'decided';
  question_scope?: 'product' | 'deployment';
  answer?: string;
  resulting_decision_id?: string | null;
  score?: number;
  invalidations?: InvalidationLink[];
  invalidations_available?: boolean;
  invalidation_rollout_available?: boolean;
  id: string;
  title: string;
  type: string;
  status: string;
  domain: string[];
  tags: string[];
  project_id: string | null;
  updated_at: string;
  superseded_by?: string | null;
  supersedes?: string[];
}

export interface KnowledgeEntryFull extends KnowledgeTruthState {
  scope?: KnowledgeScope | null;
  claim?: string | null;
  claim_context?: ClaimContext;
  claim_source?: 'authored' | 'derived' | null;
  question_state?: 'open' | 'parked' | 'decided';
  question_scope?: 'product' | 'deployment';
  answer?: string;
  resulting_decision_id?: string | null;
  invalidations?: InvalidationLink[];
  invalidations_available?: boolean;
  invalidation_rollout_available?: boolean;
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

export interface KnowledgeDecisionFull extends KnowledgeTruthState {
  scope?: KnowledgeScope | null;
  claim?: string | null;
  claim_context?: ClaimContext;
  claim_source?: 'authored' | 'derived' | null;
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
  question_state?: string;
  question_scope?: string;
  answer?: string;
  resulting_decision_id?: string | null;
  score?: number;
}

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
  // B-977: present ONLY when this create/resolve tripped a same-name-different-kind collision —
  // a non-blocking warning, never populated on a plain read (queryEntities, getKnowledgeEntry-
  // adjacent paths never set it).
  collision_warning?: EntityCollisionWarning;
}
const ENTITY_COLS = 'id, workspace_id, project_id, kind, name, description, metadata, created_at';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const queryKnowledgeTool = {
  name: 'query_knowledge',
  description:
    'Find current term definitions first; structured lists also include current source-generated deployment facts with inspectable provenance. Generated facts remain Asserted. Search the knowledge base for architecture decisions, business decisions, conventions, and specifications scoped to this project. Results include nullable superseded_by and inverse supersedes UUIDs; structured lists place matching successors before replaced entries, while search preserves score order. Check this before making significant implementation choices. Default search includes Accepted entries, configured source-backed document/skill headings and current Asserted generated values in one scored pool. Prose exposes provenance and a source heading link, never Accepted authority. Explicit decision status/type filters exclude prose/generated sources. Coverage and defined-in resolution are explicit; optional claim-context and historical-wording enrichment share the deadline. Explicitly marked bookkeeping is ranked last; include_bookkeeping:false excludes it before pagination. Free-text search combines type/status/all normalized tags/any domain and returns a six-second bounded envelope: scored matches, ordered unscored legacy matches, cutoff 0.0125, below_cutoff_count and coverage, normalized query/filters and routes tried. Scores use genuine global RRF ranks. Filter-only calls retain their list shape. as_of/include_superseded/offset are list-only. Optional context_tags supplies relevant surface/ticket tags for actual tag suggestions.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      definitions_only: { type: 'boolean', description: 'Return only current accepted term definitions; unavailable storage is reported explicitly' },
      type: {
        type: 'string',
        description: 'Filter by advisory authoring classification (e.g. "architecture", "business", "convention", "specification").',
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
        description: 'ISO timestamp — return entries valid at or before this instant (temporal query; list-only).',
      },
      scope: { type: 'string', enum: ['product', 'deployment'], description: 'Product behaviour or deployment operations. Explicit filters exclude unresolved legacy scope and fail visibly before schema promotion.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter entries containing ALL tags; trimmed and lowercased.',
      },
      context_tags: { type: 'array', items: { type: 'string' }, description: 'Relevant surface/ticket tags; suggest at most eight actual tags from matching context. Omit for no suggestions.' },
      search: {
        type: 'string',
        description: 'Free-text search query — hybrid semantic + trigram retrieval, ranked by relevance (RRF). Composes with type, status, tags, domain, limit and include_bookkeeping.',
      },
      question_state: { type: 'string', enum: ['open', 'parked', 'decided'], description: 'Filter open, parked or decided questions; composes with search before ranking.' },
      question_scope: { type: 'string', enum: ['product', 'deployment'], description: 'Question metadata scope; composes with search before ranking.' },
      include_bookkeeping: { type: 'boolean', description: 'Include explicitly marked procedural gate records after substantive knowledge (default true). False excludes them before pagination.' },
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
      id: { type: 'string', description: 'Alias of entry_id; conflicting values are rejected' },
      entry_id: { type: 'string', description: 'Knowledge entry UUID' },
      title: { type: 'string', description: 'Entry title (exact match)' },
    },
  },
};

export const createKnowledgeEntryTool = {
  name: 'create_knowledge_entry',
  description:
    'DEPRECATED: use record_decision. Create a new knowledge entry in this project. Entries are created as "draft" by default — humans review and accept them. Use for architecture decisions, business decisions, conventions, and specifications (spec documents describing work to be built).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      claim: { type: 'string', description: 'Authored one-sentence claim, at most 50 words; omission derives an unconfirmed proposal during rollout' },
      title: { type: 'string', description: 'Entry title (must be unique within the project)' },
      content: { type: 'string', description: 'Markdown content of the entry' },
      type: {
        type: 'string',
        description: 'Advisory authoring classification, not verified: "architecture", "business", "convention", or "specification"',
      },
      status: {
        type: 'string',
        description: 'Status override. Default: "draft".',
      },
      scope: { type: 'string', enum: ['product', 'deployment'], description: 'Product behaviour or this deployment operations. Required for new entries once metadata is available. Mixed claims must be separated.' },
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
  description: 'DEPRECATED: use record_decision (or supersede_decision to replace an entry). Update an existing knowledge entry in this project by ID or title. Use content_mode prepend_section/append_section to add only a new section while atomically preserving existing content. Shorter replacements that drop dated amendment markers are refused unless allow_shrink is explicitly true. Can also update title, type, status, tags, domain, madr, realization, review_by, verified_against, rollout_state or open_steps.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      claim: { type: 'string', description: 'Authored one-sentence claim, at most 50 words; omission derives an unconfirmed proposal during rollout' },
      entry_id: { type: 'string', description: 'Knowledge entry UUID' },
      title: { type: 'string', description: 'Current entry title (used to find the entry if entry_id not provided)' },
      new_title: { type: 'string', description: 'New title for the entry' },
      content: { type: 'string', description: 'Replacement markdown, or only the new section when content_mode is prepend_section/append_section.' },
      content_mode: { type: 'string', enum: ['replace', 'prepend_section', 'append_section'], description: 'Default replace. Section modes merge with the stored entry atomically and preserve its content.' },
      allow_shrink: { type: 'boolean', description: 'Explicitly permit a deliberate shorter replacement that drops dated amendment sections. Default false.' },
      type: { type: 'string', description: 'New entry type' },
      status: { type: 'string', description: 'New status: Asserted, Accepted, Superseded, or Archived (legacy lowercase draft/accepted/superseded also accepted)' },
      scope: { type: 'string', enum: ['product', 'deployment'], description: 'Product behaviour or this deployment operations. Required for new entries once metadata is available. Mixed claims must be separated.' },
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
      acting_task_id: { type: 'string', description: 'Acting ticket UUID for a verification/rollout write. Omit to use the current conduction ticket; manual writes without a ticket record null.' },
      verified_against: { type: ['object', 'null'], properties: { plugin_version: { type: ['string', 'null'] }, web_sha: { type: ['string', 'null'] }, at: { type: 'string' } }, required: ['at'], additionalProperties: false, description: 'Observed versions and ISO verification time; null clears verification. At least one version must be present.' },
      rollout_state: { type: ['string', 'null'], enum: ['designed', 'partly-live', 'live', 'retired', null], description: 'Production rollout, independent of acceptance and realization. live means production; partly-live means partly in production; staging-only remains designed. null means unknown. Cutover time is the re-stamped event created_at, never verified_against.at.' },
      open_steps: { type: ['array', 'null'], items: { type: 'string' }, description: 'Remaining rollout steps; partly-live requires at least one nonblank step. null clears the list.' },
      review_by: { type: 'string', description: 'ISO timestamp; freshness/decay date (knowledge-model-v1 §3)' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
  },
};

export const supersedeKnowledgeEntryTool = {
  name: 'supersede_knowledge_entry',
  description:
    'DEPRECATED: use supersede_decision. Supersede an existing knowledge entry in this project with a new replacement. Marks the old entry as "superseded" and creates the replacement as "accepted", linking them via superseded_by.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      new_claim: { type: 'string', description: 'One-sentence authored claim for a new replacement entry' },
      entry_id: { type: 'string', description: 'UUID of the entry to supersede' },
      title: { type: 'string', description: 'Title of the entry to supersede (used if entry_id not provided)' },
      new_title: { type: 'string', description: 'Title for the replacement entry' },
      new_content: { type: 'string', description: 'Content for the replacement entry' },
      type: { type: 'string', description: 'Type for the replacement (defaults to type of superseded entry)' },
      scope: { type: 'string', enum: ['product', 'deployment'], description: 'Product behaviour or this deployment operations. Required for new entries once metadata is available. Mixed claims must be separated.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for the replacement (defaults to tags of superseded entry)',
      },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['new_title', 'new_content'],
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Exported for workflow.ts's link_ticket_entities (B-977), which needs the same projectId ->
// workspaceId resolution recordDecision/createEntity/etc. already rely on internally.
export async function getWorkspaceId(client: SupabaseClient, projectId: string): Promise<string> {
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
 * Why this exists: createKnowledgeEntry inserts into the base table without an
 * `embedding` (B-375 / B-401), and a content-changing update can leave the vector
 * stale → the row is invisible to knowledge_search_rrf (which filters
 * `embedding IS NOT NULL`). The embed-knowledge
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

const BASE_STATUS_MAP: Record<string, string> = {
  draft: 'Asserted', accepted: 'Accepted', superseded: 'Superseded',
  Asserted: 'Asserted', Accepted: 'Accepted', Superseded: 'Superseded', Archived: 'Archived',
};

/**
 * Normalize a caller-supplied status into the v1-capitalized vocab the
 * `knowledge_decisions` BASE table's CHECK constraint accepts (B-418).
 *
 * Every knowledge write path (createKnowledgeEntry, updateKnowledgeEntry,
 * supersedeKnowledgeEntry's mark-superseded step) writes the base table directly and must
 * speak 'Asserted'|'Accepted'|'Superseded'|'Archived', while legacy callers may still pass
 * the old lowercase vocab (draft/accepted/superseded), which is mapped here. Anything unrecognized is REJECTED loudly rather than silently dropped.
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
  scope?: KnowledgeScope;
  definitions_only?: boolean;
  type?: string;
  status?: string;
  domain?: string[];          // NEW: filter to entries tagged with ANY of these domains
  as_of?: string;             // NEW: ISO date — entries valid at/before this instant
  tags?: string[];
  search?: string;
  include_superseded?: boolean;
  include_bookkeeping?: boolean;
  limit?: number;
  offset?: number;
  context_tags?: string[];
  question_state?: 'open' | 'parked' | 'decided';
  question_scope?: 'product' | 'deployment';
}

export function queryKnowledge(client: SupabaseClient, projectId: string, args: QueryKnowledgeArgs & { search?: undefined }): Promise<Array<KnowledgeEntrySummary | Definition | ConceptNameResult>>;
export function queryKnowledge(client: SupabaseClient, projectId: string, args: QueryKnowledgeArgs & { search: string }): Promise<KnowledgeSearchResult>;
export function queryKnowledge(client: SupabaseClient, projectId: string, args: QueryKnowledgeArgs): Promise<Array<KnowledgeEntrySummary | Definition | ConceptNameResult> | KnowledgeSearchResult>;
export async function queryKnowledge(
  client: SupabaseClient,
  projectId: string,
  args: QueryKnowledgeArgs,
): Promise<Array<KnowledgeEntrySummary | Definition | ConceptNameResult> | KnowledgeSearchResult> {
  const started = performance.now();
  if (args.search?.trim()) return searchKnowledge(client, projectId, { ...args, status: args.status ? toBaseStatus(args.status) : undefined }, started);
  args = { ...args, tags: args.tags ? normalizeTags(args.tags) : undefined };
  const workspaceId = await getWorkspaceId(client, projectId);
  if (args.question_state && !['open', 'parked', 'decided'].includes(args.question_state)) {
    throw new Error('question_state must be open, parked or decided');
  }
  if (args.scope !== undefined) {
    if (!['product', 'deployment'].includes(args.scope)) throw new Error('scope must be product or deployment');
    if (!await metadataCapable(client)) throw new Error('Scope filtering unavailable until the schema is promoted; no unfiltered results returned.');
  }

  if (args.definitions_only && (args.type || args.status || args.tags?.length || args.as_of || args.include_superseded)) {
    throw new Error('definitions_only supports search, domain, limit and offset; ordinary decision filters are not definition filters');
  }
  if (args.limit === 0) return [];
  const definitions = await readDefinitions(client, workspaceId, projectId, args);
  const conceptNames = args.search ? await readKnowledgeNames(client,projectId,{search:args.search}) : null;
  if (args.definitions_only) {
    if (!definitions.available) throw new Error('Definitions are not available in this environment yet.');
    return definitions.definitions;
  }
  // Explicit historical/type filters remain decision-only. Default lookup gives current terms first.
  const includeDefinitions = !args.type && !args.status && !args.tags?.length && !args.as_of && !args.include_superseded && args.scope !== 'deployment';
  const noDefinition: ConceptNameResult[] = (conceptNames?.matches ?? []).filter(m=>m.state==='no-current-definition').map(m=>({id:m.concept_id,kind:'concept',title:m.current_name,concept_id:m.concept_id,state:m.state,matched_alias:m.matched_alias}));
  const includeSources = !args.type && !args.status && !args.tags?.length && !args.as_of && !args.include_superseded && args.scope !== 'product' && (!args.domain?.length || args.domain.includes('operations'));
  const sourceOffset = Math.max(0, (args.offset ?? 0) - (includeDefinitions ? (definitions.total_count ?? definitions.definitions.length) + noDefinition.length : 0));
  const generated = includeSources ? await readSourceValues(client, projectId, { search: args.search, limit: args.limit, offset: sourceOffset }) : { values: [], total_count: 0 };
  const prepend = async (entries: KnowledgeEntrySummary[]) => {
    // Enrich decisions only: definitions, source inventories and concept placeholders are separate result kinds.
    const enrichClaims = async <T extends {id:string}>(rows:T[]):Promise<T[]> => {
      const enriched=await withClaimContexts(client,rows.filter(e=>{const kind=e as {type?:string;kind?:string;source_type?:string};return kind.type!=='definition' && kind.kind!=='concept' && kind.source_type!=='generated';}));
      const contexts=new Map(enriched.map(e=>[e.id,e]));
      return withRetiredWording(client,projectId,rows.map(e=>contexts.get(e.id)??e));
    };
    if (!includeDefinitions) return enrichClaims([...generated.values, ...entries].slice(0, args.limit ?? 50));
    const ids = args.search ? [...new Set(definitions.definitions.flatMap(d => d.refinements.map(r => r.id)))] : [];
    let refinements: KnowledgeEntrySummary[] = [];
    if (ids.length) {
      let query = client.from('knowledge_decisions').select('id,title,type,status,content,domain,tags,project_id,updated_at').eq('workspace_id', workspaceId)
        .eq('project_id', projectId).eq('status', 'Accepted').in('id', ids);
      if (args.domain?.length) query = query.overlaps('domain', args.domain);
      const { data, error } = await query;
      if (error) throw new Error(`Cannot read definition refinements: ${error.message}`);
      refinements = await withInvalidations(client, await hydrateSupersession(client, workspaceId, projectId,
        (data ?? []).map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status, domain: d.domain, tags: d.tags, project_id: d.project_id, updated_at: d.updated_at, ...claimFields(d), snippet: matchedPassage(d.content ?? '', args.search!) }))));
    }
    const seen = new Set<string>();
    const result = [...definitions.definitions, ...noDefinition, ...refinements, ...generated.values, ...entries].filter(entry => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id); return true;
    }).slice(0, args.limit ?? 50);
    return enrichClaims(result);
  };
  const prefixCount = (includeDefinitions ? (definitions.total_count ?? definitions.definitions.length) + noDefinition.length : 0) + generated.total_count;
  const pagePrefixCount = (includeDefinitions ? definitions.definitions.length + noDefinition.length : 0) + generated.values.length;
  const decisionArgs = { ...args, offset: Math.max(0, (args.offset ?? 0) - prefixCount), limit: Math.max(1, (args.limit ?? 50) - pagePrefixCount) };
  if (pagePrefixCount >= (args.limit ?? 50)) return prepend([]);

  // Structured retrieval uses the same class boundary and applies every filter before pagination.
  const rows = await bookkeepingPage<KnowledgeEntrySummary>(({ bookkeeping, offset, limit, count }) => {
    let query = client.from('knowledge_decisions')
      .select('*', count ? { count: 'exact' } : {})
      .eq('workspace_id', workspaceId)
      .eq('project_id', projectId);
    if (args.scope) query = query.eq('scope', args.scope);
    if (args.status) query = query.eq('status', args.status);
    else if (!args.include_superseded) query = query.eq('status', args.question_state === 'decided' ? 'Superseded' : 'Accepted');
    if (args.type) query = query.eq('type', args.type);
    if (args.question_state) query = query.eq('source_activity', 'knowledge-question').eq('madr->question->>state', args.question_state);
    if (args.domain && args.domain.length > 0) query = query.overlaps('domain', args.domain);
    if (args.as_of) query = query.lte('valid_from', args.as_of);
    if (args.tags && args.tags.length > 0) query = query.contains('tags', args.tags);
    query = bookkeeping ? query.contains('tags', [BOOKKEEPING_TAG]) : query.or(SUBSTANTIVE_TAG_FILTER);
    return query.order('type', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + limit - 1);
  }, decisionArgs);
  // B-1136 claim fields first, then B-1230 page-bounded supersession hydration (both page-local).
  return prepend(await withInvalidations(client, await hydrateSupersession(client, workspaceId, projectId, rows.map(d => ({ id: d.id, title: d.title, type: d.type, status: d.status, ...(d.scope !== undefined ? {scope:d.scope} : {}), domain: d.domain, tags: d.tags, project_id: d.project_id, updated_at: d.updated_at, ...claimFields(d), ...questionProjection(d), verified_against: d.verified_against ?? null, rollout_state: d.rollout_state ?? null, open_steps: d.open_steps ?? null })))));
}

// Hydrate only returned IDs, in batches below PostgREST's row cap. Never scan the corpus
// or pull a successor into the caller's page; precedence applies only to returned rows.
async function hydrateSupersession(client: SupabaseClient, workspaceId: string, projectId: string, rows: KnowledgeEntrySummary[]) {
  const edges: Array<{ id: string; superseded_by?: string | null }> = [];
  for (let offset = 0; offset < rows.length; offset += 500) {
    const ids = rows.slice(offset, offset + 500).map(row => row.id);
    for (const column of ['id', 'superseded_by']) {
      const { data, error } = await client.from('knowledge_decisions').select('id, superseded_by')
        .eq('workspace_id', workspaceId).eq('project_id', projectId)
        .neq('type', 'intent').in(column, ids).limit(500);
      if (error) throw new Error(error.message);
      edges.push(...(data ?? []));
    }
  }
  return projectSupersession(rows, edges);
}

// ---------------------------------------------------------------------------
// Handler: searchTicketIntents (B-551 Phase 2 — the intent-only retrieval surface)
// ---------------------------------------------------------------------------

export interface TicketIntentMatch {
  source_task_id: string;  // the originating TICKET (what the caller actually wants)
  content: string;         // title + description (raw ticket intent), capped at 400 chars (see truncateContent)
  score: number;           // RRF fusion score (higher = more relevant)
}

// B-837: search_ticket_intents at ordinary limits (20-25) blows the MCP tool-result payload
// ceiling for large-corpus areas, spilling the response to a file instead of returning inline.
// Fix is a TS-layer projection trim only (no RPC/schema change): drop the unused `id` field and
// cap `content` to 400 chars with a visible truncation marker. Mirrors the B-776 convention of
// capping INPUT at 400 chars, but there's no existing helper for the RETURNED content, hence this
// small local one.
const TICKET_INTENT_CONTENT_CAP = 400;

function truncateContent(content: string): string {
  return content.length > TICKET_INTENT_CONTENT_CAP
    ? `${content.slice(0, TICKET_INTENT_CONTENT_CAP)} […truncated]`
    : content;
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
    source_task_id: d.source_task_id,
    content: truncateContent(d.content as string),
    score: d.score,
  })) as unknown as TicketIntentMatch[];
}

export const searchTicketIntentsTool = {
  name: 'search_ticket_intents',
  description:
    'Find existing TICKETS whose raw intent (title + description) overlaps a query — the intent-only retrieval surface (hybrid semantic + trigram RRF, ranked by relevance). Use this to check whether a ticket already captures what someone is about to ask for (dedup / "is this already requested?"). This is SEPARATE from query_knowledge: it returns ONLY ticket-intent rows (status-agnostic) and never a design/spec/convention decision, so the two corpora never bleed. Returns each match as { source_task_id, content, score }; resolve source_task_id with get_task to inspect the ticket. `content` is capped at 400 chars with a visible truncation marker when the full ticket intent is longer.',
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
  args: { entry_id?: string; id?: string; title?: string },
): Promise<KnowledgeEntryFull> {
  if (args.id && args.entry_id && args.id !== args.entry_id) throw new Error('id and entry_id must identify the same entry');
  args = { ...args, entry_id: args.entry_id ?? args.id };
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
      '*',
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
  return (await withRetiredWording(client,projectId,await withClaimContexts(client, await withInvalidations(client, [{ ...data, ...claimFields(data), ...questionProjection(data), verified_against: data.verified_against ?? null, rollout_state: data.rollout_state ?? null, open_steps: data.open_steps ?? null } as KnowledgeEntryFull]))))[0];
}

// ---------------------------------------------------------------------------
// Handler: createKnowledgeEntry
// ---------------------------------------------------------------------------

export interface CreateKnowledgeEntryArgs {
  scope?: KnowledgeScope;
  claim?: string;
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

  const title = normalizeHtmlEntities(args.title.trim());
  const claimedContent = claimContent(title, normalizeHtmlEntities(args.content ?? ''), args.claim === undefined ? undefined : normalizeHtmlEntities(args.claim));
  const workspaceId = await getWorkspaceId(client, projectId);

  const capable = await metadataCapable(client);
  if (args.scope && !capable) throw new Error('Knowledge scope unavailable until the schema is promoted; nothing was saved.');
  if (capable && !args.scope) throw new Error('New knowledge requires product or deployment scope.');
  // Base-table insert (B-349). The retired compat view's INSERT trigger did COALESCE(content,'')
  // and COALESCE(tags,'{}'); claimContent always yields a string and tags default to [] here.
  const record: Record<string, unknown> = {
    ...(capable ? {scope: args.scope} : {}),
    workspace_id: workspaceId,
    project_id: projectId,
    title: normalizeHtmlEntities(args.title.trim()),
    content: claimedContent,
    type: args.type,
    status: args.status !== undefined ? toBaseStatus(args.status) : 'Asserted',
    created_by: userId,
  };

  record.tags = args.tags !== undefined ? normalizeTags(args.tags) : [];
  if (args.source_task_id !== undefined) record.source_task_id = args.source_task_id;

  const { data, error } = await client
    .from('knowledge_decisions')
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
  // Re-read (getKnowledgeEntry: workspace lookup + base-table select) for the authoritative
  // persisted row (B-415) — status in v1 vocab.
  return getKnowledgeEntry(client, projectId, { entry_id: created.id });
}

// ---------------------------------------------------------------------------
// Handler: updateKnowledgeEntry
// ---------------------------------------------------------------------------

export interface UpdateKnowledgeEntryArgs extends KnowledgeTruthState {
  scope?: KnowledgeScope;
  claim?: string;
  acting_task_id?: string;
  entry_id?: string;
  title?: string;
  new_title?: string;
  content?: string;
  content_mode?: 'replace' | 'prepend_section' | 'append_section';
  allow_shrink?: boolean;
  type?: string;
  status?: string;
  tags?: string[];
  domain?: string[];
  madr?: Record<string, unknown>;
  realization?: string;
  review_by?: string;
  provenance?: string;
}

// B-995: writes through knowledge_update_knowledge_entry (a partial COALESCE patch, same shape as
// today's conditional `updates` object) instead of a plain `.from('knowledge_decisions').update()`,
// so the write also lands a same-transaction 'rpc-typed' knowledge_events row carrying
// provenance/conduction/leg. The re-embed step stays a SEPARATE follow-up write (embedDecisionById,
// unchanged from before B-995): the RPC's own p_embedding param needs the MERGED post-update
// title/content, which isn't known until this RETURNING row comes back, so folding it into the same
// call would need an extra pre-read — not worth it for a best-effort refresh.
export async function updateKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  args: UpdateKnowledgeEntryArgs,
): Promise<KnowledgeEntryFull> {
  if (!args.entry_id && !args.title) {
    throw new Error('Either entry_id or title must be provided to identify the entry');
  }

  const mode = args.content_mode ?? 'replace';
  if (!['replace', 'prepend_section', 'append_section'].includes(mode)) {
    throw new Error('content_mode must be replace, prepend_section or append_section');
  }
  if (args.allow_shrink !== undefined && typeof args.allow_shrink !== 'boolean') {
    throw new Error('allow_shrink must be a boolean');
  }
  if (args.content === undefined && (args.content_mode !== undefined || args.allow_shrink !== undefined)) {
    throw new Error('content is required with content_mode or allow_shrink');
  }
  if (mode !== 'replace' && !args.content?.trim()) {
    throw new Error('Amendment section must not be blank');
  }

  const truthPatch = truthStatePatch(args);
  const hasTruthUpdates = Object.keys(truthPatch).length > 0;
  const hasUpdates =
    args.scope !== undefined ||
    args.claim !== undefined ||
    hasTruthUpdates ||
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

  let currentQuery = client.from('knowledge_decisions').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId);
  currentQuery = args.entry_id ? currentQuery.eq('id', args.entry_id) : currentQuery.eq('title', args.title!);
  const { data: current, error: readError } = await currentQuery.single();
  if (readError) throw readError;
  if (!current) throw new Error('Knowledge entry not found');
  if (mode !== 'replace') {
    if (args.claim !== undefined || /\*\*Claim(?: source)?:\*\*/.test(args.content!)) {
      throw new Error('Section amendments must contain only section text; change a claim using replace mode with an explicit claim.');
    }
    if (mode === 'prepend_section') {
      const capability = await client.rpc('knowledge_claim_amendment_capable');
      if (capability.error && !['PGRST202', '42883'].includes(capability.error.code)) throw new Error(capability.error.message);
      if (capability.error || capability.data !== true) {
        throw new Error('Prepending knowledge requires the B-1136 claim-preserving amendment migration. Use append_section or wait for database promotion; no content was changed.');
      }
    }
  }
  const content = mode !== 'replace' ? normalizeHtmlEntities(args.content!) : editedClaimContent(current, { title: args.new_title !== undefined ? normalizeHtmlEntities(args.new_title.trim()) : undefined, content: args.content !== undefined ? normalizeHtmlEntities(args.content) : undefined, claim: args.claim !== undefined ? normalizeHtmlEntities(args.claim) : undefined });
  const newTitle = args.new_title !== undefined ? normalizeHtmlEntities(args.new_title.trim()) : undefined;

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  // All content writes use the locked, guarded operation. Never fall back to an
  // older unsafe replacement writer when its migration is unavailable.
  const contentWrite = args.content !== undefined || args.claim !== undefined;
  const rpcArgs = {
    p_project_id: projectId,
    p_entry_id: args.entry_id ?? null,
    p_title: args.title ?? null,
    p_new_title: newTitle ?? null,
    p_content: contentWrite ? content : null,
    p_type: args.type ?? null,
    p_status: args.status !== undefined ? toBaseStatus(args.status) : null,
    p_tags: args.tags === undefined ? null : normalizeTags(args.tags),
    // Decision-axis columns recordDecision already writes but this path historically omitted
    // (B-468). Pass-through only (mirrors recordDecision — no strict validation; the DB CHECK/FK
    // constraints are the backstop). madr is a FULL-OBJECT replace, not a key-merge.
    p_domain: args.domain ?? null,
    p_madr: args.madr ?? null,
    p_realization: args.realization ?? null,
    p_review_by: args.review_by ?? null,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
    ...((contentWrite || hasTruthUpdates) ? { p_content_mode: mode, p_allow_shrink: args.allow_shrink ?? false } : {}),
    ...(hasTruthUpdates ? { p_truth_state: truthPatch, p_acting_task_id: args.acting_task_id ?? null } : {}),
  };
  // B-1141's scope-aware *_metadata wrappers and B-1229's truth RPC are separate families; one write
  // cannot carry both, so the combination is refused rather than silently dropping half of it.
  if (hasTruthUpdates && args.scope !== undefined) throw new Error('scope cannot be combined with a verification/rollout write in one update; send them as two updates. No fields were changed.');
  const { data, error } = hasTruthUpdates
    ? await client.rpc('knowledge_amend_entry_truth', rpcArgs)
    : await metadataRpc(client, contentWrite ? 'knowledge_amend_knowledge_entry' : 'knowledge_update_knowledge_entry', args.scope, rpcArgs);

  if (error) {
    if (hasTruthUpdates && ['PGRST202', '42883', '42703', 'PGRST204'].includes(error.code ?? '')) {
      throw new Error('Knowledge verification/rollout update unavailable: apply the B-1229 database migration first. No fields were changed.');
    }
    if (contentWrite && (error.code === 'PGRST202' || error.code === '42883')) {
      throw new Error('Knowledge content update unavailable: apply the B-1111 database migration before using content updates. No content was replaced.');
    }
    if (contentWrite && error.code === '22023') {
      throw new Error([error.message, error.hint].filter(Boolean).join('\n'));
    }
    if (error.code === '23505') {
      throw new Error(
        `A knowledge entry titled "${newTitle ?? ''}" already exists in this project`,
      );
    }
    throw new Error(error.message);
  }

  // Re-embed only when the embedded text (title\ncontent) actually changed. Nothing in
  // the DB maintains the embedding column on writes (architecture rule: every knowledge
  // writer self-embeds), so without this an edited row keeps a stale (or null) vector
  // and is invisible to knowledge_search_rrf. embedDecisionById writes the fresh vector
  // by id, using the merged title/content returned by the RPC's RETURNING row.
  const updated = data as unknown as KnowledgeEntryFull;
  if (args.new_title !== undefined || args.content !== undefined || args.claim !== undefined) {
    await embedDecisionById(client, workspaceId, projectId, updated.id, updated.title, updated.content);
  }
  return { ...updated, ...claimFields(updated) };
}

// ---------------------------------------------------------------------------
// Helper: findCrossKindCollision (B-977)
// ---------------------------------------------------------------------------
//
// Same-name-different-kind detection: `knowledge_entities` is unique on
// (workspace_id, kind, name), so two nodes named e.g. "Cloud library management" can
// legally coexist as kind='feature' and kind='concept' — usually an accidental
// duplicate (the same real thing re-minted under a second kind), not a deliberate
// design. This is a WARNING surface only — createEntity/resolveOrCreateEntity's job is
// still create-or-skip; collision is exceptional and worth flagging, never blocking.

export interface EntityCollisionWarning {
  entity_id: string;
  kind: string;
  message: string;
}

async function findCrossKindCollision(
  client: SupabaseClient,
  workspaceId: string,
  name: string,
  kind: string,
): Promise<{ id: string; kind: string } | null> {
  const { data, error } = await client
    .from('knowledge_entities')
    .select('id, kind')
    .eq('workspace_id', workspaceId)
    .eq('name', name)
    .neq('kind', kind)
    .limit(1)
    .maybeSingle();
  // Best-effort: a failed collision check never blocks the create it is only warning about.
  if (error || !data) return null;
  return data as { id: string; kind: string };
}

function collisionWarning(name: string, requestedKind: string, existing: { id: string; kind: string }): EntityCollisionWarning {
  return {
    entity_id: existing.id,
    kind: existing.kind,
    message:
      `An entity named "${name}" already exists under kind "${existing.kind}" (id ${existing.id}). ` +
      `This write created/resolved a SEPARATE node under kind "${requestedKind}" instead of merging. ` +
      `If this was unintended, use reconcile_entity to merge them.`,
  };
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
  // B-993: normalize-before-lookup, so a normalized-name row and a raw-name write of the "same"
  // entity resolve to one node instead of silently forking into two.
  const rawName = name;
  const normalizedName = normalizeHtmlEntities(rawName);
  const names=await readKnowledgeNames(client,projectId,{search:normalizedName});
  if(names.matches.length>1) throw new Error('Ambiguous concept name; use an explicit identity');
  if(names.matches.length===1) return names.matches[0].concept_id;


  const { data: existing, error: lookupErr } = await client
    .from('knowledge_entities')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('name', normalizedName)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);
  if (existing) return (existing as { id: string }).id;

  // B-993 repair-at-touch: the normalized name isn't found — check whether a legacy row still
  // carries the raw (un-normalized, mangled-entity) name from before this write-site normalized.
  // If so, RENAME it in place rather than minting a second node for the same real-world entity.
  if (normalizedName !== rawName) {
    const { data: legacy, error: legacyErr } = await client
      .from('knowledge_entities')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('kind', kind)
      .eq('name', rawName)
      .maybeSingle();
    if (legacyErr) throw new Error(legacyErr.message);
    if (legacy) {
      const { data: renamed, error: renameErr } = await client
        .from('knowledge_entities')
        .update({ name: normalizedName })
        .eq('workspace_id', workspaceId)
        .eq('id', (legacy as { id: string }).id)
        .select('id')
        .single();
      if (renameErr) throw new Error(renameErr.message);
      return (renamed as { id: string }).id;
    }
  }

  // B-977: same-name-different-kind collision is a WARNING, never a block. This helper's return
  // type (a plain string id) is relied on by many existing callers (recordDecision, assertFact,
  // …), so widening it would ripple through every call site for a signal only the exceptional
  // path needs. Surface it via a console side-channel instead — callers that want the structured
  // warning inline should author through createEntity, which returns it on the result.
  const collision = await findCrossKindCollision(client, workspaceId, normalizedName, kind);
  if (collision) {
    console.error(
      `[knowledge] entity collision: ${collisionWarning(normalizedName, kind, collision).message}`,
    );
  }

  const { data, error } = await client
    .from('knowledge_entities')
    .insert({ workspace_id: workspaceId, project_id: projectId, kind, name: normalizedName })
    .select('id')
    .single();
  if (error) throw new Error(error.message);
  return (data as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Handler: recordDecision
// ---------------------------------------------------------------------------

export interface RecordDecisionArgs {
  scope?: KnowledgeScope;
  claim_questions?: QuestionReference[];
  concept_ids?: string[];
  claim?: string;
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
  // B-645 elicitation claims: how the claim was grounded + the brief it underwrites. Omit both for
  // an ordinary (non-claim) decision.
  claim_provenance?: string;      // human-stated | agent-inferred-human-validated | force-quit
  underwriting_brief_id?: string; // FK briefs — resolve_brief disposes coupled claims on accept/defer
  // B-995: optional causation tag threaded to the knowledge_events row this write's RPC lands
  // alongside the governed write, in the SAME transaction. Omit for NULL.
  provenance?: string;
}

// B-645: the three claim-provenance grounds (mirrors the DB CHECK). force-quit claims are
// quarantined — they never promote at their own brief's accept and never feed inference until
// validated (elicitation-engine contract).
const CLAIM_PROVENANCES = ['human-stated', 'agent-inferred-human-validated', 'force-quit'];

// B-977: a technical/product/ux-ui design decision that reaches Accepted through the design gate
// is stamped realization='agreed' by default (decided-not-yet-built) — never left NULL, which
// elsewhere means "live" (a claim about something already shipped, which a fresh design decision
// is not). Every OTHER decision type keeps today's behavior: omit realization -> NULL, unchanged
// (NULL is relied on by the B-551 intent-emit trigger — out of scope to touch that default).
const DESIGN_DECISION_TYPES = new Set(['product-design', 'technical-design', 'ux-ui-design']);

// B-995: recordDecision now writes through knowledge_record_decision (governed insert + a
// same-transaction 'rpc-typed' knowledge_events row) instead of a plain `.from().insert()`. Every
// bit of pre-write logic the RPC does NOT itself do — affected_entity_names -> ids resolution
// (resolveOrCreateEntity, carrying B-993 normalize/repair-at-touch), embedding generation
// (embedText), HTML-entity normalization, the claim_provenance enum check, and the B-977
// design-decision realization default — stays computed here in TS and is passed as RPC params.
//
// DROPPED as part of this move: the old guarded retry that stripped claim_provenance/
// underwriting_brief_id on a "missing column" insert error (a DB predating the B-645 Phase-1
// claim columns). knowledge_record_decision's own INSERT statement is fixed at CREATE FUNCTION
// time and always references those columns — a DB missing them could never have had this RPC
// created against it in the first place, so the specific drift scenario the retry guarded against
// cannot occur once this RPC exists. A failure here now surfaces directly.
export async function recordDecision(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: RecordDecisionArgs,
): Promise<KnowledgeDecisionFull> {
  if (!args.title?.trim()) throw new Error('title is required');
  if (!args.type) throw new Error('type is required');
  if (args.claim_provenance !== undefined && !CLAIM_PROVENANCES.includes(args.claim_provenance)) {
    throw new Error(`claim_provenance must be one of: ${CLAIM_PROVENANCES.join(', ')}`);
  }

  const title = normalizeHtmlEntities(args.title.trim());
  const claimedContent = claimContent(title, normalizeHtmlEntities(args.content ?? ''), args.claim === undefined ? undefined : normalizeHtmlEntities(args.claim));
  const content = claimedContent;
  const workspaceId = await getWorkspaceId(client, projectId);

  const affectedIds: string[] = [];
  for (const name of args.affected_entity_names ?? []) {
    affectedIds.push(await resolveOrCreateEntity(client, workspaceId, projectId, name));
  }

  const embedding = await embedText(client, `${title}\n${content}`);

  let realization: string | undefined = args.realization;
  if (realization === undefined && DESIGN_DECISION_TYPES.has(args.type)) {
    realization = 'agreed';
  }

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const record = {
    p_project_id: projectId,
    p_title: title,
    p_type: args.type,
    p_content: content,
    p_status: args.status ?? 'Asserted',
    p_domain: args.domain ?? [],
    p_madr: args.madr ?? null,
    p_affected_entity_ids: affectedIds,
    p_source_type: args.source_type ?? 'manual',
    p_source_id: args.source_id ?? null,
    p_source_activity: args.source_activity ?? null,
    p_tags: normalizeTags(args.tags),
    p_source_task_id: args.source_task_id ?? null,
    p_review_by: args.review_by ?? null,
    p_realization: realization ?? null,
    p_claim_provenance: args.claim_provenance ?? null,
    p_underwriting_brief_id: args.underwriting_brief_id ?? null,
    p_embedding: embedding,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  };
  const explicitContext = args.claim_questions !== undefined || args.concept_ids !== undefined;
  if (explicitContext && !args.claim_provenance) throw new Error('Question/concept capture requires claim_provenance');
  const capability = explicitContext ? await readClaimContexts(client, []) : null;
  const { data, error } = capability?.available
    ? await client.rpc('record_claim_with_context', { p_record: { ...record, p_scope: args.scope ?? null }, p_questions: args.claim_questions ?? [], p_concept_ids: args.concept_ids ?? [] })
    : await metadataRpc(client, 'knowledge_record_decision', args.scope, record);
  if (error) {
    if (error.code === '23505') {
      throw new Error(`A decision titled "${args.title.trim()}" already exists in this project`);
    }
    throw new Error(error.message);
  }
  return { ...data, ...(explicitContext && !capability?.available ? { claim_context: { question_state: 'capability-unavailable', questions: [], concepts: [] } } : {}), ...claimFields(data) } as unknown as KnowledgeDecisionFull;
}

// ---------------------------------------------------------------------------
// Handler: supersedeDecision
// ---------------------------------------------------------------------------

export interface SupersedeDecisionArgs {
  scope?: KnowledgeScope;
  claim?: string;
  old_decision_id: string;
  // type+title are BOTH required for successor-mode, BOTH omitted for retire-mode (B-534).
  type?: string;
  title?: string;
  content?: string;
  madr?: Record<string, unknown>;
  domain?: string[];
  affected_entity_names?: string[];
  reason?: string;
  provenance?: string;
}

// B-995 judgment call (ticket B-995 point 1 / technical-design c60d1114): knowledge_supersede_decision
// does its OWN internal replacement insert in successor-mode, taking only p_affected_entity_ids (already-
// resolved uuids) — it does NOT call knowledge_record_decision internally, so the replacement it creates
// gets NO embedding. Chosen option (c): resolve affected_entity_names -> ids here in TS (same
// resolveOrCreateEntity call as before, preserving B-993 normalize/repair-at-touch), pass the ids to the
// RPC, and accept the "no embedding for the replacement" behavior change as the one piece of drift. This
// is the smallest change (one RPC call, single transaction) and matches the ticket's named intent; the
// alternative (keep calling recordDecision for the replacement, a plain update for the old decision) would
// forgo the RPC's atomicity for the sake of an embedding this decision doesn't otherwise need on its
// replacement path.
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

  const successorContent = hasTitle ? claimContent(normalizeHtmlEntities(args.title!.trim()), normalizeHtmlEntities(args.content ?? ''), args.claim === undefined ? undefined : normalizeHtmlEntities(args.claim)) : null;
  const workspaceId = await getWorkspaceId(client, projectId);

  // Preserve today's affected_entity_names -> ids resolution (B-993 normalize-before-lookup +
  // repair-at-touch) — the RPC's own successor insert takes only already-resolved uuids.
  const affectedIds: string[] = [];
  for (const name of args.affected_entity_names ?? []) {
    affectedIds.push(await resolveOrCreateEntity(client, workspaceId, projectId, name));
  }

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await metadataRpc(client, 'knowledge_supersede_decision', args.scope, {
    p_old_decision_id: args.old_decision_id,
    p_project_id: projectId,
    p_type: args.type ?? null,
    p_title: hasTitle ? normalizeHtmlEntities(args.title!.trim()) : null,
    p_content: successorContent,
    p_madr: args.madr ?? null,
    p_domain: args.domain ?? null,
    p_affected_entity_ids: args.affected_entity_names !== undefined ? affectedIds : null,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) throw new Error(error.message);

  const result = data as unknown as { superseded: KnowledgeDecisionFull; replacement: KnowledgeDecisionFull | null };
  return { superseded: result.superseded, replacement: result.replacement ?? null };
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
      scope: {type:'string',enum:['product','deployment'],description:'Required applicability for a new successor on a metadata-capable schema.'},
      claim: { type: 'string', description: 'One-sentence authored claim for a new replacement entry' },
      old_decision_id: { type: 'string', description: 'UUID of the decision being superseded' },
      type: { type: 'string', description: 'Type for the replacement decision. Omit BOTH type and title to retire the decision without a successor (retire-mode).' },
      title: { type: 'string', description: 'Title for the replacement decision. Omit BOTH type and title to retire the decision without a successor (retire-mode).' },
      content: { type: 'string', description: 'Optional markdown body for the replacement (successor-mode only)' },
      madr: { type: 'object', description: 'Structured MADR body for the replacement (successor-mode only)' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains for the replacement (successor-mode only)' },
      affected_entity_names: { type: 'array', items: { type: 'string' }, description: 'Entities the replacement touches (successor-mode only)' },
      reason: { type: 'string', description: 'Why the old decision is being superseded' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['old_decision_id'],
  },
};

export const recordDecisionTool = {
  name: 'record_decision',
  description:
    'Record a knowledge decision produced by a gate/skill. Type is an advisory authoring classification, not verified semantic content. Author ONE ATOMIC claim, not a document — shape the `content` as Decision · Why · How-to-apply · Scope. Pick the NARROWEST fitting `type` (product-design / technical-design / ux-ui-design for the design sub-tracks, or architecture / business / convention / specification / deferral) and multi-tag every `domain` a querying skill would filter on (engineering, operations, data, product, customer, process). Lifecycle: enters "Asserted" by default and a HUMAN promotes it to "Accepted" — never pre-mark a replacement Accepted before the decision is made. To retire an entry, SUPERSEDE it (do not edit it into irrelevance); for an in-part repair use update_knowledge_entry plus a dated banner. Migration window: supersede the old decision at decision-time, keep the old fact valid until cutover, and mark in-flight state with `realization`. Elicitation claims (B-645): a claim mined from an elicitation exchange sets `claim_provenance` + `underwriting_brief_id` so brief resolution disposes it mechanically (accept promotes human-grounded claims, defer archives; force-quit claims never promote at their own brief\'s accept).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      claim: { type: 'string', description: 'Authored one-sentence claim, at most 50 words; omission derives an unconfirmed proposal during rollout' },
      type: { type: 'string', description: 'Advisory authoring classification, not verified: product-design | technical-design | ux-ui-design | architecture | business | convention | specification | deferral' },
      title: { type: 'string', description: 'Decision title (unique within the project)' },
      content: { type: 'string', description: 'Optional human-readable markdown body' },
      madr: { type: 'object', description: 'Structured MADR body: { context, decision_drivers, considered_options, decision_outcome, consequences }' },
      domain: { type: 'array', items: { type: 'string' }, description: 'Domains: engineering, operations, data, product, customer, process' },
      affected_entity_names: { type: 'array', items: { type: 'string' }, description: 'Entity names this decision touches (resolved/created in knowledge_entities)' },
      status: { type: 'string', description: 'Override status (default "Asserted")' },
      realization: { type: 'string', enum: ['agreed', 'live', 'deprecating', 'retired'], description: 'Implementation/realization state (orthogonal to status). B-977: for type product-design/technical-design/ux-ui-design, omitting this defaults to "agreed" (decided-not-yet-built) rather than NULL — pass a value explicitly to override. For every other type, omit ⇒ NULL ≡ live, unchanged.' },
      source_type: { type: 'string', description: "ticket | adr | manual | inferred | research (default 'manual')" },
      source_id: { type: 'string', description: 'Pointer back to the producing ticket/source' },
      source_activity: { type: 'string', description: 'The gate/skill that authored it (e.g. design-decide, clarify)' },
      scope: { type: 'string', enum: ['product', 'deployment'], description: 'Product behaviour or this deployment operations. Required for new entries once metadata is available. Mixed claims must be separated.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      source_task_id: { type: 'string', description: 'Task that triggered this decision' },
      review_by: { type: 'string', description: 'ISO timestamp; freshness/decay date. Researched knowledge sets this ~90 days out so Drift-Risk/review_by resurfacing fires.' },
      claim_questions: { type: 'array', items: { type: 'object', properties: { exchange_id: {type:'string'}, round: {type:'integer'}, question_id: {type:'string'} }, required: ['exchange_id','round','question_id'] }, description: 'Explicit ordered source question references; exact text is copied by the server, never authored here.' },
      concept_ids: { type: 'array', items: {type:'string'}, description: 'Explicitly selected existing concept UUIDs only; never infer or create concepts from claim wording.' },
      claim_provenance: { type: 'string', enum: ['human-stated', 'agent-inferred-human-validated', 'force-quit'], description: "B-645: how an elicitation claim was grounded. 'force-quit' claims are quarantined — never promoted on their brief's accept, never grounds for inference until validated. Omit for a non-claim decision." },
      underwriting_brief_id: { type: 'string', description: 'B-645: the brief (UUID) this Asserted claim underwrites — resolve_brief disposes coupled claims on accept/defer; compose_brief prunes dropped claims on iterate. Omit for a non-claim decision.' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['type', 'title'],
  },
};

// ---------------------------------------------------------------------------
// Handler: queryEntities
// ---------------------------------------------------------------------------

interface ConceptNameResult { id: string; kind: 'concept'; title: string; concept_id: string; state: 'no-current-definition' | 'current-definition'; matched_alias: string | null }

export interface QueryEntitiesArgs { kind?: string; name?: string; }

export async function queryEntities(
  client: SupabaseClient,
  projectId: string,
  args: QueryEntitiesArgs,
): Promise<KnowledgeEntityFull[]> {
  const workspaceId = await getWorkspaceId(client, projectId);
  const names=await readKnowledgeNames(client,projectId,{search:args.name});
  let query = client.from(names.available ? 'knowledge_current_entities' : 'knowledge_entities').select(ENTITY_COLS).eq('workspace_id', workspaceId);
  if(names.matches.length>1 && args.name) throw new Error('Ambiguous concept name; use an explicit identity');
  if(names.matches.length===1 && args.name) query=query.eq('id',names.matches[0].concept_id);
  if (args.kind) query = query.eq('kind', args.kind);
  if (args.name && !names.matches.length) query = query.ilike('name', `%${args.name}%`);
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
// Handler: createEntity  (B-397 / folded B-399 — typed-entity authoring)
// ---------------------------------------------------------------------------
//
// Authors a TYPED entity node directly, over the columns knowledge_entities already
// carries (kind/name/description/metadata — no migration; ENTITY_COLS above). This is the
// deliberate, gated authoring path; resolveOrCreateEntity stays the name-only side-effect
// minter its callers (recordDecision/assertFact) rely on. Idempotent upsert on the existing
// uniqueness key (workspace_id, kind, name) — the B-397 A10 create-or-skip mechanism.

export interface CreateEntityArgs {
  kind: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
  provenance?: string;
}

export async function createEntity(
  client: SupabaseClient,
  projectId: string,
  args: CreateEntityArgs,
): Promise<KnowledgeEntityFull> {
  if (!args.kind?.trim()) throw new Error('kind is required');
  if (!args.name?.trim()) throw new Error('name is required');
  const kind = args.kind.trim();
  // B-993: normalize-before-lookup, so a normalized-name row and a raw-name write of the "same"
  // entity resolve to one node instead of silently forking into two.
  const rawName = args.name.trim();
  let name = normalizeHtmlEntities(rawName);
  const description = args.description !== undefined ? normalizeHtmlEntities(args.description) : undefined;

  const workspaceId = await getWorkspaceId(client, projectId);
  const names=await readKnowledgeNames(client,projectId,{search:name});
  if(names.matches.length>1) throw new Error('Ambiguous concept name; use an explicit identity');
  if(names.matches.length===1) name=names.matches[0].current_name;


  // Create-or-skip on (workspace_id, kind, name): a re-seed of the same node is a no-op, unless a
  // description/metadata is supplied — then those fields are refreshed on the existing row (upsert).
  const { data: existing, error: lookupErr } = await client
    .from('knowledge_entities')
    .select(ENTITY_COLS)
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('name', name)
    .maybeSingle();
  if (lookupErr) throw new Error(lookupErr.message);

  // B-993 repair-at-touch: the normalized name isn't found — check whether a legacy row still
  // carries the raw (un-normalized, mangled-entity) name from before this write-site normalized.
  // If so, treat it as the match and RENAME it in place as part of this write, rather than
  // minting a second node for the same real-world entity.
  let legacyMatch: Record<string, unknown> | null = null;
  if (!existing && name !== rawName) {
    const { data: legacy, error: legacyErr } = await client
      .from('knowledge_entities')
      .select(ENTITY_COLS)
      .eq('workspace_id', workspaceId)
      .eq('kind', kind)
      .eq('name', rawName)
      .maybeSingle();
    if (legacyErr) throw new Error(legacyErr.message);
    legacyMatch = legacy;
  }

  const matched = existing ?? legacyMatch;
  if (matched) {
    const patch: Record<string, unknown> = {};
    if (legacyMatch && !existing) patch.name = name;
    if (description !== undefined) patch.description = description;
    if (args.metadata !== undefined) patch.metadata = args.metadata;
    if (Object.keys(patch).length === 0) return matched as unknown as KnowledgeEntityFull;
    const { data: updated, error: updErr } = await client
      .from('knowledge_entities')
      .update(patch)
      .eq('workspace_id', workspaceId)
      .eq('id', (matched as { id: string }).id)
      .select(ENTITY_COLS)
      .single();
    if (updErr) throw new Error(updErr.message);
    return updated as unknown as KnowledgeEntityFull;
  }

  // B-977: check for a same-name-different-kind collision BEFORE authoring — a WARNING, never a
  // block. The lookup above already ruled out the same-kind case (that's the idempotent
  // create-or-skip path above); this is the sibling check for a DIFFERENT kind under the same name.
  const collision = await findCrossKindCollision(client, workspaceId, name, kind);

  // B-995: the genuinely-new-insert branch now writes through knowledge_create_entity (governed
  // create-or-skip + a same-transaction 'rpc-typed' knowledge_events row on an actual insert) instead
  // of a plain `.from().insert()`. This also DROPS the old client-side 23505-race-then-reread
  // handling: the RPC's own `ON CONFLICT (workspace_id, kind, name) DO NOTHING` + re-select already
  // resolves a racing create atomically inside the one transaction, so there is nothing left for a
  // client-side retry to do.
  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await client.rpc('knowledge_create_entity', {
    p_project_id: projectId,
    p_kind: kind,
    p_name: name,
    p_description: description ?? null,
    p_metadata: args.metadata ?? null,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) throw new Error(error.message);
  const created = data as unknown as KnowledgeEntityFull;
  return collision ? { ...created, collision_warning: collisionWarning(name, kind, collision) } : created;
}

export const createEntityTool = {
  name: 'create_entity',
  description:
    'Author a TYPED knowledge entity node (kind + name; optional description + metadata) directly in the graph. ' +
    'Idempotent upsert on the uniqueness key (workspace, kind, name): re-authoring the same node is a no-op, or ' +
    'refreshes the description/metadata when supplied. A node description is a THIN, stable, one-line canonical ' +
    'identifier — the substance and lifecycle (Asserted→Accepted, realization) live in the decisions/facts ABOUT ' +
    "the entity, not on the node. Kinds are open-ended (e.g. 'persona', 'feature', 'component', 'integration', " +
    "'concept'). To merge a low-typed stub into a richer node of the same name, use reconcile_entity. " +
    'B-977: creating a name that already exists under a DIFFERENT kind is never blocked — it proceeds and the ' +
    'result carries a non-fatal `collision_warning` ({entity_id, kind, message}) pointing at the existing node; ' +
    'use reconcile_entity to merge if the duplicate was unintended.',

  inputSchema: {
    type: 'object' as const,
    properties: {
      kind: { type: 'string', description: "Entity kind — open-ended (e.g. 'persona', 'feature', 'component', 'integration', 'concept')" },
      name: { type: 'string', description: 'Entity name (unique within the workspace per kind)' },
      description: { type: 'string', description: 'A THIN one-line canonical identifier — not a document; depth belongs in the claims about the entity' },
      metadata: { type: 'object', description: 'Optional structured metadata (JSON object)' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['kind', 'name'],
  },
};

// ---------------------------------------------------------------------------
// Handler: updateEntity  (B-397 / folded B-399)
// ---------------------------------------------------------------------------

export interface UpdateEntityArgs {
  entity_id?: string;
  kind?: string;   // with `name`, identifies the entity when entity_id is absent
  name?: string;
  new_kind?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  provenance?: string;
}

export async function updateEntity(
  client: SupabaseClient,
  projectId: string,
  args: UpdateEntityArgs,
): Promise<KnowledgeEntityFull> {
  if (!args.entity_id && !(args.kind && args.name)) {
    throw new Error('Provide entity_id, or both kind and name, to identify the entity');
  }
  const hasUpdates =
    args.new_kind !== undefined || args.description !== undefined || args.metadata !== undefined;
  if (!hasUpdates) {
    throw new Error('At least one of new_kind, description, or metadata must be provided');
  }

  const description = args.description !== undefined ? normalizeHtmlEntities(args.description) : undefined;

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const names=await readKnowledgeNames(client,projectId,{search:args.name,entity_ids:args.entity_id?[args.entity_id]:[]});
  if(names.matches.length>1 && !args.entity_id) throw new Error('Ambiguous concept name; use an explicit identity');
  const resolved=names.identities[0]?.concept_id ?? names.matches[0]?.concept_id;
  if(resolved) args={...args,entity_id:resolved};
  const { data, error } = await client.rpc('knowledge_update_entity', {
    p_project_id: projectId,
    p_entity_id: args.entity_id ?? null,
    p_kind: args.kind ?? null,
    p_name: args.name ?? null,
    p_new_kind: args.new_kind ?? null,
    p_description: description ?? null,
    p_metadata: args.metadata ?? null,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) {
    if (error.code === '23505') {
      // Changing kind collided with an existing (workspace, new_kind, name) node — that is the MERGE
      // case, which repoints references. Route the caller there rather than silently failing.
      throw new Error(
        `An entity named "${args.name ?? ''}" already exists under kind "${args.new_kind}". ` +
        `Use reconcile_entity to MERGE the two nodes (it repoints all references), not update_entity.`,
      );
    }
    throw new Error(error.message);
  }
  return data as unknown as KnowledgeEntityFull;
}

export const updateEntityTool = {
  name: 'update_entity',
  description:
    "Update a typed knowledge entity's description, metadata, or kind. Identify it by entity_id, or by its " +
    'current (kind, name). Changing kind to a value already taken by a same-named node is rejected with a ' +
    'pointer to reconcile_entity (the MERGE path that repoints references) — update_entity never silently ' +
    'orphans or duplicates.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entity_id: { type: 'string', description: 'Entity UUID (preferred identifier)' },
      kind: { type: 'string', description: 'Current kind (with name) — identifies the entity when entity_id is omitted' },
      name: { type: 'string', description: 'Current name (with kind) — identifies the entity when entity_id is omitted' },
      new_kind: { type: 'string', description: 'New kind. For a stub→typed promotion that may collide, prefer reconcile_entity.' },
      description: { type: 'string', description: 'New thin one-line canonical description' },
      metadata: { type: 'object', description: 'New structured metadata (full-object replace)' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
  },
};

// ---------------------------------------------------------------------------
// Handler: reconcileEntity  (B-397 / folded B-399 — the core: stub → typed node)
// ---------------------------------------------------------------------------
//
// Two sub-cases, chosen automatically (technical-design 826c5088 point 7):
//   (a) UPGRADE-IN-PLACE — the stub (default kind 'concept') has NO same-named node under to_kind:
//       flip kind/description on the same row; no reference repointing.
//   (b) MERGE — a same-named to_kind node ALREADY exists: repoint EVERY referencing row
//       (knowledge_facts.subject_entity_id, knowledge_decisions.affected_entity_ids[],
//       knowledge_events.entity_id) to the typed node, dedup arrays (the conflict case), then DELETE
//       the stub. Merge referential integrity is the load-bearing behaviour B-399 exists for.

export interface ReconcileEntityArgs {
  name: string;
  to_kind: string;
  from_kind?: string;    // the stub's kind; defaults to 'concept'
  description?: string;  // optional refreshed description (upgrade-in-place only)
  provenance?: string;
}

export interface ReconcileEntityResult {
  mode: 'upgrade-in-place' | 'merge';
  entity: KnowledgeEntityFull;
  merged_stub_id?: string;
  repointed?: { facts: number; decisions: number; events: number };
}

// B-995: reconcileEntity is now a THIN WRAPPER around knowledge_reconcile_entity. Per the migration's
// own note, this RPC is a genuine atomicity improvement, not just a typed-event wrapper — it carries
// the WHOLE merge (repoint facts/decisions/events, delete the stub) in ONE transaction and RE-CHECKS
// its own preconditions (the stub resolves to exactly one row; if a same-name to_kind node exists, it
// too resolves to exactly one row) INSIDE the function, RAISEing on violation, rather than trusting
// ids resolved by an earlier, separate client round-trip the way the old multi-request TS flow did.
// The RPC's jsonb return shape ({mode, entity, merged_stub_id, repointed}) already matches
// ReconcileEntityResult, so this is a direct pass-through plus one error-message translation to keep
// the long-standing "No <kind> entity named ... to reconcile" message callers/tests depend on.
export async function reconcileEntity(
  client: SupabaseClient,
  projectId: string,
  args: ReconcileEntityArgs,
): Promise<ReconcileEntityResult> {
  if (!args.name?.trim()) throw new Error('name is required');
  if (!args.to_kind?.trim()) throw new Error('to_kind is required');
  const name = args.name.trim();
  const toKind = args.to_kind.trim();
  const fromKind = (args.from_kind ?? 'concept').trim();
  if (fromKind === toKind) throw new Error('from_kind and to_kind must differ (nothing to reconcile)');

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await client.rpc('knowledge_reconcile_entity', {
    p_project_id: projectId,
    p_name: name,
    p_to_kind: toKind,
    p_from_kind: fromKind,
    p_description: args.description ?? null,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) {
    // The RPC's "expected exactly one ... found 0" precondition failure is this handler's long-
    // standing "no stub to reconcile" case — translate it back to the message callers/tests expect.
    if (/entity named/.test(error.message) && /found 0/.test(error.message)) {
      throw new Error(`No ${fromKind} entity named "${name}" to reconcile`);
    }
    throw new Error(error.message);
  }
  return data as unknown as ReconcileEntityResult;
}

export const reconcileEntityTool = {
  name: 'reconcile_entity',
  description:
    "Reconcile a low-typed entity stub (default kind 'concept') into a richer typed node of the same name — " +
    'the folded B-399 capability. Two modes, chosen automatically: (a) UPGRADE-IN-PLACE when NO same-named node ' +
    'exists under to_kind — the stub row is retyped in place (kind/description), no references move; ' +
    '(b) MERGE when a same-named to_kind node ALREADY exists — every referencing row ' +
    '(facts.subject_entity_id, decisions.affected_entity_ids, events.entity_id) is repointed to the typed node ' +
    '(deduping arrays), then the stub is deleted. Prevents two nodes for the same real thing.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'The shared entity name to reconcile' },
      to_kind: { type: 'string', description: 'The richer target kind (e.g. component, feature, persona)' },
      from_kind: { type: 'string', description: "The stub's kind. Default 'concept'." },
      description: { type: 'string', description: 'Optional refreshed one-line description (applied on upgrade-in-place)' },
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['name', 'to_kind'],
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
  provenance?: string;
}

// B-995: writes through knowledge_assert_fact (governed insert + a same-transaction 'rpc-typed'
// knowledge_events row) instead of a plain `.from().insert()`. The RPC resolves-or-creates the
// subject entity ITSELF, but with a plain lookup-or-insert on the raw name (no B-993 normalize-
// before-lookup or legacy-rename-repair-at-touch) — so resolveOrCreateEntity still runs here FIRST,
// exactly as before, to preserve that normalization. The (now-normalized) name is what's then passed
// to the RPC, so its own internal resolution finds the very row resolveOrCreateEntity just settled on
// rather than risking a second, differently-named entity.
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
  const subjectNames=await readKnowledgeNames(client,projectId,{search:args.subject_entity});
  if(subjectNames.matches.length>1) throw new Error('Ambiguous subject name; use an explicit identity');
  const subjectKind = subjectNames.matches[0]?.kind ?? args.subject_entity_kind ?? 'concept';
  await resolveOrCreateEntity(client, workspaceId, projectId, args.subject_entity, subjectKind);
  const subjectName = subjectNames.matches[0]?.current_name ?? normalizeHtmlEntities(args.subject_entity);

  const embedding = await embedText(client, `${args.subject_entity} ${args.predicate} ${JSON.stringify(args.object)}`);

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await client.rpc('knowledge_assert_fact', {
    p_project_id: projectId,
    p_subject_entity: subjectName,
    p_predicate: args.predicate,
    p_object: args.object,
    p_source_type: args.source_type,
    p_subject_entity_kind: subjectKind,
    p_source_id: args.source_id ?? null,
    p_confidence: args.confidence ?? 1.0,
    p_domain: args.domain ?? [],
    p_review_by: args.review_by ?? null,
    p_embedding: embedding,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) throw new Error(error.message);
  return data as unknown as KnowledgeFactFull;
}

export const assertFactTool = {
  name: 'assert_fact',
  description:
    'Assert ONE ATOMIC fact about an entity (subject-predicate-object) with provenance — a single claim, not a bundle. Use a precise `predicate` and multi-tag every `domain` a querying skill would filter on. Facts enter "Asserted"; a human promotes before agents act on them autonomously (research-sourced facts especially). Do not edit a fact into irrelevance — invalidate it; during a migration window keep the old fact valid until cutover (bi-temporal).',
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
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
    },
    required: ['subject_entity', 'predicate', 'object', 'source_type'],
  },
};

// ---------------------------------------------------------------------------
// Handler: invalidateFact
// ---------------------------------------------------------------------------

export interface InvalidateFactArgs { fact_id: string; reason?: string; provenance?: string; }

export async function invalidateFact(
  client: SupabaseClient,
  projectId: string,
  args: InvalidateFactArgs,
): Promise<KnowledgeFactFull> {
  if (!args.fact_id) throw new Error('fact_id is required');
  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await client.rpc('knowledge_invalidate_fact', {
    p_fact_id: args.fact_id,
    p_project_id: projectId,
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) throw new Error(error.message);
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
      provenance: { type: 'string', description: 'Optional caller-supplied provenance tag for the knowledge_events causation trail (e.g. "human-in-session", "agent-synthesized:<mode>", or "agent-on-behalf:human-in-session"/"agent-on-behalf:human-in-browser"/"agent-on-behalf:human-recorded" when an agent writes on a human\'s already-made decision). Omit for NULL — the reader\'s rule then falls back to conduction-only or untracked classification. B-1021 (widened B-1062): bare "human-in-browser" is REJECTED — that value is the web client\'s alone, and "agent-on-behalf:" accepts only the three closed suffixes above.' },
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
    const names=await readKnowledgeNames(client,projectId,{search:args.entity});
    if(names.matches.length>1) throw new Error('Ambiguous concept name; use an explicit identity');
    const { data: ents, error: entErr } = names.matches.length
      ? { data:names.matches.map(m=>({id:m.concept_id})),error:null }
      : await client.from(names.available?'knowledge_current_entities':'knowledge_entities').select('id').eq('workspace_id',workspaceId).ilike('name',args.entity);
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
  scope?: KnowledgeScope;
  new_claim?: string;
  entry_id?: string;
  title?: string;
  new_title: string;
  new_content: string;
  type?: string;
  tags?: string[];
  provenance?: string;
}

// B-995: writes through knowledge_supersede_knowledge_entry (governed replacement-insert +
// mark-superseded update, in ONE transaction, plus an explicit 'rpc-typed' knowledge_events row)
// instead of today's three-step TS flow (getKnowledgeEntry fetch -> createKnowledgeEntry base-table
// insert -> a plain base-table update). The RPC does its own existing-
// entry lookup and type/tags/source_task_id carry-over internally (COALESCE against the row it finds
// by p_entry_id/p_title), so the pre-fetch is no longer needed. One thing the RPC does NOT do: embed
// the replacement (no p_embedding param) — mirrors createKnowledgeEntry's post-insert self-embed
// (B-401) as a best-effort follow-up write, exactly as this path already embedded before B-995.
export async function supersedeKnowledgeEntry(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: SupersedeKnowledgeEntryArgs,
): Promise<{ superseded: KnowledgeEntryFull; replacement: KnowledgeEntryFull }> {
  if (!args.entry_id && !args.title) {
    throw new Error('Either entry_id or title must be provided to identify the entry to supersede');
  }

  const content = claimContent(normalizeHtmlEntities(args.new_title), normalizeHtmlEntities(args.new_content), args.new_claim === undefined ? undefined : normalizeHtmlEntities(args.new_claim));
  const workspaceId = await getWorkspaceId(client, projectId);

  // B-1021: fence out human-in-browser / validate agent-on-behalf:* before the write.
  guardKnowledgeWriteProvenance(args.provenance);
  const { data, error } = await metadataRpc(client, 'knowledge_supersede_knowledge_entry', args.scope, {
    p_project_id: projectId,
    p_new_title: normalizeHtmlEntities(args.new_title),
    p_new_content: content,
    p_entry_id: args.entry_id ?? null,
    p_title: args.title ?? null,
    p_type: args.type ?? null,
    p_tags: args.tags === undefined ? null : normalizeTags(args.tags),
    p_provenance: args.provenance ?? null,
    p_conduction_id: getConductionId() ?? null,
    p_leg: getLeg() ?? null,
  });
  if (error) throw new Error(error.message);

  const result = data as unknown as { superseded: KnowledgeEntryFull; replacement: KnowledgeEntryFull };
  await embedDecisionById(
    client, workspaceId, projectId, result.replacement.id, result.replacement.title, result.replacement.content,
  );
  return result;
}

/** Explicit maintenance action; never runs as a side effect of a read. */
export async function proposeLegacyClaims(client: SupabaseClient, projectId: string, apply = false) {
  const workspaceId = await getWorkspaceId(client, projectId);
  const { data, error } = await client.from('knowledge_decisions').select('*').eq('workspace_id', workspaceId).eq('project_id', projectId).neq('type', 'intent');
  if (error) throw error;
  const results = [];
  for (const row of data ?? []) {
    if (claimFields(row).claim) { results.push({ id: row.id, status: 'skipped-existing' }); continue; }
    const claim = proposeClaim(row.content ?? '');
    if (!claim) { results.push({ id: row.id, status: 'no-usable-sentence' }); continue; }
    if (apply) {
      const { data: written, error: writeError } = await client.from('knowledge_decisions')
        .update({ content: encodeClaim(row.content ?? '', claim, 'derived') })
        .eq('id', row.id).eq('workspace_id', workspaceId).eq('project_id', projectId)
        .eq('content', row.content ?? '').select('id');
      if (writeError) throw writeError;
      if (!written?.length) { results.push({ id: row.id, status: 'skipped-changed' }); continue; }
    }
    results.push({ id: row.id, claim, claim_source: 'derived', status: apply ? 'applied' : 'proposed' });
  }
  return results;
}
