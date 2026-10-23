import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { queryKnowledge } from './knowledge.js';
import { normalizeTags } from './knowledge-search.js';

const entry = (id: string, extra = {}) => ({ id, source_kind: 'knowledge', title: 'quasar design', content: 'quasar design rule', type: 'technical-design', status: 'Accepted', tags: [], domain: ['engineering'], project_id: 'p', updated_at: '2026-10-22T00:00:00Z', ...extra });
const row = (id: string, rank = 1, extra = {}) => ({ candidate: entry(id, extra), signal_rank: rank, overflow: false });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(options: { lexical?: unknown; semantic?: unknown; embed?: unknown; scope?: unknown; legacy?: unknown; tags?: string[]; hang?: string[]; throwRoute?: string; links?: unknown[]; definitions?: unknown; admission?: unknown; delayLexical?: boolean; prose?:unknown; context?:unknown; names?:unknown; delays?:Record<string,number> } = {}) {
  const calls: Array<{ path: string; body: any; url: URL; signal?: AbortSignal | null }> = [];
  const client = createClient('http://localhost:5555', 'local-test', { auth: { persistSession: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.split('/').at(-1)!;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    const route = path === 'knowledge_search_scored' ? body._signal : path;
    calls.push({ path, body, url, signal: init?.signal });
    if (options.delays?.[route]) await new Promise(resolve => setTimeout(resolve, options.delays![route]));
    if (options.hang?.includes(route)) return new Promise<Response>(() => {}); // deliberately ignores abort
    if (route === options.throwRoute) throw new Error('transport down');
    if (path === 'read_knowledge_names') return options.names instanceof Response?options.names:json(options.names??{available:true,matches:[],entries:[],identities:[]});
    if(path==='read_knowledge_prose')return options.prose instanceof Response?options.prose:json(options.prose??{available:true,sources:[],pointers:[]});
    if(path==='read_claim_context')return options.context instanceof Response?options.context:json(options.context??{available:true,contexts:[]});
    if (path === 'projects') return json(options.scope ?? { workspace_id: 'w' });
    if (path === 'knowledge_search_admission') return options.admission instanceof Response ? options.admission : json(options.admission ?? {version:1,lexical_min_similarity:0.3,semantic_max_distance:0.7});
    if (path === 'embed-knowledge') return options.embed instanceof Response ? options.embed : json(options.embed ?? { embedding: [1, 0] });
    if (path === 'read_knowledge_definitions') return options.definitions instanceof Response ? options.definitions : json(options.definitions ?? {available:true,definitions:[]});
    if (path === 'knowledge_search_scored') {
      if (options.delayLexical && body._signal === 'lexical') await new Promise(resolve => setTimeout(resolve, 20));
      const data = body._signal === 'lexical' ? options.lexical : options.semantic;
      return data instanceof Response ? data : json(data ?? [row('a')]);
    }
    if (path === 'read_knowledge_invalidations') return json({available:true,rollout_available:true,links:[]});
    if (path === 'knowledge_search_context_tags') return json(options.tags ?? ['surface', 'rare']);
    if (path === 'knowledge_search_rrf' || path === 'knowledge_search_rrf_metadata') return json(options.legacy ?? [entry('legacy')]);
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
    expect(answer).toMatchObject({incomplete:false,truncated:true,count_coverage:'partial-scored-union'});
  });
  it('reports source-level missing embeddings without discarding lexical hits', async () => {
    const {client} = fixture({semantic:[{candidate:null,signal_rank:0,overflow:false,unavailable_sources:['document']}]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches[0].score).toBe(1/61);
    expect(answer.routes_tried).toContainEqual(expect.objectContaining({route:'semantic',outcome:'unavailable',reason:'sources-without-embedding:document'}));
    expect(answer.count_coverage).toBe('partial-scored-union');
  });
  it('hydrates supersession metadata without replacing score order or adding nonmatching hits',async()=>{
    const {client}=fixture({lexical:[row('old',1),row('new',2)],semantic:[],links:[{id:'old',superseded_by:'new'},{id:'new',superseded_by:null},{id:'outside',superseded_by:'new'}]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches.map(r=>r.id)).toEqual(['old','new']);
    expect(answer.matches[0].superseded_by).toBe('new');
    expect(answer.matches[1].supersedes).toEqual(['old','outside']);
  });
  it('separates stale corpus and missing-source diagnostics from route completion', async () => {
    const {client}=fixture({prose:{available:true,sources:[{enabled:true,refresh_state:'failed'}],pointers:[]},semantic:[{candidate:null,signal_rank:0,overflow:false,unavailable_sources:['document']}]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer).toMatchObject({incomplete:false,truncated:false,count_coverage:'partial-scored-union'});
    expect(answer.routes_tried).toEqual(expect.arrayContaining([expect.objectContaining({outcome:'stale'}),expect.objectContaining({reason:'sources-without-embedding:document'})]));
    expect(answer.routes_tried.every(r=>Number.isFinite(r.elapsed_ms)&&r.elapsed_ms!>=0)).toBe(true);
  });
  it('overlaps all page enrichment and both supersession directions', async () => {
    vi.useFakeTimers();
    const {client}=fixture({delays:{read_claim_context:400,read_knowledge_names:400,read_knowledge_prose:400,read_knowledge_invalidations:400,knowledge_decisions:400}});
    const pending=queryKnowledge(client,'p',{search:'quasar',type:'technical-design'});
    await vi.advanceTimersByTimeAsync(900);
    const answer=await pending;
    expect(answer.incomplete).toBe(false);
    expect(answer.elapsed_ms).toBeLessThan(1000);
    expect(answer.routes_tried.find(r=>r.route==='supersession')).toMatchObject({outcome:'completed',elapsed_ms:400});
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
    expect(answer.routes_tried).toContainEqual(expect.objectContaining({route:'semantic',outcome:'timeout',reason:'deadline'}));
    expect(calls.every(c=>c.signal?.aborted)).toBe(true);
    const before=JSON.stringify(answer);
    await vi.advanceTimersByTimeAsync(10000);
    expect(JSON.stringify(answer)).toBe(before);
  });
  it('includes scope lookup in the absolute deadline', async () => {
    vi.useFakeTimers(); const {client}=fixture({hang:['projects']});
    const pending=queryKnowledge(client,'p',{search:'quasar'});
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toMatchObject({matches:[],capability:'unavailable',incomplete:true,routes_tried:expect.arrayContaining([expect.objectContaining({route:'scope',outcome:'timeout'})])});
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

const question = (state = 'open', scope = 'product') => ({source_activity:'knowledge-question',madr:{question:{version:1,state,scope}},superseded_by:state==='decided'?'successor':null});
describe('one scored pool: questions, scope and definitions', () => {
  it.each([false,true])('preserves semantic proof in either completion order (lexical delayed: %s)', async delayLexical => {
    const {client} = fixture({delayLexical, lexical:[row('ordinary',1), row('question',3,question())], semantic:[row('ordinary',1,{semantic_distance:0.1}),row('question',3,{...question(),semantic_distance:0.35})]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches.map(d=>d.id)).toEqual(['question','ordinary']);
    expect(answer.matches[0]).toMatchObject({question_state:'open',question_scope:'product',answer:'not yet decided',resulting_decision_id:null});
  });
  it('applies the inclusive distance gate only to valid unresolved questions, after bookkeeping',async()=>{
    const {client}=fixture({lexical:[row('ordinary',1),row('lexical',2,question()),row('bad',3,{...question(),madr:{question:{version:2,state:'open',scope:'product'}}})],semantic:[row('above',4,{...question(),semantic_distance:0.350001}),row('at',5,{...question('parked'),semantic_distance:0.35}),row('below',6,{...question(),semantic_distance:0.349999}),row('book',1,{...question(),semantic_distance:0.1,tags:['harmony:bookkeeping']}),row('decided',7,{...question('decided'),semantic_distance:0.1})]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches.map(d=>d.id)).toEqual(['at','below','ordinary','lexical','bad','above','decided','book']);
    expect(answer.matches.find(d=>d.id==='bad')).not.toHaveProperty('question_state');
    expect(answer.matches.find(d=>d.id==='decided')).toMatchObject({resulting_decision_id:'successor',answer:'decided; see resulting decision'});
  });
  it('applies cutoff before question priority',async()=>{
    const {client}=fixture({lexical:[],semantic:[row('below-cutoff',21,{...question(),semantic_distance:0.1}),row('ordinary',1)]});
    const answer=await queryKnowledge(client,'p',{search:'quasar'});
    expect(answer.matches.map(d=>d.id)).toEqual(['ordinary']);expect(answer.below_cutoff_count).toBe(1);
  });
  it('passes effective scope and separate question filters to both signals and never calls metadata RPC',async()=>{
    const {client,calls}=fixture();
    await queryKnowledge(client,'p',{search:'quasar',scope:'product',question_state:'parked',question_scope:'deployment'});
    for(const c of calls.filter(c=>c.path==='knowledge_search_scored')) expect(c.body).toMatchObject({_scope:'product',_question_state:'parked',_question_scope:'deployment',_status:null});
    expect(calls.some(c=>c.path==='knowledge_search_rrf_metadata')).toBe(false);
  });
  it.each([{question_state:'open' as const},{question_scope:'deployment' as const}])('never drops unsupported legacy filters %j',async filters=>{
    const {client,calls}=fixture({lexical:json({code:'PGRST202'},404)});
    const answer=await queryKnowledge(client,'p',{search:'quasar',...filters});
    expect(answer.unscored_matches).toEqual([]);
    expect(answer.routes_tried).toContainEqual(expect.objectContaining({route:'legacy',outcome:'unsupported',reason:'legacy-scope-or-question-filters-unavailable'}));
    expect(calls.some(c=>c.path==='knowledge_search_rrf_metadata')).toBe(false);
  });
  it('uses the existing scope metadata RPC only for ordered unscored legacy fallback',async()=>{
    const {client,calls}=fixture({lexical:json({code:'PGRST202'},404),legacy:[entry('z',{scope:'product'}),entry('a',{scope:'product'})]});
    const answer=await queryKnowledge(client,'p',{search:'quasar',scope:'product',limit:2});
    expect(answer.matches).toEqual([]);expect(answer.unscored_matches.map(d=>d.id)).toEqual(['z','a']);
    expect(answer.unscored_matches[0].scope).toBe('product');
    const legacy=calls.find(c=>c.path==='knowledge_search_rrf_metadata')!;expect(legacy.body._scope).toBe('product');expect(legacy.body._match_limit).toBeNull();
  });
  it('reserves one shared limit for quotable definitions, refinements, then scored decisions without duplicates',async()=>{
    const definition={id:'def',kind:'definition',type:'definition',content:'Full wording',refinements:[{id:'linked'}]};
    const {client}=fixture({definitions:{available:true,definitions:[definition]},links:[entry('linked')],lexical:[row('linked'),row('other',2)],semantic:[]});
    const answer=await queryKnowledge(client,'p',{search:'quasar',limit:3});
    expect(answer.definitions[0]).toMatchObject({content:'Full wording'});
    expect(answer.refinements.map(d=>d.id)).toEqual(['linked']);
    expect(answer.matches.map(d=>d.id)).toEqual(['other']);
    expect(answer.definitions[0]).not.toHaveProperty('score');
  });
  it('keeps product-scoped definitions available without a decision scoring route',async()=>{
    const definition={id:'def',kind:'definition',type:'definition',content:'Current wording',refinements:[]};
    const {client,calls}=fixture({definitions:{available:true,definitions:[definition]}});
    const answer=await queryKnowledge(client,'p',{search:'quasar',definitions_only:true,scope:'product'});
    expect(answer.definitions.map(d=>d.id)).toEqual(['def']);expect(answer.definitions_available).toBe(true);
    expect(calls.some(c=>c.path==='knowledge_search_scored')).toBe(false);
  });
  it('definitions_only never launches a decision ranking route and reports absent storage',async()=>{
    const {client,calls}=fixture({definitions:json({code:'PGRST202'},404)});
    const answer=await queryKnowledge(client,'p',{search:'quasar',definitions_only:true});
    expect(answer).toMatchObject({definitions:[],definitions_available:false,matches:[],incomplete:true});
    expect(calls.some(c=>c.path==='knowledge_search_scored')).toBe(false);
  });
  it('hung definition storage cannot extend the common deadline or hide scored hits',async()=>{
    vi.useFakeTimers();const {client}=fixture({hang:['read_knowledge_definitions']});
    const pending=queryKnowledge(client,'p',{search:'quasar'});await vi.advanceTimersByTimeAsync(6000);
    const answer=await pending;expect(answer.matches[0].id).toBe('a');expect(answer.incomplete).toBe(true);
  });
});

describe('B-371 search composes with as_of, offset and include_superseded',()=>{
 it('sends no new parameters unless asked, so an older database keeps working',async()=>{
  const {client,calls}=fixture();
  await queryKnowledge(client,'p',{search:'quasar'});
  for(const c of calls.filter(c=>c.path==='knowledge_search_scored')){expect(c.body).not.toHaveProperty('_as_of');expect(c.body).not.toHaveProperty('_include_superseded');}
 });
 it('threads as_of as an instant and implies replaced entries are included, marking them replaced',async()=>{
  const {client,calls}=fixture({lexical:[row('old',1,{status:'Superseded'}),row('new',2)],semantic:[]});
  const answer=await queryKnowledge(client,'p',{search:'quasar',as_of:'2026-01-15'});
  for(const c of calls.filter(c=>c.path==='knowledge_search_scored'))expect(c.body).toMatchObject({_as_of:'2026-01-15T00:00:00.000Z',_include_superseded:true,_status:null});
  expect(answer.matches.find(m=>m.id==='old')).toMatchObject({replaced:true});
  expect(answer.matches.find(m=>m.id==='new')).not.toHaveProperty('replaced');
 });
 it('threads include_superseded alone',async()=>{
  const {client,calls}=fixture();
  await queryKnowledge(client,'p',{search:'quasar',include_superseded:true});
  for(const c of calls.filter(c=>c.path==='knowledge_search_scored')){expect(c.body).toMatchObject({_include_superseded:true});expect(c.body).not.toHaveProperty('_as_of');}
 });
 it('pages after ranking without repeats, and reports the total',async()=>{
  const rows=[row('a',1),row('b',2),row('c',3)];
  const {client}=fixture({lexical:rows,semantic:[]});
  const first=await queryKnowledge(client,'p',{search:'quasar',limit:2});
  const second=await queryKnowledge(client,'p',{search:'quasar',limit:2,offset:2});
  expect(first.matches.map(m=>m.id)).toEqual(['a','b']);
  expect(second.matches.map(m=>m.id)).toEqual(['c']);
  expect(second.page).toEqual({offset:2,returned:1,total_matches:3});
 });
 it('returns an empty page that states how many results existed when offset is past the end',async()=>{
  const {client}=fixture({lexical:[row('a',1),row('b',2)],semantic:[]});
  const answer=await queryKnowledge(client,'p',{search:'quasar',offset:10});
  expect(answer.matches).toEqual([]);
  expect(answer.page).toEqual({offset:10,returned:0,total_matches:2});
 });
 it('says so when as_of cannot be served because scored search is not deployed',async()=>{
  const {client,calls}=fixture({lexical:json({code:'PGRST202',message:'missing knowledge_search_scored'},404),semantic:[]});
  const answer=await queryKnowledge(client,'p',{search:'quasar',as_of:'2026-01-15'});
  expect(answer.capability).toBe('scores-unavailable');
  expect(answer.reason).toMatch(/as_of and include_superseded/);
  expect(answer.unscored_matches).toEqual([]);
  expect(calls.some(c=>c.path==='knowledge_search_rrf')).toBe(false);
 });
});

describe('source envelope and bounded enrichment',()=>{
 it('retains source provenance and real authority without inventing claim acceptance',async()=>{
  const provenance={source_id:'s',repository:'https://example.invalid/acme/docs',path:'guide/rules.md',commit:'a'.repeat(40),anchor:'café',heading:'Café'};
  const {client,calls}=fixture({lexical:[row('doc',1,{source_kind:'document',status:'Source-backed',provenance})],semantic:[]});
  const answer=await queryKnowledge(client,'p',{search:'quasar'});
  expect(answer.matches[0]).toMatchObject({source_kind:'document',status:'Source-backed',authority:'unratified',provenance,score:1/61});
  expect((answer.matches[0] as any).source_link).toContain('#caf%C3%A9');
  expect(calls.filter(c=>c.path==='knowledge_search_scored').every(c=>c.body._status===null)).toBe(true);
 });
 it('keeps useful entry results and declares indexing absent only on a positive missing capability',async()=>{
  const {client,calls}=fixture({prose:json({code:'PGRST202',message:'missing read_knowledge_prose'},404)});
  const answer=await queryKnowledge(client,'p',{search:'quasar'});
  expect(answer.matches).toHaveLength(1);expect(answer.prose_coverage).toEqual({available:false});expect(answer.incomplete).toBe(true);
  expect(calls.filter(c=>c.path==='knowledge_search_scored').every(c=>c.body._status==='Accepted')).toBe(true);
 });
 it('hydrates claim questions, historical wording and exact dangling pointers',async()=>{
  const context={claim_id:'a',question_state:'available',questions:[{question_id:'q',text:'Which rule?'}],concepts:[]};
  const {client}=fixture({context:{available:true,contexts:[context]},names:{available:true,matches:[],identities:[],entries:[{entry_id:'a',uses_retired_term:true,matches:[{retired_term:'old',concept_id:'c',current_name:'new'}]}]},prose:{available:true,sources:[],pointers:[{entry_id:'a',source_id:'s',repository:'https://example.invalid/repo',path:'rules.md',anchor:'old',commit:'a'.repeat(40),resolved:false}]}});
  const answer=await queryKnowledge(client,'p',{search:'quasar'});
  expect(answer.matches[0].claim_context).toEqual(context);expect(answer.matches[0]).toMatchObject({name_history_available:true,uses_retired_term:true,defined_in:{resolved:false,anchor:'old'}});
 });
 it('bounds hung source diagnostics and enrichment while preserving entry ranks',async()=>{
  vi.useFakeTimers();const {client}=fixture({hang:['read_knowledge_prose','read_claim_context','read_knowledge_names']});
  const pending=queryKnowledge(client,'p',{search:'quasar'});await vi.advanceTimersByTimeAsync(6000);const answer=await pending;
  expect(answer.matches[0].score).toBe(2/61);expect(answer.incomplete).toBe(true);expect(answer.elapsed_ms).toBeLessThanOrEqual(6000);
 });
 it('does not downgrade source/enrichment authorization failures to empty coverage',async()=>{
  const {client}=fixture({context:json({code:'42501',message:'denied'},403)});
  await expect(queryKnowledge(client,'p',{search:'quasar'})).rejects.toMatchObject({code:'42501'});
 });
});

it('explains a fully admitted empty answer separately from the rank cutoff', async () => {
  const {client} = fixture({lexical:[],semantic:[]});
  const answer = await queryKnowledge(client,'p',{search:'zxqv plorth wimbleflax',limit:5});
  expect(answer).toMatchObject({matches:[],below_cutoff_count:0,score_cutoff:0.0125,
    normalized_query:'zxqv plorth wimbleflax',page:{total_matches:0},
    relevance_admission:{lexical_min_similarity:0.3,semantic_max_distance:0.7,enforcement:{lexical:'enforced',semantic:'enforced'}}});
  expect(answer.routes_tried).toContainEqual({route:'relevance-admission',outcome:'completed'});
});
it('keeps old scored deployments usable with explicitly unknown admission enforcement', async () => {
  const {client} = fixture({admission:json({code:'PGRST202',message:'missing policy'},404)});
  const answer = await queryKnowledge(client,'p',{search:'quasar'});
  expect(answer.matches).toHaveLength(1);
  expect(answer.relevance_admission).toEqual({lexical_min_similarity:null,semantic_max_distance:null,enforcement:{lexical:'unknown',semantic:'unknown'}});
  expect(answer.routes_tried).toContainEqual({route:'relevance-admission',outcome:'unsupported',reason:'missing-capability'});
});
it('does not claim enforcement from malformed policy metadata', async () => {
  const {client} = fixture({admission:{version:1,lexical_min_similarity:'0.3',semantic_max_distance:0.7}});
  const answer = await queryKnowledge(client,'p',{search:'quasar'});
  expect(answer.matches).toHaveLength(1);
  expect(answer.relevance_admission.enforcement.lexical).toBe('unknown');
  expect(answer.routes_tried).toContainEqual({route:'relevance-admission',outcome:'unsupported',reason:'invalid-capability-response'});
});
it('reports definitions participation for empty success, filtered-out route and missing storage', async () => {
  const included = await queryKnowledge(fixture().client,'p',{search:'quasar'});
  expect(included).toMatchObject({definitions:[],definitions_included:true,definitions_available:true});
  const filteredFixture=fixture();
  const filtered = await queryKnowledge(filteredFixture.client,'p',{search:'quasar',type:'convention'});
  expect(filtered).toMatchObject({definitions_included:false,definitions_available:false});
  expect(filteredFixture.calls.some(c=>c.path==='read_knowledge_definitions')).toBe(false);
  const missing = await queryKnowledge(fixture({definitions:json({code:'PGRST202'},404)}).client,'p',{search:'quasar'});
  expect(missing).toMatchObject({definitions_included:false,definitions_available:false});
  expect(missing.routes_tried).toContainEqual({route:'definitions',outcome:'unsupported',reason:'missing-capability'});
});
it('keeps stable tied prefixes across caller page sizes and reports skipped semantic admission', async () => {
  const options={lexical:[row('b',1),row('a',1),row('c',1,{source_kind:'document'})],semantic:[],embed:json({},503)};
  const short=await queryKnowledge(fixture(options).client,'p',{search:'quasar',limit:1});
  const long=await queryKnowledge(fixture(options).client,'p',{search:'quasar',limit:8});
  expect(short.matches.map(m=>m.id)).toEqual(long.matches.slice(0,1).map(m=>m.id));
  expect(long.matches.map(m=>m.id)).toEqual(['c','a','b']);
  expect(long.relevance_admission.enforcement).toEqual({lexical:'enforced',semantic:'not-run'});
});
it('bounds a hung admission probe and labels enforcement unknown without losing hits', async () => {
  vi.useFakeTimers();
  const pending=queryKnowledge(fixture({hang:['knowledge_search_admission']}).client,'p',{search:'quasar'});
  await vi.advanceTimersByTimeAsync(6000);
  const answer=await pending;
  expect(answer.matches).toHaveLength(1);
  expect(answer.elapsed_ms).toBeLessThanOrEqual(6000);
  expect(answer.relevance_admission.enforcement).toEqual({lexical:'unknown',semantic:'unknown'});
  expect(answer.routes_tried).toContainEqual({route:'relevance-admission',outcome:'timeout',reason:'deadline'});
});
