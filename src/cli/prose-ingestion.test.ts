import { describe,it,expect } from 'vitest';
import { chunkMarkdown,selectorSchema,extractProse } from './prose-ingestion.js';
import { mkdtempSync,writeFileSync,mkdirSync,symlinkSync,rmSync } from 'node:fs';
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
 it('explicitly reports oversized sections and files',()=>{
  expect(chunkMarkdown('a.md','# Rule\n'+'x'.repeat(25000),selector)).toEqual({chunks:[],diagnostics:['a.md#rule: section exceeds 24000 characters; skipped']});
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
