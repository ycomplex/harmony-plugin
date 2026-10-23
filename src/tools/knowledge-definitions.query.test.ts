import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { queryKnowledge } from './knowledge.js';
vi.mock('./knowledge-invalidations.js',()=>({withInvalidations:async (_:unknown,rows:unknown[])=>rows}));
function fixture(available=true, generated: any[] = [], names: any = null, hasDefinition=true) {
 const definition={id:'definition',kind:'definition',type:'definition',title:'Term',content:'Current wording',refinements:[],domain:['product']};
 const q: Record<string,unknown>={};
 for(const method of ['select','eq','overlaps','contains','or','order','in','range','neq','limit','abortSignal'])q[method]=vi.fn(()=>q);
 q.single=vi.fn(async()=>({data:{workspace_id:'w'},error:null}));
 q.then=(resolve:(x:unknown)=>unknown)=>Promise.resolve({data:[{id:'decision',title:'Decision',status:'Accepted',type:'specification',tags:[],domain:['product']}],count:1,error:null}).then(resolve);
 const rpc=vi.fn(async(name:string)=>name==='read_knowledge_names'?(names?{data:names,error:null}:{data:null,error:{code:'PGRST202',message:'read_knowledge_names missing'}}):name==='read_knowledge_source_values'?{data:{values:generated,total_count:generated.length},error:null}:name==='read_knowledge_definitions'?(available?{data:{available:true,definitions:hasDefinition?[definition]:[]},error:null}:{data:null,error:{code:'PGRST202',message:'Could not find function read_knowledge_definitions'}}):{data:[],error:null});
 const raw=rpc.getMockImplementation()!; rpc.mockImplementation((...args:any[])=>Object.assign(raw(...args as [string]),{abortSignal:()=>raw(...args as [string])}));
 return {client:{from:vi.fn(()=>q),rpc} as unknown as SupabaseClient,rpc};
}
describe('query_knowledge definition integration',()=>{
 it('returns full quotable definitions before ordinary structured matches',async()=>{
  const {client}=fixture();const rows=await queryKnowledge(client,'p',{});
  expect(rows[0]).toMatchObject({kind:'definition',content:'Current wording'});expect(rows[1].id).toBe('decision');
 });
 it('returns no ordinary decisions in definitions-only mode',async()=>{
  const {client}=fixture();expect((await queryKnowledge(client,'p',{definitions_only:true})).map(x=>x.id)).toEqual(['definition']);
 });
 it('keeps ordinary lookup working before deployment and reports definitions-only unavailable',async()=>{
  const {client}=fixture(false);expect((await queryKnowledge(client,'p',{})).map(x=>x.id)).toEqual(['decision']);
  await expect(queryKnowledge(client,'p',{definitions_only:true})).rejects.toThrow('not available');
 });
 it('includes source evidence after definitions and preserves its Asserted machine provenance',async()=>{
  const value={id:'source',kind:'source-value',content:'timeout=30',status:'Asserted',source_type:'generated',scope:'deployment',source:{path:'config.ts',sha:'abc'}};
  const {client}=fixture(true,[value]);
  const rows=await queryKnowledge(client,'p',{});
  expect(rows.map(r=>r.id)).toEqual(['definition','source','decision']);
  expect(rows[1]).toMatchObject(value);
 });
 it('keeps explicit decision filters separate from source inventories',async()=>{
  const {client,rpc}=fixture(true,[{id:'source'}]);
  await queryKnowledge(client,'p',{status:'Accepted'});
  expect(rpc.mock.calls.map(c=>c[0])).not.toContain('read_knowledge_source_values');
 });

});

// Isolate the pre-existing contract; claim-context.integration.test.ts exercises composition.
vi.mock('./claim-context.js', async original => ({
 ...await original<typeof import('./claim-context.js')>(),
 withClaimContexts: async (_client: unknown, rows: unknown[]) => rows,
}));
it('a retired lookup keeps the current definition first, ahead of ordinary decisions',async()=>{
 const names={available:true,matches:[{concept_id:'concept',current_name:'Term',matched_alias:'Old term',state:'current-definition',definition:{id:'definition'},names:[]}],entries:[],identities:[]};
 const {client}=fixture(true,[],names);
 expect((await queryKnowledge(client,'p',{search:'Old term',limit:1})).definitions[0]).toMatchObject({id:'definition',kind:'definition',content:'Current wording'});
});
it('an alias without a definition reports the current identity explicitly without inventing wording',async()=>{
 const names={available:true,matches:[{concept_id:'concept',current_name:'Current',matched_alias:'Old term',state:'no-current-definition',definition:null,names:[]}],entries:[],identities:[]};
 const {client}=fixture(true,[],names,false);
 expect((await queryKnowledge(client,'p',{search:'Old term',limit:1})).concepts[0]).toMatchObject({kind:'concept',concept_id:'concept',state:'no-current-definition',matched_alias:'Old term'});
});
