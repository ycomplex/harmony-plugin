import { describe,it,expect,vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readClaimContexts,withClaimContexts } from './claim-context.js';
const client=(rpc:unknown)=>({rpc}) as SupabaseClient;
describe('claim context capability',()=>{
 it('falls back only on the specifically absent capability and retries on a later request',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({error:{code:'PGRST202',message:'Could not find function read_claim_context'}})
   .mockResolvedValueOnce({data:{available:true,contexts:[]}});
  expect(await readClaimContexts(client(rpc),[])).toEqual({available:false,contexts:[]});
  expect((await readClaimContexts(client(rpc),[])).available).toBe(true);
 });
 it('does not disguise permission, network, unrelated RPC errors or malformed data as unknown provenance',async()=>{
  for(const error of [{code:'42501',message:'denied'},{code:'NETWORK',message:'offline'},{code:'PGRST202',message:'missing different_function'}])
   await expect(readClaimContexts(client(vi.fn().mockResolvedValue({error})),['a'])).rejects.toThrow();
  await expect(readClaimContexts(client(vi.fn().mockResolvedValue({data:[]})),['a'])).rejects.toThrow('Invalid');
 });
 it('enriches only the existing ordered results, without adding claims or upgrading trust',async()=>{
  const context={claim_id:'b',question_state:'available',questions:[{text:'Exact question?'}],concepts:[{id:'concept',name:'Term'}]};
  const rpc=vi.fn().mockResolvedValue({data:{available:true,contexts:[context,{claim_id:'outside'}]}});
  const rows=await withClaimContexts(client(rpc),[{id:'b',status:'Asserted'},{id:'a',status:'Accepted'}]);
  expect(rows.map(r=>[r.id,r.status])).toEqual([['b','Asserted'],['a','Accepted']]);
  expect(rows[0].claim_context).toEqual(context);
 });
 it('pages context calls and marks missing capability explicitly',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{available:true,contexts:[]}});
  await readClaimContexts(client(rpc),Array.from({length:501},(_,i)=>String(i)));
  expect(rpc.mock.calls.map(c=>c[1].p_claim_ids.length)).toEqual([500,1]);
  const missing=client(vi.fn().mockResolvedValue({error:{code:'42883',message:'read_claim_context does not exist'}}));
  expect((await withClaimContexts(missing,[{id:'a'}]))[0].claim_context?.question_state).toBe('capability-unavailable');
 });
});
