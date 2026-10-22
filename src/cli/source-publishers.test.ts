import { describe,it,expect } from 'vitest';
import { mkdtempSync,writeFileSync,rmSync,cpSync,mkdirSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { publisherDeclarationSchema,runSourcePublisher } from './source-publishers.js';
describe('trusted source publishers',()=>{
 it('regenerates real values from committed source and refuses dirty or undeclared evidence',()=>{
  const root=mkdtempSync(join(tmpdir(),'source-publisher-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  try {
   git('init');git('config','user.email','test@example.test');git('config','user.name','Test');
   writeFileSync(join(root,'config.json'),'{"timeout":30}');
   writeFileSync(join(root,'publisher.cjs'),`const fs=require('node:fs');const timeout=JSON.parse(fs.readFileSync('config.json')).timeout; console.log(JSON.stringify([{key:'timeout',kind:'default',title:'Timeout',content:String(timeout),spellings:['--timeout'],source:{path:'config.json'}}]));`);
   git('add','.');git('commit','-m','fixture');
   const declaration=publisherDeclarationSchema.parse({version:1,repository:'o/r',publishers:[{surface:'config',command:['node','publisher.cjs'],inputs:['config.json','publisher.cjs'],publisher_version:'1'}]});
   const first=runSourcePublisher(root,declaration,'config',null,'1','https://ci.test/1');
   expect(first.values[0].content).toBe('30');
   writeFileSync(join(root,'config.json'),'{"timeout":60}');
   expect(()=>runSourcePublisher(root,declaration,'config',null,'2','https://ci.test/2')).toThrow('Uncommitted');
   git('add','.');git('commit','-m','source changed');
   const second=runSourcePublisher(root,declaration,'config',null,'2','https://ci.test/2');
   expect(second.values[0].content).toBe('60');expect(second.source_sha).not.toBe(first.source_sha);
   expect(()=>runSourcePublisher(root,declaration,'other',null,'2','https://ci.test/2')).toThrow('Undeclared');
   declaration.publishers[0].inputs=['publisher.cjs'];
   expect(()=>runSourcePublisher(root,declaration,'config',null,'2','https://ci.test/2')).toThrow('outside declared inputs');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
 it('regenerates the executable five-kind specimen in CI from committed sources',()=>{
  const root=mkdtempSync(join(tmpdir(),'five-kind-publisher-'));
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
  try {
   mkdirSync(join(root,'examples'),{recursive:true});
   cpSync(resolve('examples/source-values'),join(root,'examples/source-values'),{recursive:true});
   symlinkSync(resolve('node_modules'),join(root,'node_modules'));
   git('init');git('config','user.email','test@example.test');git('config','user.name','Test');
   git('add','examples');git('commit','-m','source specimen');
   const declaration=publisherDeclarationSchema.parse({version:1,repository:'o/r',publishers:[{surface:'example-config',command:['node','examples/source-values/publish.mjs'],inputs:['examples/source-values/*'],publisher_version:'1'}]});
   const inventory=runSourcePublisher(root,declaration,'example-config',null,'ci-run','https://ci.test/run');
   expect(inventory.values.map(v=>v.kind)).toEqual(['default','error','file-shape','explanation','measurement']);
   expect(inventory.values[0].content).toBe('timeout defaults to 30');
   expect(inventory.values[1].content).toContain('schema unavailable');
   expect(inventory.values[2].content).toContain('ZodNumber');
   expect(inventory.values[3].content).toContain('stale inventory revision');
   expect(inventory.values[4].source.measurement?.result).toMatchObject({elapsed_ms:expect.any(Number)});
  } finally {rmSync(root,{recursive:true,force:true});}
 });

});
