import type { SupabaseClient } from '@supabase/supabase-js';
import type { KnowledgeEntrySummary, QueryKnowledgeArgs } from './knowledge.js';
import { claimFields, matchedPassage } from './knowledge-claim.js';
import { isBookkeeping } from './knowledge-bookkeeping.js';

export const SEARCH_BUDGET_MS = 6000;
export const SCORE_CUTOFF = 0.0125;
export const RRF_K = 60;
export const normalizeTags = (tags: readonly string[] = []): string[] =>
  [...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))];
export interface SearchMatch extends KnowledgeEntrySummary { source_kind: string; score: number }
export interface SearchRoute { route: string; outcome: string; reason?: string }
export interface KnowledgeSearchResult {
  matches: SearchMatch[];
  unscored_matches: KnowledgeEntrySummary[];
  incomplete: boolean;
  truncated: boolean;
  capability: 'scored' | 'scores-unavailable' | 'unavailable';
  reason?: string;
  normalized_query: string;
  normalized_filters: { type: string | null; status: string; domain: string[]; tags: string[]; include_bookkeeping: boolean };
  routes_tried: SearchRoute[];
  score_cutoff: number;
  below_cutoff_count: number | null;
  count_coverage: 'considered-scored-union' | 'partial-scored-union' | 'unavailable';
  candidate_limits: { per_class_per_signal: number; max_scored_union: number };
  tag_suggestions: string[];
  elapsed_ms: number;
}
interface Candidate extends KnowledgeEntrySummary { source_kind: string; content?: string; bookkeeping?: boolean }
interface SignalRow { candidate: Candidate | null; signal_rank: number; overflow: boolean; unavailable_sources?: string[] | null }
const authError = (e: any): boolean => ['401', '403', '42501', 'PGRST301', 'PGRST302', 'PGRST303'].some(v => [e?.code, e?.status, e?.context?.status].map(String).includes(v));
const missing = (e: any): boolean => ['PGRST202', '42883'].includes(e?.code);
const summary = (d: Candidate, query: string): KnowledgeEntrySummary => ({
  id: d.id, title: d.title, type: d.type, status: d.status, domain: d.domain ?? [], tags: d.tags ?? [],
  project_id: d.project_id, updated_at: d.updated_at, ...claimFields(d), snippet: matchedPassage(d.content ?? '', query),
});

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
    matches: [], unscored_matches: [], incomplete: false, truncated: false, capability: 'unavailable',
    normalized_query: args.search!.trim().replace(/\s+/g, ' '),
    normalized_filters: { type: args.type ?? null, status: args.status ?? 'Accepted', domain: args.domain ?? [], tags: normalizeTags(args.tags), include_bookkeeping: args.include_bookkeeping !== false },
    routes_tried: routes, score_cutoff: SCORE_CUTOFF, below_cutoff_count: null, count_coverage: 'unavailable',
    candidate_limits: { per_class_per_signal: 200, max_scored_union: 800 }, tag_suggestions: [], elapsed_ms: 0,
  };
  const limit = args.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Knowledge limit must be a non-negative integer');
  if (args.as_of || args.offset || args.include_superseded) throw new Error('Search cannot combine as_of, offset or include_superseded; use an explicit status or a filter-only list');
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
  const scope = await bounded<{ workspace_id: string }>('scope', signal => client.from('projects').select('workspace_id').eq('id', projectId).abortSignal(signal).single());
  if (!scope) { incomplete = true; return finish(); }
  const filters = result.normalized_filters;
  let absent = false;
  let scoredCompleted = false;
  const candidates = new Map<string, { candidate: Candidate; score: number }>();
  const signal = async (name: 'lexical' | 'semantic', embedding: string | null) => {
    const rows = await bounded<SignalRow[]>(name, async signal => {
      const response = await client.rpc('knowledge_search_scored', {
        _workspace_id: scope.workspace_id, _project_id: projectId, _query_text: result.normalized_query,
        _query_embedding: embedding, _signal: name, _type: filters.type, _status: filters.status,
        _domain: filters.domain.length ? filters.domain : null, _tags: filters.tags.length ? filters.tags : null,
        _include_bookkeeping: filters.include_bookkeeping,
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
      candidates.set(key, { candidate: row.candidate, score: (prior?.score ?? 0) + 1 / (RRF_K + Number(row.signal_rank)) });
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
    if (filters.status !== 'Accepted' || filters.tags.length) {
      routes.push({ route: 'legacy', outcome: 'unsupported', reason: filters.status !== 'Accepted' ? 'legacy-status-accepted-only' : 'normalized-tags-unavailable' });
    } else {
      const legacy = await bounded<Candidate[]>('legacy', signal => {
        let q = client.rpc('knowledge_search_rrf', { _workspace_id: scope.workspace_id, _project_id: projectId,
          _query_embedding: null, _query_text: result.normalized_query, _domain: filters.domain.length ? filters.domain : null, _match_limit: null }).select('*');
        if (filters.type) q = q.eq('type', filters.type);
        if (!filters.include_bookkeeping) q = q.or('tags.is.null,tags.not.cs.{harmony:bookkeeping}');
        return q.limit(limit).abortSignal(signal);
      });
      result.unscored_matches = (legacy ?? []).slice(0, limit).map(d => summary(d, result.normalized_query));
    }
  }
  await semantic;
  const tags = await suggestions;
  result.tag_suggestions = normalizeTags(tags ?? []).slice(0, 8);
  if (!absent && scoredCompleted) {
    result.capability = 'scored';
    const all = [...candidates.values()];
    result.below_cutoff_count = all.filter(c => c.score < SCORE_CUTOFF).length;
    result.matches = all.filter(c => c.score >= SCORE_CUTOFF)
      .sort((a, b) => Number(a.candidate.bookkeeping ?? isBookkeeping(a.candidate)) - Number(b.candidate.bookkeeping ?? isBookkeeping(b.candidate)) || b.score - a.score || a.candidate.source_kind.localeCompare(b.candidate.source_kind) || a.candidate.id.localeCompare(b.candidate.id))
      .slice(0, limit).map(c => ({ ...summary(c.candidate, result.normalized_query), source_kind: c.candidate.source_kind, score: c.score }));
    result.count_coverage = incomplete ? 'partial-scored-union' : 'considered-scored-union';
  }
  const displayed = [...result.matches, ...result.unscored_matches];
  const ids = displayed.filter(d => !('source_kind' in d) || d.source_kind === 'knowledge').map(d => d.id);
  if (ids.length) {
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
