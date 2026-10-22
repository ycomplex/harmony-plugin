import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { queryKnowledge } from './knowledge.js';
vi.mock('./knowledge-invalidations.js',()=>({withInvalidations:async (_:unknown,rows:unknown[])=>rows}));
function fixture(available=true) {
 const definition={id:'definition',kind:'definition',type:'definition',title:'Term',content:'Current wording',refinements:[],domain:['product']};
 const q: Record<string,unknown>={};
 for(const method of ['select','eq','overlaps','contains','or','order','in','range','neq','limit'])q[method]=vi.fn(()=>q);
 q.single=vi.fn(async()=>({data:{workspace_id:'w'},error:null}));
 q.then=(resolve:(x:unknown)=>unknown)=>Promise.resolve({data:[{id:'decision',title:'Decision',status:'Accepted',type:'specification',tags:[],domain:['product']}],count:1,error:null}).then(resolve);
 const rpc=vi.fn(async(name:string)=>name==='read_knowledge_definitions'?(available?{data:{available:true,definitions:[definition]},error:null}:{data:null,error:{code:'PGRST202',message:'Could not find function read_knowledge_definitions'}}):{data:[],error:null});
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
});
