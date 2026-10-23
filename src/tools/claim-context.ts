import type { SupabaseClient } from '@supabase/supabase-js';
export interface QuestionReference { exchange_id: string; round: number; question_id: string }
export interface ClaimContext {
 claim_id: string;
 question_state: 'available' | 'question-unavailable' | 'capability-unavailable';
 questions: Array<QuestionReference & { text: string; statement: string | null; source_task_id: string; source_visual_id: string }>;
 concepts: Array<{ id: string; name: string }>;
}
export const missingClaimContext = (error: { code?: string; message: string }) =>
 (error.code === 'PGRST202' || error.code === '42883') && error.message.includes('read_claim_context');
export async function readClaimContexts(client: SupabaseClient, ids: string[]): Promise<{ available: boolean; contexts: ClaimContext[] }> {
 const contexts: ClaimContext[] = [];
 // Empty input also probes the separately named capability before atomic capture.
 for (let start = 0; start < Math.max(1, ids.length); start += 500) {
  const { data, error } = await client.rpc('read_claim_context', { p_claim_ids: ids.slice(start,start+500) });
  if (error) {
   if (missingClaimContext(error)) return { available: false, contexts: [] };
   throw new Error(`Cannot read claim context: ${error.message}`);
  }
  if (data?.available !== true || !Array.isArray(data.contexts)) throw new Error('Invalid claim context response');
  contexts.push(...data.contexts);
 }
 return { available: true, contexts };
}
export async function withClaimContexts<T extends { id: string }>(client: SupabaseClient, entries: T[]): Promise<Array<T & { claim_context?: ClaimContext }>> {
 if (!entries.length) return entries;
 const read = await readClaimContexts(client, entries.map(e=>e.id));
 const byId = new Map(read.contexts.map(c=>[c.claim_id,c]));
 return entries.map(e=>({...e,claim_context:read.available ? byId.get(e.id) : {claim_id:e.id,question_state:'capability-unavailable',questions:[],concepts:[]}}));
}

export async function setClaimContext(client: SupabaseClient, projectId: string, args: {
 claim_id: string; questions: QuestionReference[]; concept_ids: string[]; correction_reason?: string;
}) {
 const { data: claim, error: readError } = await client.from('knowledge_decisions').select('id').eq('id',args.claim_id).eq('project_id',projectId).single();
 if (readError || !claim) throw new Error('Claim must belong to the current authorized project');
 const capability = await readClaimContexts(client, []);
 if (!capability.available) throw new Error('Claim context is not available in this environment yet.');
 const { data, error } = await client.rpc('set_claim_context', { p_claim_id:args.claim_id,p_questions:args.questions,p_concept_ids:args.concept_ids,p_correction_reason:args.correction_reason ?? null });
 if (error) throw new Error(`Cannot set claim context: ${error.message}`);
 return data;
}
export const setClaimContextTool = {
 name:'set_claim_context',description:'Explicitly attach an elicitation claim to source-verified questions and confirmed existing concept UUIDs. No concept guessing. Replacement requires correction_reason and retains prior context in audit history. Does not change claim trust or lifecycle.',
 inputSchema:{type:'object' as const,properties:{claim_id:{type:'string'},questions:{type:'array',items:{type:'object',properties:{exchange_id:{type:'string'},round:{type:'integer'},question_id:{type:'string'}},required:['exchange_id','round','question_id']}},concept_ids:{type:'array',items:{type:'string'}},correction_reason:{type:'string'}},required:['claim_id','questions','concept_ids']},
};
