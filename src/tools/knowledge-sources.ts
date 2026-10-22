import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { metadataCapable } from './knowledge-metadata.js';
import { getConductionId, getLeg } from '../config/run-config.js';

const text = z.string().trim().min(1);
export const sourceValueSchema = z.object({
 key: text, kind: z.enum(['default','error','file-shape','measurement','explanation']), title: text, content: text,
 spellings: z.array(text).min(1), tags: z.array(text).optional(),
 source: z.object({
  path: text.refine(p => !p.startsWith('/') && !p.split('/').includes('..'), 'Source path must be repository-relative'),
  sha: z.string().regex(/^[a-f0-9]{40,64}$/), publisher: text, publisher_version: text, run_url: text,
  line_start: z.number().int().positive().optional(), line_end: z.number().int().positive().optional(),
  measurement: z.object({command: text, parameters: z.unknown(), tool_versions: z.unknown(), result: z.unknown()}).optional(),
 }).passthrough(),
}).strict().superRefine((v,ctx) => {
 if(v.kind==='measurement' && !v.source.measurement) ctx.addIssue({code:'custom',message:'Measurement requires command, parameters, tool versions and captured result'});
 if(v.source.line_end && v.source.line_start && v.source.line_end < v.source.line_start) ctx.addIssue({code:'custom',message:'Invalid source line span'});
});
export type SourceValue = z.infer<typeof sourceValueSchema>;
export const sourceInventorySchema = z.object({
 repository:text, surface:text, expected_revision:z.string().uuid().nullable(), run_id:text, source_sha:z.string().regex(/^[a-f0-9]{40,64}$/),
 values:z.array(sourceValueSchema).max(1000),
}).strict().superRefine((v,ctx) => {
 if(new Set(v.values.map(x=>x.key)).size!==v.values.length) ctx.addIssue({code:'custom',message:'Duplicate inventory keys'});
 if(v.values.some(x=>x.source.sha!==v.source_sha)) ctx.addIssue({code:'custom',message:'Source revision mismatch'});
});
export type SourceInventory = z.infer<typeof sourceInventorySchema>;
export async function sourceCapable(client:SupabaseClient) {
 const {data,error}=await client.rpc('knowledge_source_capable');
 if(error) {
  if(['PGRST202','42883'].includes(error.code)) return false;
  throw new Error(error.message);
 }
 if(typeof data!=='boolean') throw new Error('Invalid source inventory capability response');
 return data;
}
async function requireSources(client:SupabaseClient) {
 if(!await metadataCapable(client) || !await sourceCapable(client)) throw new Error('Source publication unavailable until metadata and inventory schema are promoted; nothing was saved.');
}
export async function publishSourceInventory(client:SupabaseClient,projectId:string,args:SourceInventory) {
 const inventory=sourceInventorySchema.parse(args);
 await requireSources(client);
 const {data,error}=await client.rpc('publish_knowledge_source_inventory',{
  p_project_id:projectId,p_repository:inventory.repository,p_surface:inventory.surface,p_expected_revision:inventory.expected_revision,
  p_run_id:inventory.run_id,p_source_sha:inventory.source_sha,p_values:inventory.values,p_conduction_id:getConductionId()??null,p_leg:getLeg()??null,
 });
 if(error) throw new Error([error.message,error.details].filter(Boolean).join('\n'));
 return data;
}
export async function readSourceInventory(client:SupabaseClient,projectId:string,args:{repository:string;surface:string}):Promise<{revision:string|null;source_sha?:string;values:SourceValue[]}> {
 await requireSources(client);
 const {data,error}=await client.rpc('read_knowledge_source_inventory',{p_project_id:projectId,p_repository:args.repository,p_surface:args.surface});
 if(error) throw new Error(error.message);
 return data??{revision:null,values:[]};
}
export interface GeneratedEntry { id:string;title:string;content:string;kind:'source-value';type:string;status:string;scope:'deployment';source_type:'generated';source:SourceValue['source'];inventory_key:string;inventory_revision:string;domain:string[];tags:string[];project_id:string;updated_at:string }
export async function readSourceValues(client:SupabaseClient,projectId:string,args:{search?:string;limit?:number;offset?:number}={}):Promise<{values:GeneratedEntry[];total_count:number}> {
 const requested=args.limit??50, offset=args.offset??0;
 if(!Number.isInteger(requested)||requested<0||!Number.isInteger(offset)||offset<0) throw new Error('Invalid source value page');
 const values:GeneratedEntry[]=[];
 let total_count=0;
 while(values.length<requested) {
  const size=Math.min(500,requested-values.length);
  const {data,error}=await client.rpc('read_knowledge_source_values',{p_project_id:projectId,p_search:args.search??null,p_limit:size,p_offset:offset+values.length});
  if(error) {
   // Only ordinary retrieval can omit an undeployed additive source. Explicit operations refuse.
   if(['PGRST202','42883'].includes(error.code)) return {values:[],total_count:0};
   throw new Error(error.message);
  }
  if(!data || !Array.isArray(data.values) || !Number.isInteger(data.total_count)) throw new Error('Invalid source values response');
  values.push(...data.values);total_count=data.total_count;
  if(data.values.length<size) break;
 }
 return {values,total_count};
}
/** Literal, case-sensitive mentions. Escape punctuation and require identifier boundaries. */
export function compareSourceCoverage(values:SourceValue[],current:string,previous?:string,revision?:string|null) {
 const mentioned=(document:string,spelling:string) => {
  const escaped=spelling.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped}(?![\\p{L}\\p{N}_-])`,'u').test(document);
 };
 const rows=values.map(v=>({key:v.key,source:v.source,matched_spellings:v.spellings.filter(s=>mentioned(current,s)),previous_spellings:previous===undefined?[]:v.spellings.filter(s=>mentioned(previous,s))}));
 return {coverage:'explicit-mention coverage; not proof of semantic completeness',inventory_revision:revision??null,
  mentioned:rows.filter(r=>r.matched_spellings.length),missing:rows.filter(r=>!r.matched_spellings.length),
  lost:rows.filter(r=>!r.matched_spellings.length && r.previous_spellings.length)};
}
export async function comparePublishedCoverage(client:SupabaseClient,projectId:string,args:{repository:string;surface:string;current:string;previous?:string}) {
 const inventory=await readSourceInventory(client,projectId,args);
 if(!inventory.revision) throw new Error('No published inventory for this repository/surface');
 return compareSourceCoverage(inventory.values,args.current,args.previous,inventory.revision);
}
export const sourceTools = [
 {name:'publish_source_inventory',description:'Atomically replace a complete deployment source inventory. Generated facts remain Asserted, with source provenance. Read the revision BEFORE extraction; stale snapshots refuse. Missing schema refuses.',inputSchema:{type:'object',properties:{repository:{type:'string'},surface:{type:'string'},expected_revision:{type:['string','null']},run_id:{type:'string'},source_sha:{type:'string'},values:{type:'array',maxItems:1000,items:{type:'object',properties:{key:{type:'string'},kind:{type:'string',enum:['default','error','file-shape','measurement','explanation']},title:{type:'string'},content:{type:'string'},spellings:{type:'array',minItems:1,items:{type:'string'}},tags:{type:'array',items:{type:'string'}},source:{type:'object',properties:{path:{type:'string'},sha:{type:'string'},publisher:{type:'string'},publisher_version:{type:'string'},run_url:{type:'string'},line_start:{type:'integer'},line_end:{type:'integer'},measurement:{type:'object',properties:{command:{type:'string'},parameters:{},tool_versions:{},result:{}},required:['command','parameters','tool_versions','result']}},required:['path','sha','publisher','publisher_version','run_url']}},required:['key','kind','title','content','spellings','source']}}},required:['repository','surface','expected_revision','run_id','source_sha','values']}},
 {name:'read_source_inventory',description:'Read current source values, provenance and the revision needed before extraction.',inputSchema:{type:'object',properties:{repository:{type:'string'},surface:{type:'string'}},required:['repository','surface']}},
 {name:'compare_source_coverage',description:'Report exact case-sensitive option mentions, omissions and losses from a previous document against the current published inventory. Does not prove semantic completeness.',inputSchema:{type:'object',properties:{repository:{type:'string'},surface:{type:'string'},current:{type:'string'},previous:{type:'string'}},required:['repository','surface','current']}},
];
