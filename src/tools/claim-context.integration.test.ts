import {describe,it,expect,vi} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {recordDecision,getKnowledgeEntry} from './knowledge.js';
vi.mock('./knowledge-invalidations.js',()=>({withInvalidations:async (_:unknown,rows:unknown[])=>rows}));
function fixture(available=true) {
 const row={id:'claim',title:'A claim.',content:'Grounded.',status:'Asserted',project_id:'p',claim_provenance:'human-stated'};
 const chain:Record<string,unknown>={};for(const name of ['select','eq'])chain[name]=vi.fn(()=>chain);
 chain.single=vi.fn(async()=>({data:{...row,workspace_id:'w'},error:null}));
 const context={claim_id:'claim',question_state:'available',questions:[{text:'Original question?'}],concepts:[{id:'concept',name:'Term'}]};
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='knowledge_metadata_capable') return {data:false,error:null};
  if(name==='read_claim_context') return available ? {data:{available:true,contexts:(args.p_claim_ids as string[]).length?[context]:[]},error:null} : {data:null,error:{code:'PGRST202',message:'Could not find function read_claim_context'}};
  if(name==='record_claim_with_context')return {data:{...row,claim_context:context},error:null};
  if(name==='knowledge_record_decision')return {data:row,error:null};
  return {data:null,error:null};
 });
 return {client:{from:vi.fn(()=>chain),rpc} as unknown as SupabaseClient,rpc};
}
const args={scope:'product' as const,type:'specification',title:'A claim.',content:'Grounded.',claim_provenance:'human-stated',claim_questions:[{exchange_id:'ex',round:1,question_id:'q'}],concept_ids:['concept']};
describe('claim context composition',()=>{
 it('probes first and captures claim/context in one atomic governed RPC',async()=>{
  const {client,rpc}=fixture();const result=await recordDecision(client,'p','u',args);
  expect(result.claim_context?.questions[0].text).toBe('Original question?');
  expect(rpc).toHaveBeenCalledWith('record_claim_with_context',expect.objectContaining({p_questions:args.claim_questions,p_concept_ids:['concept'],p_record:expect.objectContaining({p_project_id:'p',p_claim_provenance:'human-stated'})}));
  expect(rpc.mock.calls.findIndex(c=>c[0]==='read_claim_context')).toBeLessThan(rpc.mock.calls.findIndex(c=>c[0]==='record_claim_with_context'));
  expect(rpc.mock.calls.some(c=>c[0]==='knowledge_record_decision')).toBe(false);
 });
 it('preserves legacy capture on old schema and declares context unavailable',async()=>{
  const {client,rpc}=fixture(false);const result=await recordDecision(client,'p','u',{...args,scope:undefined});
  expect(result.claim_context?.question_state).toBe('capability-unavailable');
  expect(rpc.mock.calls.some(c=>c[0]==='record_claim_with_context')).toBe(false);
 });
 it('never falls back on validation failure',async()=>{
  const {client,rpc}=fixture();rpc.mockImplementation(async(name:string)=>name==='read_claim_context'?{data:{available:true,contexts:[]},error:null}:name==='record_claim_with_context'?{data:null,error:{message:'Skipped source',code:'22023'}}:{data:null,error:null});
  await expect(recordDecision(client,'p','u',args)).rejects.toThrow('Skipped source');
  expect(rpc.mock.calls.some(c=>c[0]==='knowledge_record_decision')).toBe(false);
 });
 it('enriches by-id reads without changing claim status',async()=>{
  const {client}=fixture();const result=await getKnowledgeEntry(client,'p',{id:'claim'});
  expect(result.claim_context?.questions[0].text).toBe('Original question?');expect(result.status).toBe('Asserted');
 });
});
