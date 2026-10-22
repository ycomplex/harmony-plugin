import { describe,it,expect,vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { compareSourceCoverage,publishSourceInventory,readSourceInventory,readSourceValues,sourceInventorySchema } from './knowledge-sources.js';
const value={key:'timeout',kind:'default' as const,title:'Timeout',content:'30',spellings:['--timeout','config.timeout'],source:{path:'config.ts',sha:'a'.repeat(40),publisher:'config',publisher_version:'1',run_url:'https://ci.test/1'}};
const inventory={repository:'o/r',surface:'config',run_id:'1',source_sha:'a'.repeat(40),expected_revision:null,values:[value]};
const db=(rpc:ReturnType<typeof vi.fn>)=>({rpc}) as unknown as SupabaseClient;
describe('source inventories',()=>{
 it('matches escaped literal aliases at case-sensitive identifier boundaries and reports rewrite losses',()=>{
  const result=compareSourceCoverage([value],'--timeouts configXtimeout --Timeout','--timeout','rev');
  expect(result.missing.map(r=>r.key)).toEqual(['timeout']);
  expect(result.lost[0].previous_spellings).toEqual(['--timeout']);
  expect(compareSourceCoverage([value],'`config.timeout`, --timeout.').mentioned[0].matched_spellings).toEqual(['--timeout','config.timeout']);
  expect(result.inventory_revision).toBe('rev');
  expect(result.coverage).toContain('not proof of semantic completeness');
 });
 it('validates all kinds, measurements, keys, spans and immutable source revisions',()=>{
  for(const kind of ['default','error','file-shape','explanation'] as const) expect(sourceInventorySchema.parse({...inventory,values:[{...value,kind}]})).toBeTruthy();
  expect(()=>sourceInventorySchema.parse({...inventory,values:[{...value,kind:'measurement'}]})).toThrow('Measurement requires');
  expect(()=>sourceInventorySchema.parse({...inventory,values:[value,value]})).toThrow('Duplicate');
  expect(()=>sourceInventorySchema.parse({...inventory,source_sha:'b'.repeat(40)})).toThrow('revision mismatch');
  expect(()=>sourceInventorySchema.parse({...inventory,values:[{...value,source:{...value.source,path:'../escape'}}]})).toThrow('repository-relative');
 });
 it('refuses old metadata without attempting publication',async()=>{
  const rpc=vi.fn().mockResolvedValue({error:{code:'PGRST202',message:'missing'}});
  await expect(publishSourceInventory(db(rpc),'p',inventory)).rejects.toThrow('nothing was saved');
  expect(rpc).toHaveBeenCalledTimes(1);
 });
 it('refuses old inventory capability and passes the full snapshot to the transaction',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:true}).mockResolvedValueOnce({data:false});
  await expect(readSourceInventory(db(rpc),'p',inventory)).rejects.toThrow('unavailable');
  rpc.mockResolvedValueOnce({data:true}).mockResolvedValueOnce({data:true}).mockResolvedValueOnce({data:{revision:'new'}});
  await expect(publishSourceInventory(db(rpc),'p',inventory)).resolves.toEqual({revision:'new'});
  expect(rpc).toHaveBeenLastCalledWith('publish_knowledge_source_inventory',expect.objectContaining({p_project_id:'p',p_expected_revision:null,p_values:[value]}));
 });
 it('does not mask access or transport errors; ordinary retrieval tolerates only missing schema',async()=>{
  for(const code of ['42501','08006']) await expect(readSourceValues(db(vi.fn().mockResolvedValue({error:{code,message:'refused'}})),'p')).rejects.toThrow('refused');
  await expect(readSourceValues(db(vi.fn().mockResolvedValue({error:{code:'PGRST202',message:'missing'}})),'p')).resolves.toEqual({values:[],total_count:0});
 });
 it('pages generated retrieval before combining it with decision results',async()=>{
  const rpc=vi.fn().mockResolvedValueOnce({data:{values:Array.from({length:500},(_,i)=>({id:String(i)})),total_count:501}}).mockResolvedValueOnce({data:{values:[{id:'500'}],total_count:501}});
  const result=await readSourceValues(db(rpc),'p',{limit:501});
  expect(result.values).toHaveLength(501);
  expect(rpc).toHaveBeenLastCalledWith('read_knowledge_source_values',expect.objectContaining({p_limit:1,p_offset:500}));
 });

});
