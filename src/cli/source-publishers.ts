import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { z } from 'zod';
import { sourceInventorySchema, type SourceInventory } from '../tools/knowledge-sources.js';
export const publisherDeclarationSchema=z.object({version:z.literal(1),repository:z.string().min(1),publishers:z.array(z.object({
 surface:z.string().min(1),command:z.array(z.string().min(1)).min(1),inputs:z.array(z.string().min(1)).min(1),publisher_version:z.string().min(1),
})).min(1)});
export type PublisherDeclaration=z.infer<typeof publisherDeclarationSchema>;
const git=(root:string,args:string[])=>execFileSync('git',['-C',root,...args],{encoding:'utf8',maxBuffer:10*1024*1024});
export function loadPublisherDeclaration(root:string,file='.harmony/source-publishers.json') {
 return publisherDeclarationSchema.parse(JSON.parse(readFileSync(resolve(root,file),'utf8')));
}
/** Executes trusted repository code only. Capture the inventory revision BEFORE calling this. */
export function runSourcePublisher(root:string,declaration:PublisherDeclaration,surface:string,expectedRevision:string|null,runId:string,runUrl:string,previousSha?:string):SourceInventory {
 root=realpathSync(root);
 const publisher=declaration.publishers.find(p=>p.surface===surface);
 if(!publisher) throw new Error(`Undeclared publisher: ${surface}`);
 if(declaration.publishers.filter(p=>p.surface===surface).length!==1) throw new Error('Duplicate surface declaration');
 const sha=git(root,['rev-parse','HEAD']).trim();
 if(previousSha) {
  try { git(root,['merge-base','--is-ancestor',previousSha,sha]); } catch { throw new Error('Published source is newer or divergent; update the checkout before regenerating'); }
 }
 const paths=new Set<string>();
 for(const input of publisher.inputs) {
  if(input.startsWith('/') || input.split('/').includes('..')) throw new Error('Inputs must be repository-relative');
  const matches=git(root,['ls-files','--',input]).trim().split('\n').filter(Boolean);
  if(!matches.length) throw new Error(`Publisher input matches no tracked sources: ${input}`);
  matches.forEach(path=>paths.add(path));
 }
 if(!paths.size) throw new Error('Publisher inputs match no tracked sources');
 // Every declared input is committed and readable; reject modified/untracked evidence rather than stamp it with HEAD.
 for(const path of paths) {
  const actual=readFileSync(resolve(root,path));
  const committed=execFileSync('git',['-C',root,'show',`${sha}:${path}`],{maxBuffer:10*1024*1024});
  if(!actual.equals(committed)) throw new Error(`Uncommitted publisher input: ${path}`);
 }
 const output=execFileSync(publisher.command[0],publisher.command.slice(1),{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
 const values=JSON.parse(output);
 if(!Array.isArray(values)) throw new Error('Publisher must emit a JSON value array');
 const inventory=sourceInventorySchema.parse({repository:declaration.repository,surface,expected_revision:expectedRevision,run_id:runId,source_sha:sha,
  values:values.map(v=>({...v,source:{...v.source,repository:declaration.repository,sha,publisher:surface,publisher_version:publisher.publisher_version,run_url:runUrl}}))});
 for(const path of paths) {
  if(!readFileSync(resolve(root,path)).equals(execFileSync('git',['-C',root,'show',`${sha}:${path}`],{maxBuffer:10*1024*1024}))) throw new Error(`Publisher mutated input: ${path}`);
 }
 for(const value of inventory.values) {
  const path=value.source.path;
  const local=relative(root,realpathSync(resolve(root,path)));
  if(isAbsolute(local)||local.startsWith('..')||!paths.has(path)) throw new Error(`Source is outside declared inputs: ${path}`);
  // Recheck after executing the publisher: a generator must not mutate its own evidence.
  if(!readFileSync(resolve(root,path)).equals(execFileSync('git',['-C',root,'show',`${sha}:${path}`],{maxBuffer:10*1024*1024}))) throw new Error(`Publisher mutated source: ${path}`);
  const lines=readFileSync(resolve(root,path),'utf8').split('\n').length;
  if(value.source.line_start && value.source.line_start>lines || value.source.line_end && value.source.line_end>lines) throw new Error(`Source span outside file: ${path}`);
 }
 return inventory;
}
