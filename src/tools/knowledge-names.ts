import { resolveTaskId } from './resolve-task-id.js';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface RetiredName { name: string; retired_at: string; source_task_id: string; actor: string | null }
export interface NameMatch { kind?: string; concept_id: string; current_name: string; matched_alias: string | null; definition: { id: string; current_revision: string | null } | null; state: 'current-definition' | 'no-current-definition'; names: RetiredName[] }
export interface WordingMatch { retired_term: string; concept_id: string; current_name: string }
export interface NameRead { available: boolean; matches: NameMatch[]; entries: Array<{ entry_id: string; uses_retired_term: boolean; matches: WordingMatch[] }>; identities: Array<{ original_id: string; concept_id: string; current_name: string }> }
function missing(error: { code?: string; message: string }, operation: string) {
 return ['PGRST202','42883'].includes(error.code ?? '') && error.message.includes(operation);
}
async function invoke(client: SupabaseClient, operation: string, args: Record<string, unknown>, optional = false) {
 const { data, error } = await client.rpc(operation,args);
 if (error) {
  if (missing(error,operation)) {
   if (optional) return undefined;
   throw new Error('Name history is not available in this environment yet.');
  }
  throw new Error(`Concept name operation failed: ${error.message}`);
 }
 if(data===null || data===undefined) throw new Error('Invalid concept name capability response');
 return data;
}
export async function readKnowledgeNames(client: SupabaseClient, projectId: string, args: { search?: string; entry_ids?: string[]; entity_ids?: string[] } = {}): Promise<NameRead> {
 const data = await invoke(client,'read_knowledge_names',{p_project_id:projectId,p_search:args.search ?? null,p_entry_ids:args.entry_ids ?? [],p_entity_ids:args.entity_ids ?? []},true);
 if (data === undefined) return { available:false,matches:[],entries:[],identities:[] };
 if (data?.available!==true || !Array.isArray(data.matches) || !Array.isArray(data.entries) || !Array.isArray(data.identities)) throw new Error('Invalid concept name capability response');
 return data;
}
export async function renameKnowledgeConcept(client: SupabaseClient, projectId: string, args: { concept_id: string; expected_name: string; new_name: string; source_task_id: string; operation_key: string }) {
 return invoke(client,'rename_knowledge_concept',{p_project_id:projectId,p_entity_id:args.concept_id,p_expected_name:args.expected_name,p_new_name:args.new_name,p_source_task_id:await resolveTaskId(client,projectId,args.source_task_id),p_operation_key:args.operation_key});
}
export async function previewKnowledgeMerge(client: SupabaseClient, projectId: string, args: { source_id: string; target_id: string; source_task_id: string }) {
 return invoke(client,'preview_knowledge_merge',{p_project_id:projectId,p_source:args.source_id,p_target:args.target_id,p_source_task_id:await resolveTaskId(client,projectId,args.source_task_id)});
}
export async function mergeKnowledgeConcepts(client: SupabaseClient, projectId: string, args: { source_id: string; target_id: string; source_task_id: string; confirmation: string }) {
 if (!args.confirmation?.trim()) throw new Error('An explicit preview confirmation is required');
 return invoke(client,'merge_knowledge_concepts',{p_project_id:projectId,p_source:args.source_id,p_target:args.target_id,p_source_task_id:await resolveTaskId(client,projectId,args.source_task_id),p_confirmation:args.confirmation});
}
const property = (description: string) => ({type:'string',description});
const mergeProperties = {source_id:property('Source identity UUID to retire in place'),target_id:property('Surviving current identity UUID'),source_task_id:property('Authorizing ticket UUID or visual ID in this project')};
export const knowledgeNameTools = [
 {name:'read_concept_names',description:'Exact current/retired name lookup, bounded retired-word scans and transitive historical identity resolution. Missing capability is explicit, never a clean scan. At most 500 entry or entity UUIDs per call.',inputSchema:{type:'object' as const,properties:{search:property('Exact name, ignoring case and surrounding whitespace'),entry_ids:{type:'array',items:{type:'string'}},entity_ids:{type:'array',items:{type:'string'}}}}},
 {name:'rename_concept',description:'Explicit atomic rename with expected current name, source ticket and idempotency key. Collisions never merge identities.',inputSchema:{type:'object' as const,properties:{concept_id:property('Concept UUID'),expected_name:property('Exact current name'),new_name:property('New canonical name'),source_task_id:property('Authorizing ticket UUID or visual ID'),operation_key:property('Unique idempotency key; never reuse with different inputs')},required:['concept_id','expected_name','new_name','source_task_id','operation_key']}},
 {name:'preview_concept_merge',description:'Inventory every mutable reference and immutable historical event before an explicit merge. Returns blockers and a confirmation bound to this inventory and source ticket.',inputSchema:{type:'object' as const,properties:mergeProperties,required:Object.keys(mergeProperties)}},
 {name:'merge_concepts',description:'Execute a reviewed preview using its confirmation; stale inventories and conflicts refuse atomically. Retains source row and original event ids; resolves retired identity transitively. Never use as an implicit rename collision fallback.',inputSchema:{type:'object' as const,properties:{...mergeProperties,confirmation:property('Exact reviewed preview confirmation')},required:[...Object.keys(mergeProperties),'confirmation']}},
];

/** Every result page is scanned by explicit ids; absent capability is never a clean result. */
export async function withRetiredWording<T extends { id: string }>(client: SupabaseClient, projectId: string, entries: T[]): Promise<T[]> {
 const result: T[]=[];
 for (let i=0;i<entries.length;i+=500) {
  const page=entries.slice(i,i+500);
  const read=await readKnowledgeNames(client,projectId,{entry_ids:page.map(e=>e.id)});
  for (const entry of page) {
   const scan=read.entries.find(s=>s.entry_id===entry.id);
   result.push(Object.assign({},entry,{name_history_available:read.available},scan?{uses_retired_term:scan.uses_retired_term,retired_term_matches:scan.matches}:{}));
  }
 }
 return result;
}
