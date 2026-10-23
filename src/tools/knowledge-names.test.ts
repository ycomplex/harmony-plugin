import { assertFact, resolveOrCreateEntity } from './knowledge.js';
vi.mock('./resolve-task-id.js',()=>({resolveTaskId:async (_c:unknown,_p:unknown,id:string)=>id}));
import { describe,it,expect,vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {readKnowledgeNames,renameKnowledgeConcept,previewKnowledgeMerge,mergeKnowledgeConcepts,withRetiredWording} from './knowledge-names.js';
const client=(rpc:ReturnType<typeof vi.fn>)=>({rpc}) as unknown as SupabaseClient;
const empty={available:true,matches:[],entries:[],identities:[]};
describe('concept name operations',()=>{
 it('re-probes absent schema and does not turn absence into a clean scan',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({error:{code:'PGRST202',message:'read_knowledge_names absent'}}).mockResolvedValueOnce({data:empty});
  expect((await readKnowledgeNames(client(rpc),'p')).available).toBe(false);
  expect((await readKnowledgeNames(client(rpc),'p')).available).toBe(true);
 });
 it.each(['42501','08006','PGRST301'])('surfaces %s without fallback',async code=>{
  await expect(readKnowledgeNames(client(vi.fn().mockResolvedValue({error:{code,message:'denied'}})),'p')).rejects.toThrow('denied');
 });
 it('does not misclassify an unrelated missing RPC as names absence',async()=>{
  await expect(readKnowledgeNames(client(vi.fn().mockResolvedValue({error:{code:'42883',message:'different_function'}})),'p')).rejects.toThrow('different_function');
 });
 it('preserves content and removes warnings after the stored wording changes',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{...empty,entries:[{entry_id:'e',uses_retired_term:true,matches:[{retired_term:'Old',concept_id:'c',current_name:'Now'}]}]}}).mockResolvedValueOnce({data:{...empty,entries:[{entry_id:'e',uses_retired_term:false,matches:[]}]}});
  const first=await withRetiredWording(client(rpc),'p',[{id:'e',content:'Old meaning'}]);
  expect(first[0]).toMatchObject({content:'Old meaning',uses_retired_term:true});
  expect((await withRetiredWording(client(rpc),'p',[{id:'e',content:'Current meaning'}]))[0]).toMatchObject({uses_retired_term:false});
 });
 it('bounds scan batches and preserves ordering',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:empty});
  const entries=Array.from({length:501},(_,i)=>({id:String(i)}));
  expect(await withRetiredWording(client(rpc),'p',entries)).toHaveLength(501);
  expect(rpc.mock.calls.map(c=>c[1].p_entry_ids.length)).toEqual([500,1]);
 });
 it('passes explicit expected name and idempotency key; unavailable writes refuse',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{new_name:'Now'}}).mockResolvedValueOnce({error:{code:'PGRST202',message:'rename_knowledge_concept missing'}});
  const args={concept_id:'c',expected_name:'Old',new_name:'Now',source_task_id:'t',operation_key:'key'};
  await renameKnowledgeConcept(client(rpc),'p',args);
  expect(rpc).toHaveBeenCalledWith('rename_knowledge_concept',{p_project_id:'p',p_entity_id:'c',p_expected_name:'Old',p_new_name:'Now',p_source_task_id:'t',p_operation_key:'key'});
  await expect(renameKnowledgeConcept(client(rpc),'p',args)).rejects.toThrow('not available');
 });
 it('requires reviewed confirmation and never retries stale merges',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{confirmation:'reviewed',inventory:{blockers:[]}}}).mockResolvedValueOnce({error:{code:'40001',message:'inventory changed'}});
  const args={source_id:'old',target_id:'now',source_task_id:'t'};
  expect(await previewKnowledgeMerge(client(rpc),'p',args)).toMatchObject({confirmation:'reviewed'});
  await expect(mergeKnowledgeConcepts(client(rpc),'p',{...args,confirmation:''})).rejects.toThrow('explicit');
  await expect(mergeKnowledgeConcepts(client(rpc),'p',{...args,confirmation:'reviewed'})).rejects.toThrow('inventory changed');
  expect(rpc).toHaveBeenCalledTimes(2);
 });
});

it('name-based writers resolve retired wording before creating another entity',async()=>{
 const rpc=vi.fn().mockResolvedValue({data:{...empty,matches:[{concept_id:'survivor',current_name:'Now',matched_alias:'Old'}]}});
 const from=vi.fn();
 expect(await resolveOrCreateEntity({rpc,from} as unknown as SupabaseClient,'w','p',' Old ','feature')).toBe('survivor');
 expect(from).not.toHaveBeenCalled();
});

it('fact writers pass the surviving name and kind to their internal name-based RPC',async()=>{
 const rpc=vi.fn(async(name:string)=>name==='read_knowledge_names'?{data:{...empty,matches:[{concept_id:'current',kind:'feature',current_name:'Now',matched_alias:'Old'}]}}:{data:{id:'fact',subject_entity_id:'current'},error:null});
 const project:any={select:()=>project,eq:()=>project,single:async()=>({data:{workspace_id:'w'},error:null})};
 await assertFact({rpc,from:()=>project} as unknown as SupabaseClient,'p','user',{subject_entity:'Old',predicate:'uses',object:'value',source_type:'manual'});
 expect(rpc).toHaveBeenLastCalledWith('knowledge_assert_fact',expect.objectContaining({p_subject_entity:'Now',p_subject_entity_kind:'feature'}));
});

it('a successful null payload is malformed, not a missing capability',async()=>{
 await expect(readKnowledgeNames(client(vi.fn().mockResolvedValue({data:null,error:null})),'p')).rejects.toThrow('Invalid concept name capability response');
});
