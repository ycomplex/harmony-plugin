import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { queryKnowledge } from './knowledge.js';
import { normalizeTags } from './knowledge-search.js';

const entry = (id: string, extra = {}) => ({ id, source_kind: 'knowledge', title: 'quasar design', content: 'quasar design rule', type: 'technical-design', status: 'Accepted', tags: [], domain: ['engineering'], project_id: 'p', updated_at: '2026-10-22T00:00:00Z', ...extra });
const row = (id: string, rank = 1, extra = {}) => ({ candidate: entry(id, extra), signal_rank: rank, overflow: false });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(options: { lexical?: unknown; semantic?: unknown; embed?: unknown; scope?: unknown; legacy?: unknown; tags?: string[]; hang?: string[]; throwRoute?: string; links?: unknown[] } = {}) {
  const calls: Array<{ path: string; body: any; url: URL; signal?: AbortSignal | null }> = [];
  const client = createClient('http://localhost:5555', 'local-test', { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.split('/').at(-1)!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const route = path === 'knowledge_search_scored' ? body._signal : path;
    calls.push({ path, body, url, signal: init?.signal });
    if (options.hang?.includes(route)) return new Promise<Response>(() => {}); // deliberately ignores abort
    if (route === options.throwRoute) throw new Error('transport down');
    if (path === 'projects') return json(options.scope ?? { workspace_id: 'w' });
    if (path === 'embed-knowledge') return options.embed instanceof Response ? options.embed : json(options.embed ?? { embedding: [1, 0] });
    if (path === 'knowledge_search_scored') {
      const data = body._signal === 'lexical' ? options.lexical : options.semantic;
      return data instanceof Response ? data : json(data ?? [row('a')]);
    }
    if (path === 'knowledge_search_context_tags') return json(options.tags ?? ['surface', 'rare']);
    if (path === 'knowledge_search_rrf') return json(options.legacy ?? [entry('legacy')]);
    if (path === 'knowledge_decisions') return json(options.links ?? []);
    throw new Error(`Unexpected request ${path}`);
  } } });
  return { client, calls };
}
afterEach(() => vi.useRealTimers());
describe('bounded real handler and Supabase transport contract', () => {
  it('uses genuine global contributions, cutoff before final limit and substantive-first ordering', async () => {
    const { client } = fixture({ lexical: [row('bk',1,{tags:['harmony:bookkeeping']}),row('useful',2),row('tail',21)], semantic: [] });
    const answer = await queryKnowledge(client,'p',{search:' quasar   design ',limit:1});
    expect(answer.matches.map(r=>r.id)).toEqual(['useful']);
    expect(answer.matches[0].score).toBe(1/62);
    expect(answer.below_cutoff_count).toBe(1);
    expect(answer).toMatchObject({ normalized_query:'quasar design', capability:'scored', incomplete:false, score_cutoff:0.0125, count_coverage:'considered-scored-union' });
  });
  it('deduplicates namespaced identities, sums both real ranks and exposes partial overflow counts', async () => {
    const { client } = fixture({ lexical:[row('a',21),row('a',1,{source_kind:'document'}),{candidate:null,signal_rank:201,overflow:true}],semantic:[row('a',3)] });
    const answer = await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches).toHaveLength(2);
    expect(answer.matches.find(r=>r.source_kind==='knowledge')!.score).toBe(1/81+1/63);
    expect(answer).toMatchObject({incomplete:true,truncated:true,count_coverage:'partial-scored-union'});
  });
  it('reports source-level missing embeddings without discarding lexical hits', async () => {
    const {client} = fixture({semantic:[{candidate:null,signal_rank:0,overflow:false,unavailable_sources:['document']}]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches[0].score).toBe(1/61);
    expect(answer.routes_tried).toContainEqual({route:'semantic',outcome:'unavailable',reason:'sources-without-embedding:document'});
    expect(answer.count_coverage).toBe('partial-scored-union');
  });
  it('hydrates supersession metadata without replacing score order or adding nonmatching hits',async()=>{
    const {client}=fixture({lexical:[row('old',1),row('new',2)],semantic:[],links:[{id:'old',superseded_by:'new'},{id:'new',superseded_by:null},{id:'outside',superseded_by:'new'}]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches.map(r=>r.id)).toEqual(['old','new']);
    expect(answer.matches[0].superseded_by).toBe('new');
    expect(answer.matches[1].supersedes).toEqual(['old','outside']);
  });
  it('passes every normalized filter to each signal before selection', async () => {
    const {client,calls}=fixture();
    const answer=await queryKnowledge(client,'p',{search:'quasar',type:'convention',status:'draft',tags:[' Rare ','RARE',''],domain:['engineering'],include_bookkeeping:false});
    expect(answer.normalized_filters.tags).toEqual(['rare']);
    const rpc=calls.filter(c=>c.path==='knowledge_search_scored');
    expect(rpc).toHaveLength(2);
    for(const call of rpc) expect(call.body).toMatchObject({_type:'convention',_status:'Asserted',_tags:['rare'],_domain:['engineering'],_include_bookkeeping:false});
    expect(normalizeTags([' A ','a',' ','B'])).toEqual(['a','b']);
  });
  it('keeps lexical hits when embedding fails', async () => {
    const {client}=fixture({embed:json({message:'down'},503)});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches[0].score).toBe(1/61);
    expect(answer).toMatchObject({incomplete:true,count_coverage:'partial-scored-union'});
  });
  it('bounds a hung route ignoring abort and prevents late mutation', async () => {
    vi.useFakeTimers();
    const {client,calls}=fixture({hang:['semantic']});
    const pending=queryKnowledge(client,'p',{search:'quasar'});
    await vi.advanceTimersByTimeAsync(6000);
    const answer=await pending;
    expect(answer.matches.map(r=>r.id)).toEqual(['a']);
    expect(answer.routes_tried).toContainEqual({route:'semantic',outcome:'timeout',reason:'deadline'});
    expect(calls.every(c=>c.signal?.aborted)).toBe(true);
    const before=JSON.stringify(answer);
    await vi.advanceTimersByTimeAsync(10000);
    expect(JSON.stringify(answer)).toBe(before);
  });
  it('includes scope lookup in the absolute deadline', async () => {
    vi.useFakeTimers(); const {client}=fixture({hang:['projects']});
    const pending=queryKnowledge(client,'p',{search:'quasar'});
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toMatchObject({matches:[],capability:'unavailable',incomplete:true,routes_tried:[{route:'scope',outcome:'timeout'}]});
  });
  it('returns ordered unscored legacy results without fabricated ranks, scores or counts', async () => {
    const {client,calls}=fixture({lexical:json({code:'PGRST202',message:'missing'},404),legacy:[entry('z'),entry('a')]});
    const answer=await queryKnowledge(client,'p',{search:'quasar',limit:2,type:'technical-design'});
    expect(answer).toMatchObject({matches:[],capability:'scores-unavailable',incomplete:true,truncated:true,below_cutoff_count:null,count_coverage:'unavailable'});
    expect(answer.unscored_matches.map(r=>r.id)).toEqual(['z','a']);
    expect(answer.unscored_matches.every(r=>!('score' in r)&&!('rank' in r))).toBe(true);
    const legacy=calls.find(c=>c.path==='knowledge_search_rrf')!;
    expect(legacy.body._match_limit).toBeNull();
    expect(legacy.url.searchParams.get('type')).toBe('eq.technical-design');
    expect(legacy.url.searchParams.get('limit')).toBe('2');
  });
  it.each([{status:'Asserted'},{tags:[' Mixed ']}])('diagnoses unsupported legacy semantics %j',async filters=>{
    const {client,calls}=fixture({lexical:json({code:'42883',message:'missing'},404)});
    const answer=await queryKnowledge(client,'p',{search:'quasar',...filters});
    expect(answer.unscored_matches).toEqual([]);
    expect(answer.routes_tried).toContainEqual(expect.objectContaining({route:'legacy',outcome:'unsupported'}));
    expect(calls.some(c=>c.path==='knowledge_search_rrf')).toBe(false);
  });
  it('keeps observed authorization errors as errors, including embedding 403',async()=>{
    for (const options of [{lexical:json({code:'42501',message:'denied'},403)}, {embed:json({message:'denied'},403)}]) {
      const {client}=fixture(options);
      await expect(queryKnowledge(client,'p',{search:'quasar'})).rejects.toBeDefined();
    }
  });
  it('suggests only actual supplied-context tags, caps eight and explains empty queries',async()=>{
    const {client,calls}=fixture({lexical:[],semantic:[],tags:Array.from({length:10},(_,i)=>`tag${i}`)});
    const answer=await queryKnowledge(client,'p',{search:'  nope  ',context_tags:[' Surface ']});
    expect(answer).toMatchObject({matches:[],normalized_query:'nope'});
    expect(answer.tag_suggestions).toHaveLength(8);
    expect(calls.find(c=>c.path==='knowledge_search_context_tags')!.body._context_tags).toEqual(['surface']);
    const second=fixture({lexical:[],semantic:[]});
    expect((await queryKnowledge(second.client,'p',{search:'nope'})).tag_suggestions).toEqual([]);
    expect(second.calls.some(c=>c.path==='knowledge_search_context_tags')).toBe(false);
  });
});
