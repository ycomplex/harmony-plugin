import { describe,it,expect,vi } from 'vitest';
import { chunkMarkdown,selectorSchema,extractProse,syncProse,MAX_PROSE_CHUNK_CHARACTERS } from './prose-ingestion.js';
import { mkdtempSync,writeFileSync,mkdirSync,symlinkSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const selector=selectorSchema.parse({include:['**/*.md'],kind:'document',scope:'product'});
describe('immutable prose ingestion',()=>{
 it('preserves preamble, ancestry, Unicode and duplicate GitHub anchors; fenced examples are not headings',()=>{
  const result=chunkMarkdown('guide.md','Preamble\n\n# Café\n\nRule\n\n```md\n# Fake\n```\n\n## Child\n\nOne\n\n# Café\n\nTwo',selector);
  expect(result.chunks.map(c=>c.anchor)).toEqual(['','café','child','café-1']);
  expect(result.chunks[2].ancestry).toEqual(['Café','Child']);expect(result.chunks[1].content).toContain('# Fake');
 });
 it('explicitly reports oversized files',()=>{
  expect(chunkMarkdown('a.md','x'.repeat(1100000),selector).diagnostics[0]).toContain('1 MiB');
 });
 it('uses rendered heading text for entities and preserves code-span literals',()=>{
  const result=chunkMarkdown('guide.md','# A &amp; B &#233;\nText\n\n# `&amp;`\nLiteral',selector);
  expect(result.chunks[0].heading).toBe('A & B é');expect(result.chunks[0].anchor).toBe('a--b-é');expect(result.chunks[1].anchor).toBe('amp');
 });
 it('rejects traversal selectors',()=>{expect(()=>selectorSchema.parse({include:['../secret'],kind:'skill'})).toThrow();});
 it('reads committed blobs, excludes escaping symlinks, and replaces deleted/renamed sections in a second project fixture',()=>{
  const root=mkdtempSync(join(tmpdir(),'prose-other-project-'));const git=(...args:string[])=>execFileSync('git',['-C',root,...args]).toString().trim();
  try{git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');mkdirSync(join(root,'docs'));writeFileSync(join(root,'docs/guide.md'),'# First\nRule');symlinkSync('/etc/passwd',join(root,'docs/escape.md'));git('add','.');git('commit','-m','snapshot');const first=git('rev-parse','HEAD');
   writeFileSync(join(root,'docs/guide.md'),'# Renamed\nNew rule');git('add','.');git('commit','-m','rename');
   const old=extractProse(root,first,[selector]),current=extractProse(root,'HEAD',[selector]);
   expect(old.chunks[0].anchor).toBe('first');expect(current.chunks[0].anchor).toBe('renamed');expect(old.diagnostics[0]).toContain('symlink');
   rmSync(join(root,'docs/guide.md'));git('add','.');git('commit','-m','delete');expect(extractProse(root,'HEAD',[selector]).chunks).toEqual([]);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});


describe('bounded source sections',()=>{
 const assertComplete=(body:string)=>{
  const result=chunkMarkdown('guide.md',body,selector);
  expect(result.diagnostics).toEqual([]);
  expect(result.chunks.map(c=>c.content).join('')).toBe(body);
  for(const chunk of result.chunks) {
   expect(chunk.content.length).toBeGreaterThan(0);
   expect(chunk.content.length).toBeLessThanOrEqual(MAX_PROSE_CHUNK_CHARACTERS);
   expect(chunk.content).not.toMatch(/[\uD800-\uDBFF]$/);
   expect(chunk.content).not.toMatch(/^[\uDC00-\uDFFF]/);
  }
  expect(chunkMarkdown('guide.md',body,selector)).toEqual(result);
  return result.chunks;
 };
 it('keeps small-section payloads compatible and only adds part identities when needed',()=>{
  const [small]=assertComplete('# Rule\nSmall.\n');
  expect(small).not.toHaveProperty('part_index');
  const chunks=assertComplete('# Rule\n'+'x'.repeat(50000));
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map(c=>c.part_index)).toEqual(chunks.map((_,i)=>i));
  expect(chunks.every(c=>c.anchor==='rule'&&c.heading==='Rule'&&c.ancestry.join('/')==='Rule')).toBe(true);
 });
 it('retains the source heading hierarchy while recursively bounding oversized children',()=>{
  const chunks=assertComplete('# Parent\nIntro.\n\n## Child\n'+('child paragraph '.repeat(500)+'\n\n').repeat(6)+'### Grandchild\nTail.\n');
  const children=chunks.filter(c=>c.anchor==='child');
  expect(children.length).toBeGreaterThan(1);
  expect(children.every(c=>c.ancestry.join('/')==='Parent/Child')).toBe(true);
  expect(chunks.at(-1)?.ancestry).toEqual(['Parent','Child','Grandchild']);
 });
 it('packs paragraphs without cutting them when each fits and retains repeated identical parts',()=>{
  const paragraph='Same paragraph '.repeat(500)+'\n\n';
  const chunks=assertComplete(paragraph.repeat(12));
  expect(chunks.every(c=>c.content.endsWith('\n\n'))).toBe(true);
  expect(new Set(chunks.map(c=>c.part_index)).size).toBe(chunks.length);
  expect(new Set(chunks.map(c=>c.content_hash)).size).toBeLessThan(chunks.length);
 });
 it('falls back without loss for long Unicode paragraphs and nested list blocks',()=>{
  assertComplete('# Astral\n'+'x'.repeat(23999)+'😀'.repeat(25000));
  assertComplete('# Nested\n'+Array.from({length:90},(_,i)=>`- item ${i}\n\n  ${'nested text '.repeat(90)}\n\n`).join(''));
 });
 it('bounds huge headings and preambles and keeps duplicate real anchors distinct',()=>{
  assertComplete('# '+ 'h'.repeat(50000)+'\nTail');
  const chunks=assertComplete('preamble '.repeat(4000)+'\n\n# Same\n'+'a'.repeat(25000)+'\n\n# Same\n'+'b'.repeat(25000));
  expect(new Set(chunks.map(c=>c.anchor))).toEqual(new Set(['','same','same-1']));
  expect(new Set(chunks.map(c=>`${c.anchor}:${c.part_index??0}`)).size).toBe(chunks.length);
 });
 it.each([
  ['finish-work','o1-confirm-the-release-decision-accept-clears-the-gate--it-does-not-release-yet'],
  ['finish-work','o2-run-the-merge--deploy-then-advance-to-deployed'],
  ['harmony-conduct','2-the-loop'],
  ['start-work','o3-build-planned--built'],
 ])('covers the real %s oversized section %s', (skill,anchor)=>{
  const body=readFileSync(new URL(`../../skills/${skill}/SKILL.md`,import.meta.url),'utf8');
  const chunks=assertComplete(body).filter(c=>c.anchor===anchor);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.map(c=>c.content).join('').length).toBeGreaterThan(MAX_PROSE_CHUNK_CHARACTERS);
  expect(chunks.every(c=>c.heading===chunks[0].heading&&JSON.stringify(c.ancestry)===JSON.stringify(chunks[0].ancestry))).toBe(true);
 });
});

describe('multi-part publication compatibility',()=>{
 const fixture=()=>{
  const root=mkdtempSync(join(tmpdir(),'prose-parts-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'}).toString().trim();
  git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('remote','add','origin','https://example.invalid/prose');
  mkdirSync(join(root,'.harmony'));writeFileSync(join(root,'.harmony/prose-sources.json'),JSON.stringify({version:1,repository:'https://example.invalid/prose',ref:'HEAD',sources:[{key:'docs',selectors:[selector]}]}));
  writeFileSync(join(root,'guide.md'),'# Rule\n'+'quasar '.repeat(6000));git('add','.');git('commit','-m','fixture');
  const source={id:'source',source_key:'docs',repository:'https://example.invalid/prose',tracked_ref:'HEAD',config:{selectors:[selector]},revision:'revision',active_generation:'previous',indexed_commit:null,refresh_token:null,enabled:true,refresh_state:'failed',requested_commit:null,diagnostics:[]};
  return {root,source};
 };
 it.each([undefined,false])('refuses an unsupported database (%s) before beginning or publishing any generation',async(chunk_parts)=>{
  const {root,source}=fixture();
  const rpc=vi.fn().mockResolvedValue({data:{available:true,chunk_parts,sources:[source],pointers:[]},error:null});
  try {
   await expect(syncProse({rpc} as never,'project',root)).rejects.toThrow('Previous snapshot retained');
   expect(rpc.mock.calls.map(c=>c[0])).toEqual(['read_knowledge_prose']);
  } finally {rmSync(root,{recursive:true,force:true});}
 });
 it('publishes one complete bounded generation and reports publisher failure without replacing the prior snapshot',async()=>{
  const {root,source}=fixture();
  const rpc=vi.fn().mockImplementation(async(name:string,args:Record<string,unknown>)=>{
   if(name==='read_knowledge_prose')return {data:{available:true,chunk_parts:true,sources:[source],pointers:[]},error:null};
   if(name==='begin_knowledge_prose_refresh')return {data:{token:'token'},error:null};
   if(args.p_error)return {data:{published:false},error:null};
   return {data:null,error:{code:'40001',message:'stale publisher'}};
  });
  try {
   await expect(syncProse({rpc} as never,'project',root)).rejects.toThrow('stale publisher');
   const publish=rpc.mock.calls.filter(c=>c[0]==='publish_knowledge_prose');
   expect(publish).toHaveLength(2);
   const payload=publish[0][1].p_chunks as ReturnType<typeof chunkMarkdown>['chunks'];
   expect(payload.length).toBeGreaterThan(1);
   expect(payload.every(c=>c.content.length<=24000&&c.anchor==='rule')).toBe(true);
   expect(payload.map(c=>c.content).join('')).toBe(readFileSync(join(root,'guide.md'),'utf8'));
   expect(publish[1][1]).toMatchObject({p_error:true,p_chunks:[]});
  } finally {rmSync(root,{recursive:true,force:true});}
 });
});
