import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readDefinitions, publishDefinition } from './knowledge-definitions.js';

beforeEach(() => { delete process.env.HARMONY_CONDUCTION_ID; delete process.env.HARMONY_LEG; });
const client = (rpc: ReturnType<typeof vi.fn>) => ({ rpc }) as unknown as SupabaseClient;
describe('definition capability and publication', () => {
 it('re-probes a missing capability and accepts a newly deployed schema', async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ error: { code: 'PGRST202', message: 'Could not find function read_knowledge_definitions' } })
   .mockResolvedValueOnce({ data: { available: true, definitions: [{ id: 'definition' }] } });
  expect((await readDefinitions(client(rpc),'workspace','project')).available).toBe(false);
  expect((await readDefinitions(client(rpc),'workspace','project')).definitions).toHaveLength(1);
  expect(rpc).toHaveBeenLastCalledWith('read_knowledge_definitions', expect.objectContaining({ p_project_id: 'project', p_workspace_id: 'workspace' }));
 });
 it.each(['42501','PGRST301','08006'])('does not disguise %s as unavailable', async code => {
  const rpc = vi.fn().mockResolvedValue({ error: { code, message: 'denied or disconnected' } });
  await expect(readDefinitions(client(rpc),'workspace','project')).rejects.toThrow('denied or disconnected');
 });
 it('rejects malformed capability payloads', async () => {
  await expect(readDefinitions(client(vi.fn().mockResolvedValue({data:{available:true}})),'w','p')).rejects.toThrow('Invalid definition');
 });
 it('sends an explicit accepted source and expected revision without rewriting it', async () => {
  const rpc=vi.fn().mockResolvedValue({data:{id:'stable'}});
  await expect(publishDefinition(client(rpc),'p',{concept_id:'c',expected_revision:'r1',source_decision_id:'source',wording:' New wording ',refinement_ids:['linked']})).resolves.toEqual({id:'stable'});
  expect(rpc).toHaveBeenCalledWith('publish_knowledge_definition',{p_project_id:'p',p_concept_id:'c',p_expected_revision:'r1',p_source_decision_id:'source',p_wording:'New wording',p_metadata:{},p_refinement_ids:['linked'],p_provenance:null,p_conduction_id:null,p_leg:null});
 });
 it('surfaces a stale publication without retrying over the winner', async () => {
  const rpc=vi.fn().mockResolvedValue({error:{code:'40001',message:'definition changed'}});
  await expect(publishDefinition(client(rpc),'p',{concept_id:'c',expected_revision:'old',source_decision_id:'source',wording:'wording'})).rejects.toThrow('definition changed');
  expect(rpc).toHaveBeenCalledTimes(1);
 });
});
