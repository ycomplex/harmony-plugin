import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Lexer } from 'marked';
import { decodeHTML } from 'entities';
import GithubSlugger from 'github-slugger';
import { minimatch } from 'minimatch';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { configureProse, readProse, proseOperation } from '../tools/knowledge-prose.js';
const pattern=z.string().min(1).refine(s=>!s.startsWith('/')&&!s.split('/').includes('..')&&!s.includes('\\'),'Repository-relative patterns required');
export const selectorSchema=z.object({include:z.array(pattern).min(1),exclude:z.array(pattern).default([]),kind:z.enum(['document','skill']),scope:z.enum(['product','deployment']).nullable().default(null),domain:z.array(z.string()).default([]),tags:z.array(z.string()).default([]),bookkeeping:z.boolean().default(false)});
export const declarationSchema=z.object({version:z.literal(1),repository:z.string().url().refine(s=>s.startsWith('https://')),ref:z.string().min(1),sources:z.array(z.object({key:z.string().min(1),enabled:z.boolean().default(true),selectors:z.array(selectorSchema).min(1)})).min(1)});
export interface ProseChunk {path:string;anchor:string;heading:string;ancestry:string[];content:string;content_hash:string;kind:'document'|'skill';scope:'product'|'deployment'|null;domain:string[];tags:string[];bookkeeping:boolean}
const canonical=(value:unknown):string=>JSON.stringify(value,(_key,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
const git=(root:string,args:string[])=>execFileSync('git',['-C',root,...args],{maxBuffer:32*1024*1024});
const text=(tokens:unknown):string=>Array.isArray(tokens)?tokens.map((t:{type?:string;text?:string;tokens?:unknown;raw?:string})=>t.type==='html'?'':t.tokens?text(t.tokens):t.type==='codespan'?t.text??'':decodeHTML(t.text??t.raw??'')).join(''):'';
export function chunkMarkdown(path:string,body:string,selector:z.infer<typeof selectorSchema>):{chunks:ProseChunk[];diagnostics:string[]} {
 if(Buffer.byteLength(body)>1024*1024) return {chunks:[],diagnostics:[`${path}: file exceeds 1 MiB; skipped`]};
 const slugger=new GithubSlugger(), ancestry:Array<{depth:number;text:string}>=[];
 const chunks:ProseChunk[]=[],diagnostics:string[]=[];
 let heading=path,anchor='',section='',parents:string[]=[];
 const flush=()=>{if(!section.trim())return; if(section.length>24000){diagnostics.push(`${path}#${anchor}: section exceeds 24000 characters; skipped`);return;} chunks.push({path,anchor,heading,ancestry:parents,content:section,content_hash:createHash('sha256').update(section).digest('hex'),...selector});};
 for(const token of Lexer.lex(body)) {
  if(token.type==='heading') {
   flush();heading=text(token.tokens);anchor=slugger.slug(heading);section=token.raw;
   while(ancestry.length&&ancestry.at(-1)!.depth>=token.depth)ancestry.pop();
   ancestry.push({depth:token.depth,text:heading});parents=ancestry.map(x=>x.text);
  } else section+=token.raw;
 }
 flush();return {chunks,diagnostics};
}
/** Only immutable blobs are read; no checkout, symlink following, Markdown execution or repository network fetch. */
export function extractProse(root:string,commit:string,selectors:z.infer<typeof selectorSchema>[]) {
 const chunks:ProseChunk[]=[],diagnostics:string[]=[];
 for(const row of git(root,['ls-tree','-rz','--full-tree',commit]).toString().split('\0').filter(Boolean)) {
  const tab=row.indexOf('\t'),[mode,type,oid]=row.slice(0,tab).split(' '),path=row.slice(tab+1);
  const matches=selectors.filter(s=>s.include.some(p=>minimatch(path,p,{dot:true}))&&!s.exclude.some(p=>minimatch(path,p,{dot:true})));
  if(!matches.length)continue;
  if(matches.length!==1){diagnostics.push(`${path}: overlapping selectors; skipped`);continue;}
  if(mode!=='100644'&&mode!=='100755'||type!=='blob'){diagnostics.push(`${path}: symlink/submodule is not indexed`);continue;}
  const size=Number(git(root,['cat-file','-s',oid]).toString());
  if(size>1024*1024){diagnostics.push(`${path}: file exceeds 1 MiB; skipped`);continue;}
  const body=git(root,['cat-file','blob',oid]).toString('utf8');
  if(body.includes('\0')){diagnostics.push(`${path}: binary content; skipped`);continue;}
  const parsed=chunkMarkdown(path,body,matches[0]);chunks.push(...parsed.chunks);diagnostics.push(...parsed.diagnostics);
  if(chunks.length>10000)throw new Error('Source exceeds 10000 chunks; narrow configuration');
 }
 return {chunks,diagnostics:diagnostics.slice(0,1000)};
}
export async function syncProse(client:SupabaseClient,projectId:string,root:string,declarationPath='.harmony/prose-sources.json',requested='HEAD') {
 if(declarationPath.startsWith('/')||declarationPath.split('/').includes('..'))throw new Error('Declaration must be repository-relative');
 const commit=git(root,['rev-parse','--verify',`${requested}^{commit}`]).toString().trim();
 const declaration=declarationSchema.parse(JSON.parse(git(root,['show',`${commit}:${declarationPath}`]).toString()));
 // A local branch may be behind its remote; if present, require the selected commit is precisely the tracked ref.
 const refCommit=git(root,['rev-parse','--verify',`${declaration.ref}^{commit}`]).toString().trim();
 if(refCommit!==commit)throw new Error('Refresh commit does not match the configured tracked ref; fetch/update before refreshing');
 const origin=git(root,['remote','get-url','origin']).toString().trim().replace(/^git@([^:]+):/,'https://').replace(/\.git$|\/$/g,'');
 if(origin!==declaration.repository.replace(/\.git$|\/$/g,''))throw new Error('Repository identity differs from configured source');
 const read=await readProse(client,projectId);if(!read.available)throw new Error('Prose indexing capability is unavailable; no refresh attempted');
 const output:unknown[]=[];
 for(const spec of declaration.sources) {
  const config={selectors:spec.selectors};let source=read.sources.find(s=>s.source_key===spec.key);
  if(!source||source.repository!==declaration.repository||source.tracked_ref!==declaration.ref||source.enabled!==spec.enabled||canonical(source.config)!==canonical(config))source=await configureProse(client,projectId,{key:spec.key,repository:declaration.repository,ref:declaration.ref,config,enabled:spec.enabled,expected_revision:source?.revision??null});
  if(!spec.enabled)continue;
  if(source!.refresh_state==='current'&&source!.indexed_commit===commit){output.push({source_id:source!.id,unchanged:true});continue;}
  const priorCommit=source!.requested_commit??source!.indexed_commit;
  if(priorCommit)git(root,['merge-base','--is-ancestor',priorCommit,commit]);
  const started=await proseOperation(client,'begin_knowledge_prose_refresh',{p_source_id:source!.id,p_revision:source!.revision,p_ref:declaration.ref,p_commit:commit,p_expected_generation:source!.active_generation,p_expected_token:source!.refresh_token??null});
  try {const parsed=extractProse(root,commit,spec.selectors);output.push(await proseOperation(client,'publish_knowledge_prose',{p_source_id:source!.id,p_token:started.token,p_chunks:parsed.chunks,p_diagnostics:parsed.diagnostics,p_error:false}));}
  catch(error){await proseOperation(client,'publish_knowledge_prose',{p_source_id:source!.id,p_token:started.token,p_chunks:[],p_diagnostics:['Refresh failed; previous snapshot retained'],p_error:true});throw error;}
 }
 // Removing a declaration is an explicit disable, not an eternally searchable old source.
 for(const prior of read.sources.filter(s=>s.repository===declaration.repository&&s.tracked_ref===declaration.ref&&!declaration.sources.some(x=>x.key===s.source_key)&&s.enabled)) await configureProse(client,projectId,{key:prior.source_key,repository:prior.repository,ref:prior.tracked_ref,config:prior.config,expected_revision:prior.revision,enabled:false});
 return output;
}
