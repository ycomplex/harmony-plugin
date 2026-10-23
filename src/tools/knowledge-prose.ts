import type { SupabaseClient } from '@supabase/supabase-js';
export interface ProsePointer { part_index?: number; entry_id?: string; source_id: string; repository?: string; path: string; anchor: string; commit: string; linked_commit?: string; resolved?: boolean }
export interface ProseSource { id:string; source_key:string; repository:string; tracked_ref:string; config:unknown; revision:string; active_generation:string|null; indexed_commit?:string|null; refresh_token?:string|null; enabled:boolean; refresh_state:string; requested_commit:string|null; diagnostics:unknown[] }
export interface ProseRead { chunk_parts?:boolean; available:boolean; sources:ProseSource[]; pointers:ProsePointer[] }
export function proseLink(p:Pick<ProsePointer,'repository'|'path'|'commit'|'anchor'>):string|undefined {
 if(!p.repository || !/^https:\/\//.test(p.repository)) return undefined;
 return `${p.repository.replace(/\.git$|\/$/g,'')}/blob/${encodeURIComponent(p.commit)}/${p.path.split('/').map(encodeURIComponent).join('/')}#${encodeURIComponent(p.anchor)}`;
}
export async function proseOperation(client:SupabaseClient,name:string,args:Record<string,unknown>) {
 const {data,error}=await client.rpc(name,args);
 if(error) throw new Error(['PGRST202','42883'].includes(error.code)?'Prose indexing capability is unavailable; nothing was saved.':error.message);
 return data;
}
export async function readProse(client:SupabaseClient,projectId:string,ids:string[]=[]):Promise<ProseRead> {
 const {data,error}=await client.rpc('read_knowledge_prose',{p_project_id:projectId,p_entry_ids:ids});
 if(error) { if(['PGRST202','42883'].includes(error.code)) return {available:false,sources:[],pointers:[]}; throw new Error(error.message); }
 if(data?.available!==true || !Array.isArray(data.sources)||!Array.isArray(data.pointers)) throw new Error('Invalid prose capability response');
 return data;
}
export async function setDefinedIn(client:SupabaseClient,projectId:string,args:{entry_id:string;pointer:ProsePointer|null}) {
 return proseOperation(client,'set_knowledge_defined_in',{p_project_id:projectId,p_entry_id:args.entry_id,p_pointer:args.pointer});
}
export async function configureProse(client:SupabaseClient,projectId:string,args:{key:string;repository:string;ref:string;config:unknown;expected_revision:string|null;enabled?:boolean}) {
 return proseOperation(client,'configure_knowledge_prose',{p_project_id:projectId,p_key:args.key,p_repository:args.repository,p_ref:args.ref,p_config:args.config,p_expected_revision:args.expected_revision,p_enabled:args.enabled!==false});
}
export const proseTools=[
 {name:'read_prose_sources',description:'Read configured source coverage and exact defined-in resolution. Missing indexing is explicit; no source is ratified by indexing.',inputSchema:{type:'object',properties:{entry_ids:{type:'array',items:{type:'string'}}}}},
 {name:'configure_prose_source',description:'Register, update or disable one project source. Supply revision read before changing configuration. Selectors declare include/exclude, document/skill kind, explicit scope, domains, registered tags and bookkeeping. Configuration changes invalidate the old index until refresh.',inputSchema:{type:'object',properties:{key:{type:'string'},repository:{type:'string'},ref:{type:'string'},config:{type:'object'},expected_revision:{type:['string','null']},enabled:{type:'boolean'}},required:['key','repository','ref','config','expected_revision']}},
 {name:'set_defined_in',description:'Attach or explicitly remove an entry’s source-heading pointer. Target must be current and in this project. Refresh never silently retargets renamed/deleted headings.',inputSchema:{type:'object',properties:{entry_id:{type:'string'},pointer:{type:['object','null'],properties:{source_id:{type:'string'},path:{type:'string'},anchor:{type:'string'},commit:{type:'string'}},required:['source_id','path','anchor','commit']}},required:['entry_id','pointer']}},
];
