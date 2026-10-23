import type { ClaimContext } from './claim-context.js';
import { proseLink, type ProseRead, type ProsePointer } from './knowledge-prose.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeEntrySummary, QueryKnowledgeArgs } from './knowledge.js';
import { claimFields, matchedPassage } from './knowledge-claim.js';
import type { InvalidationRead } from './knowledge-invalidations.js';
import type { NameRead } from './knowledge-names.js';
import type { Definition } from './knowledge-definitions.js';
import { isBookkeeping } from './knowledge-bookkeeping.js';

export const SEARCH_BUDGET_MS = 6000;
export const SCORE_CUTOFF = 0.0125;
export const RRF_K = 60;
export const normalizeTags = (tags: readonly string[] = []): string[] =>
  [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
export interface SearchMatch extends KnowledgeEntrySummary { source_kind: string; score: number; replaced?: boolean; provenance?:ProsePointer; authority?:'unratified'|'source-generated'; source_link?:string; source?:unknown; repository?:string; surface?:string; inventory_key?:string; inventory_revision?:string }
export interface SearchRoute { route: string; outcome: string; reason?: string }
export interface KnowledgeSearchResult {
  prose_coverage?: ProseRead | { available:false };
  source_applicability?: string;
  concepts: Array<{id:string;kind:'concept';title:string;concept_id:string;state:'no-current-definition';matched_alias:string|null}>;
  definitions: Definition[];
  refinements: KnowledgeEntrySummary[];
  definitions_available: boolean;
  matches: SearchMatch[];
  unscored_matches: KnowledgeEntrySummary[];
  incomplete: boolean;
  truncated: boolean;
  capability: 'scored' | 'scores-unavailable' | 'unavailable';
  reason?: string;
  normalized_query: string;
  normalized_filters: { type: string | null; status: string; domain: string[]; tags: string[]; include_bookkeeping: boolean; scope: string | null; question_state: string | null; question_scope: string | null };
  routes_tried: SearchRoute[];
  score_cutoff: number;
  below_cutoff_count: number | null;
  count_coverage: 'considered-scored-union' | 'partial-scored-union' | 'unavailable';
  candidate_limits: { per_class_per_signal: number; max_scored_union: number };
  tag_suggestions: string[];
  elapsed_ms: number;
  /** B-371: the page this answer is — offset applied after fusion; total_matches counts every match above the cut-off. */
  page?: { offset: number; returned: number; total_matches: number };
}
interface Candidate extends KnowledgeEntrySummary { source_kind: string; content?: string; bookkeeping?: boolean; source_activity?: string; madr?: unknown; superseded_by?: string | null; semantic_distance?: number | null }
interface SignalRow { candidate: Candidate | null; signal_rank: number; overflow: boolean; unavailable_sources?: string[] | null }
const authError = (e: any): boolean => ['401', '403', '42501', 'PGRST301', 'PGRST302', 'PGRST303'].some(v => [e?.code, e?.status, e?.context?.status].map(String).includes(v));
const missing = (e: any): boolean => ['PGRST202', '42883'].includes(e?.code);
const summary = (d: Candidate, query: string): KnowledgeEntrySummary => ({
  ...sourceFields(d),
  id: d.id, title: d.title, type: d.type, status: d.status, domain: d.domain ?? [], tags: d.tags ?? [],
  ...(d.scope !== undefined ? { scope: d.scope } : {}),
  project_id: d.project_id, updated_at: d.updated_at, verified_against: d.verified_against ?? null, rollout_state: d.rollout_state ?? null, open_steps: d.open_steps ?? null, ...questionFields(d), ...claimFields(d), snippet: matchedPassage(d.content ?? '', query),
});

function sourceFields(d: Candidate): Record<string,unknown> {
 const row=d as Candidate & {provenance?:ProsePointer;authority?:string;source?:unknown;repository?:string;surface?:string;inventory_key?:string;inventory_revision?:string};
 return row.source_kind==='document'||row.source_kind==='skill' ? {provenance:row.provenance,authority:'unratified',source_link:row.provenance?proseLink(row.provenance):undefined} : row.source_kind==='source-value'?{authority:'source-generated',source:row.source,repository:row.repository,surface:row.surface,inventory_key:row.inventory_key,inventory_revision:row.inventory_revision}:{};
}

// Validate metadata on both sides of the transport boundary. No title/type inference.
function questionFields(d: Candidate): Partial<KnowledgeEntrySummary> {
  const q = (d.madr as { question?: { version?: unknown; state?: string; scope?: string } } | null)?.question;
  if (d.source_activity !== 'knowledge-question' || q?.version !== 1 || !['open','parked','decided'].includes(q.state ?? '') || !['product','deployment'].includes(q.scope ?? '')) return {};
  return { question_state: q.state as 'open' | 'parked' | 'decided', question_scope: q.scope as 'product' | 'deployment',
    answer: q.state === 'decided' ? 'decided; see resulting decision' : 'not yet decided',
    resulting_decision_id: q.state === 'decided' ? d.superseded_by ?? null : null };
}
function priority(d: Candidate): boolean {
  const q = questionFields(d);
  return (q.question_state === 'open' || q.question_state === 'parked') && typeof d.semantic_distance === 'number' && d.semantic_distance <= 0.35;
}

/** One owner from handler entry, including scope lookup. Every awaited network operation is raced;
 * cancellation is best effort, so a transport ignoring AbortSignal cannot extend the response. */
export async function searchKnowledge(client: SupabaseClient, projectId: string, args: QueryKnowledgeArgs, started = performance.now()): Promise<KnowledgeSearchResult> {
  const end = started + SEARCH_BUDGET_MS - 100;
  const controller = new AbortController();
  const routes: SearchRoute[] = [];
  let auth: unknown;
  let sealed = false;
  let incomplete = false;
  const result: KnowledgeSearchResult = {
    concepts: [], definitions: [], refinements: [], definitions_available: false, matches: [], unscored_matches: [], incomplete: false, truncated: false, capability: 'unavailable',
    normalized_query: args.search!.trim().replace(/\s+/g, ' '),
    normalized_filters: { type: args.type ?? null, status: args.status ?? 'Accepted', domain: args.domain ?? [], tags: normalizeTags(args.tags), include_bookkeeping: args.include_bookkeeping !== false, scope: args.scope ?? null, question_state: args.question_state ?? null, question_scope: args.question_scope ?? null },
    routes_tried: routes, score_cutoff: SCORE_CUTOFF, below_cutoff_count: null, count_coverage: 'unavailable',
    candidate_limits: { per_class_per_signal: 200, max_scored_union: 800 }, tag_suggestions: [], elapsed_ms: 0,
  };
  const limit = args.limit ?? 50;
  if (args.scope && !['product','deployment'].includes(args.scope) || args.question_scope && !['product','deployment'].includes(args.question_scope) || args.question_state && !['open','parked','decided'].includes(args.question_state)) throw new Error('Invalid scope or question state');
  const offset = args.offset ?? 0;
  const includeDefinitions = !args.type && !args.status && !args.tags?.length && !args.as_of && !args.include_superseded && offset === 0 && args.scope !== 'deployment' && !args.question_scope && !args.question_state;
  if (args.definitions_only && !includeDefinitions) throw new Error('definitions_only supports search, domain and limit; decision filters are not definition filters');
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Knowledge limit must be a non-negative integer');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Knowledge offset must be a non-negative integer');
  if (args.as_of !== undefined && !(typeof args.as_of === 'string' && /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(args.as_of) && !Number.isNaN(Date.parse(args.as_of)))) throw new Error('as_of must be an ISO 8601 timestamp, for example 2026-01-15T00:00:00Z');
  // as_of and include_superseded read past or replaced entries; prose and generated sources have no history.
  const historical = Boolean(args.as_of || args.include_superseded);
  const finish = () => {
    sealed = true;
    controller.abort();
    if (auth) throw auth;
    result.incomplete = result.truncated = incomplete;
    result.elapsed_ms = Math.round(performance.now() - started);
    return result;
  };
  const bounded = async <T>(route: string, operation: (signal: AbortSignal) => PromiseLike<{ data: T | null; error?: any; status?: number }>, budget = end - performance.now()): Promise<T | undefined> => {
    // Requests also receive the absolute controller below; the timeout race handles ignored aborts.
    const routeController = new AbortController();
    const requestSignal = AbortSignal.any([controller.signal, routeController.signal]);
    let timer: ReturnType<typeof setTimeout>;
    const ms = Math.max(0, Math.min(budget, end - performance.now()));
    if (ms <= 0) {
      incomplete = true;
      routes.push({ route, outcome: 'timeout', reason: 'deadline' });
      return undefined;
    }
    const timeout = new Promise<undefined>(resolve => { timer = setTimeout(() => { routeController.abort(); resolve(undefined); }, ms); });
    try {
      const response = await Promise.race([Promise.resolve().then(() => operation(requestSignal)), timeout]);
      if (sealed) return undefined;
      if (!response) { incomplete = true; routes.push({ route, outcome: 'timeout', reason: 'deadline' }); return undefined; }
      if (response.error) {
        if (authError(response.error) || authError({status:response.status})) auth = response.error;
        incomplete = true;
        routes.push({ route, outcome: missing(response.error) ? 'unsupported' : 'failed', reason: missing(response.error) ? 'missing-capability' : 'request-failed' });
        return undefined;
      }
      routes.push({ route, outcome: 'completed' });
      return response.data ?? undefined;
    } catch (e) {
      if (!sealed) { if (authError(e)) auth = e; incomplete = true; routes.push({ route, outcome: 'failed', reason: 'request-failed' }); }
      return undefined;
    } finally { clearTimeout(timer!); }
  };
  const prose = bounded<ProseRead>('prose-coverage', signal => client.rpc('read_knowledge_prose',{p_project_id:projectId,p_entry_ids:[]}).abortSignal(signal),250);
  const scope = await bounded<{ workspace_id: string }>('scope', signal => client.from('projects').select('workspace_id').eq('id', projectId).abortSignal(signal).single());
  if (!scope) { incomplete = true; return finish(); }
  const coverage=await prose;
  const proseAvailable=coverage?.available===true&&Array.isArray(coverage.sources)&&Array.isArray(coverage.pointers);
  result.prose_coverage=proseAvailable ? coverage : {available:false};
  if(!proseAvailable){incomplete=true;if(coverage)routes.push({route:'prose-coverage',outcome:'failed',reason:'invalid-capability-response'});}
  if(coverage?.sources?.some(s=>s.enabled&&s.refresh_state!=='current')){incomplete=true;routes.push({route:'prose-coverage',outcome:'stale',reason:'refresh-incomplete'});}
  result.source_applicability=args.status||args.type?'Explicit decision status/type filters exclude prose and generated sources.':'Accepted entries plus configured source-backed prose and current Asserted generated values.';
  const filters = result.normalized_filters;
  // Definitions are a separate result class, never assigned fabricated RRF scores.
  const definitions = includeDefinitions && limit > 0 ? (async () => {
    const data = await bounded<{ available: boolean; definitions: Definition[] }>('definitions', signal => client.rpc('read_knowledge_definitions', {
      p_workspace_id: scope.workspace_id, p_project_id: projectId, p_search: result.normalized_query,
      p_domain: args.domain?.length ? args.domain : null, p_limit: Math.min(limit, 500), p_offset: 0,
    }).abortSignal(signal));
    result.definitions_available = data?.available === true && Array.isArray(data.definitions);
    result.definitions = result.definitions_available ? data!.definitions.slice(0, limit) : [];
    if (data && !result.definitions_available) { incomplete = true; routes.push({route:'definitions', outcome:'failed', reason:'invalid-capability-response'}); }
    const ids = [...new Set(result.definitions.flatMap(d => d.refinements.map(r => r.id)))].slice(0, Math.max(0, limit - result.definitions.length));
    if (!args.definitions_only && ids.length) {
      const rows = await bounded<Candidate[]>('definition-refinements', signal => {
        let query = client.from('knowledge_decisions').select('*').eq('workspace_id', scope.workspace_id).eq('project_id', projectId).eq('status','Accepted').in('id',ids);
        if (args.domain?.length) query = query.overlaps('domain',args.domain);
        if (!filters.include_bookkeeping) query = query.or('tags.is.null,tags.not.cs.{harmony:bookkeeping}');
        return query.order('id').limit(ids.length).abortSignal(signal);
      });
      result.refinements = (rows ?? []).map(d => summary(d, result.normalized_query));
    }
  })() : Promise.resolve();
  const names = includeDefinitions && !args.definitions_only && limit > 0 ? (async () => {
    const read = await bounded<NameRead>('concept-names', signal => client.rpc('read_knowledge_names', {
      p_project_id: projectId, p_search: result.normalized_query, p_entry_ids: [], p_entity_ids: [],
    }).abortSignal(signal));
    result.concepts = (read?.matches ?? []).filter(m => m.state === 'no-current-definition')
      .map(m => ({id:m.concept_id,kind:'concept' as const,title:m.current_name,concept_id:m.concept_id,state:'no-current-definition' as const,matched_alias:m.matched_alias}));
  })() : Promise.resolve();
  if (args.definitions_only) { await definitions; return finish(); }
  let absent = false;
  let scoredCompleted = false;
  const candidates = new Map<string, { candidate: Candidate; score: number }>();
  const signal = async (name: 'lexical' | 'semantic', embedding: string | null) => {
    const rows = await bounded<SignalRow[]>(name, async signal => {
      const response = await client.rpc('knowledge_search_scored', {
        _workspace_id: scope.workspace_id, _project_id: projectId, _query_text: result.normalized_query,
        _query_embedding: embedding, _signal: name, _type: filters.type, _status: args.status ?? (proseAvailable && !historical ? null : historical ? null : filters.status),
        ...(args.as_of ? { _as_of: new Date(args.as_of).toISOString() } : {}), ...(historical ? { _include_superseded: true } : {}),
        _domain: filters.domain.length ? filters.domain : null, _tags: filters.tags.length ? filters.tags : null,
        _include_bookkeeping: filters.include_bookkeeping,
        _scope: filters.scope, _question_state: filters.question_state, _question_scope: filters.question_scope,
      }).abortSignal(signal);

      return response;
    });
    if (!rows || sealed) {
      if (!sealed && name === 'lexical' && routes.some(r => r.route === name && r.reason === 'missing-capability')) absent = true;
      return;
    }
    scoredCompleted = true;
    for (const row of rows) {
      if (row.unavailable_sources?.length) {
        incomplete = true;
        routes.push({ route: name, outcome: 'unavailable', reason: `sources-without-embedding:${row.unavailable_sources.join(',')}` });
        continue;
      }
      if (row.overflow) { incomplete = true; routes.push({ route: name, outcome: 'capped', reason: 'candidate-ceiling' }); continue; }
      if (!row.candidate || !Number.isSafeInteger(Number(row.signal_rank)) || Number(row.signal_rank) < 1) continue;
      const key = `${row.candidate.source_kind}:${row.candidate.id}`;
      const prior = candidates.get(key);
      // Lexical completion must not erase semantic distance observed by the other route.
      const candidate = { ...row.candidate, semantic_distance: name === 'semantic' ? row.candidate.semantic_distance : prior?.candidate.semantic_distance ?? null };
      candidates.set(key, { candidate, score: (prior?.score ?? 0) + 1 / (RRF_K + Number(row.signal_rank)) });
    }
  };
  const lexical = signal('lexical', null);
  const semantic = (async () => {
    const data = await bounded<{ embedding?: number[] }>('embedding', signal => client.functions.invoke('embed-knowledge', {
      body: { text: result.normalized_query }, signal,
    }), 1200);
    if (!data?.embedding?.length) {
      incomplete = true;
      routes.push({ route: 'semantic', outcome: 'unavailable', reason: 'embedding-unavailable' });
      return;
    }
    if (absent) return;
    await signal('semantic', JSON.stringify(data.embedding));
  })();
  // Suggestions never block an available answer beyond the same absolute deadline.
  const suggestions = args.context_tags?.length ? bounded<string[]>('tag-suggestions', signal => client.rpc('knowledge_search_context_tags', {
    _workspace_id: scope.workspace_id, _project_id: projectId, _context_tags: normalizeTags(args.context_tags),
  }).abortSignal(signal)) : Promise.resolve(undefined);
  await lexical;
  if (absent) {
    result.capability = 'scores-unavailable';
    result.reason = 'scored search is not deployed in this environment yet';
    incomplete = true;
    if (historical) {
      routes.push({ route: 'legacy', outcome: 'unsupported', reason: 'as-of-or-superseded-unavailable' });
      result.reason = 'as_of and include_superseded need the scored search deployed in this environment';
    } else if (filters.status !== 'Accepted' || filters.tags.length || filters.question_state || filters.question_scope) {
      routes.push({ route: 'legacy', outcome: 'unsupported', reason: filters.question_state || filters.question_scope ? 'legacy-scope-or-question-filters-unavailable' : filters.status !== 'Accepted' ? 'legacy-status-accepted-only' : 'normalized-tags-unavailable' });
    } else {
      const legacy = await bounded<Candidate[]>('legacy', signal => {
        let q = client.rpc(filters.scope ? 'knowledge_search_rrf_metadata' : 'knowledge_search_rrf', { ...(filters.scope ? { _scope: filters.scope } : {}), _workspace_id: scope.workspace_id, _project_id: projectId,
          _query_embedding: null, _query_text: result.normalized_query, _domain: filters.domain.length ? filters.domain : null, _match_limit: null }).select('*');
        if (filters.type) q = q.eq('type', filters.type);
        if (!filters.include_bookkeeping) q = q.or('tags.is.null,tags.not.cs.{harmony:bookkeeping}');
        return q.limit(limit).abortSignal(signal);
      });
      result.unscored_matches = (legacy ?? []).slice(0, limit).map(d => summary(d, result.normalized_query));
    }
  }
  await semantic;
  await definitions;
  const tags = await suggestions;
  result.tag_suggestions = normalizeTags(tags ?? []).slice(0, 8);
  if (!absent && scoredCompleted) {
    result.capability = 'scored';
    const all = [...candidates.values()];
    result.below_cutoff_count = all.filter(c => c.score < SCORE_CUTOFF).length;
    const ranked = all.filter(c => c.score >= SCORE_CUTOFF)
      .sort((a, b) => Number(a.candidate.bookkeeping ?? isBookkeeping(a.candidate)) - Number(b.candidate.bookkeeping ?? isBookkeeping(b.candidate)) || Number(priority(b.candidate)) - Number(priority(a.candidate)) || b.score - a.score || a.candidate.source_kind.localeCompare(b.candidate.source_kind) || a.candidate.id.localeCompare(b.candidate.id))
      ;
    result.matches = ranked.slice(offset, offset + limit)
      .map(c => ({ ...summary(c.candidate, result.normalized_query), source_kind: c.candidate.source_kind, score: c.score, ...(c.candidate.status === 'Superseded' ? { replaced: true } : {}) }));
    result.page = { offset, returned: Math.min(limit, Math.max(0, ranked.length - offset)), total_matches: ranked.length };
    result.count_coverage = incomplete ? 'partial-scored-union' : 'considered-scored-union';
  }
  await names;
  result.concepts = result.concepts.slice(0, Math.max(0, limit - result.definitions.length));
  const reserved = new Set([...result.definitions, ...result.refinements].map(d => d.id));
  const remaining = Math.max(0, limit - result.definitions.length - result.concepts.length - result.refinements.length);
  result.matches = result.matches.filter(d => d.source_kind !== 'knowledge' || !reserved.has(d.id)).slice(0, remaining);
  result.unscored_matches = result.unscored_matches.filter(d => !reserved.has(d.id)).slice(0, remaining);
  const displayed = [...result.refinements, ...result.matches, ...result.unscored_matches];
  const ids = displayed.filter(d => !('source_kind' in d) || d.source_kind === 'knowledge').map(d => d.id);
  if (ids.length) {
    await Promise.all([
      (async()=>{
       const read=await bounded<{available:boolean;contexts:ClaimContext[]}>('claim-context',signal=>client.rpc('read_claim_context',{p_claim_ids:ids}).abortSignal(signal));
       if(read && (read.available!==true||!Array.isArray(read.contexts))){incomplete=true;routes.push({route:'claim-context',outcome:'unsupported',reason:'capability-unavailable'});}
       for(const d of displayed)if(ids.includes(d.id))d.claim_context=read?.available===true&&Array.isArray(read.contexts)?read.contexts.find(c=>c.claim_id===d.id):{claim_id:d.id,question_state:'capability-unavailable',questions:[],concepts:[]};
      })(),
      (async()=>{
       const read=await bounded<NameRead>('historical-wording',signal=>client.rpc('read_knowledge_names',{p_project_id:projectId,p_search:null,p_entry_ids:ids,p_entity_ids:[]}).abortSignal(signal));
       if(read&&(read.available!==true||!Array.isArray(read.entries))){incomplete=true;routes.push({route:'historical-wording',outcome:'unsupported',reason:'capability-unavailable'});}
       for(const d of displayed)if(ids.includes(d.id)){const scan=read?.entries?.find(e=>e.entry_id===d.id);Object.assign(d,{name_history_available:read?.available===true},scan?{uses_retired_term:scan.uses_retired_term,retired_term_matches:scan.matches}:{});}
      })(),
      (async()=>{
       const read=await bounded<ProseRead>('defined-in',signal=>client.rpc('read_knowledge_prose',{p_project_id:projectId,p_entry_ids:ids}).abortSignal(signal));
       for(const d of displayed)if(ids.includes(d.id)){const pointer=read?.pointers?.find(p=>p.entry_id===d.id);Object.assign(d,{defined_in_available:read?.available===true},pointer?{defined_in:{...pointer,source_link:proseLink(pointer)}}:{});}
      })(),
    ]);

    const invalidations = await bounded<InvalidationRead>('invalidations', signal => client.rpc('read_knowledge_invalidations', {p_entry_ids:ids}).abortSignal(signal));
    for (const d of displayed) {
      if ('source_kind' in d && d.source_kind !== 'knowledge') continue;
      d.invalidations_available = invalidations?.available === true;
      d.invalidation_rollout_available = invalidations?.rollout_available === true;
      d.invalidations = invalidations?.links?.filter(link => link.affected_id === d.id) ?? [];
    }
    const links = await bounded<Array<{ id: string; superseded_by: string | null }>>('supersession', async signal => {
      const data: Array<{ id: string; superseded_by: string | null }> = [];
      for (let start = 0; start < ids.length; start += 500) {
        for (const column of ['id', 'superseded_by']) {
          const part = await client.from('knowledge_decisions').select('id,superseded_by')
            .eq('workspace_id', scope.workspace_id).eq('project_id', projectId).neq('type', 'intent')
            .in(column, ids.slice(start, start + 500)).limit(500).abortSignal(signal);
          if (part.error) return { data: null, error: part.error };
          data.push(...(part.data ?? []));
        }
      }
      return { data };
    });
    if (links) for (const d of displayed) {
      if ('source_kind' in d && d.source_kind !== 'knowledge') continue;
      d.superseded_by = links.find(e => e.id === d.id)?.superseded_by ?? null;
      d.supersedes = [...new Set(links.filter(e => e.superseded_by === d.id).map(e => e.id))];
    }
  }
  if (result.capability === 'scored' && incomplete) result.count_coverage = 'partial-scored-union';
  return finish();
}
