/** Real local-stack smoke. This intentionally cannot target a hosted board. */
import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, cpSync, mkdirSync, symlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { runSourcePublisher, loadPublisherDeclaration } from '../src/cli/source-publishers.js';
import { publishSourceInventory, readSourceInventory, comparePublishedCoverage } from '../src/tools/knowledge-sources.js';
import { queryKnowledge } from '../src/tools/knowledge.js';
delete process.env.HARMONY_CONDUCTION_ID;
delete process.env.HARMONY_LEG;
const client=createClient('http://127.0.0.1:54321','sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',{auth:{persistSession:false}});
const {data:auth,error:authError}=await client.auth.signInWithPassword({email:'dev@harmony.local',password:'devpassword123'});
if(authError) throw authError;
const {data:workspace,error:workspaceError}=await client.rpc('create_workspace_with_owner',{_name:'Local source inventory smoke'});
if(workspaceError) throw workspaceError;
const root=mkdtempSync(join(tmpdir(),'source-values-local-'));
try {
 const {data:project,error}=await client.from('projects').insert({workspace_id:workspace,name:'Source smoke',key:'SRC',created_by:auth.user!.id}).select('id').single();
 if(error) throw error;
 mkdirSync(join(root,'examples'),{recursive:true});cpSync(resolve('examples/source-values'),join(root,'examples/source-values'),{recursive:true});symlinkSync(resolve('node_modules'),join(root,'node_modules'));
 const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'});
 git('init');git('config','user.email','smoke@example.test');git('config','user.name','Local smoke');git('add','examples');git('commit','-m','source specimen');
 const declaration=loadPublisherDeclaration(root,'examples/source-values/declaration.json');
 const locator={repository:declaration.repository,surface:'example-config'};
 const snapshot=await readSourceInventory(client,project.id,locator);
 const first=runSourcePublisher(root,declaration,locator.surface,snapshot.revision,'local-1','https://ci.example.test/local-1');
 const published=await publishSourceInventory(client,project.id,first);
 assert.equal((await publishSourceInventory(client,project.id,first)).revision,published.revision);
 const file=join(root,'examples/source-values/contract.mjs');writeFileSync(file,readFileSync(file,'utf8').replace('.default(30)','.default(60)'));
 git('add','examples');git('commit','-m','change actual schema default');
 const next=runSourcePublisher(root,declaration,locator.surface,published.revision,'local-2','https://ci.example.test/local-2',first.source_sha);
 assert.equal(next.values[0].content,'timeout defaults to 60');
 const second=await publishSourceInventory(client,project.id,next);
 const readback=await readSourceInventory(client,project.id,locator);
 assert.equal(readback.values[0].source.sha,next.source_sha);
 assert(readback.values.some(v=>v.key==='timeout'&&v.content.endsWith('60')));
 const coverage=await comparePublishedCoverage(client,project.id,{...locator,current:'--timeout',previous:'--timeout expected_revision'});
 assert.deepEqual(coverage.lost.map(v=>v.key),['stale']);
 const found=await queryKnowledge(client,project.id,{scope:'deployment'});
 assert(found.some(v=>v.id&&v.content==='timeout defaults to 60'&&v.status==='Asserted'));
 await assert.rejects(publishSourceInventory(client,project.id,{...next,expected_revision:second.revision,run_id:'bad-tags',values:[...next.values,{...next.values[0],key:'bad',tags:['not-registered']}]}),/Unknown knowledge tags/);
 assert.equal((await readSourceInventory(client,project.id,locator)).revision,second.revision);
 // Two real concurrent HTTP transactions race from one snapshot; exactly one commits.
 const race=await Promise.allSettled(['race-a','race-b'].map(run_id=>publishSourceInventory(client,project.id,{...next,expected_revision:second.revision,run_id})));
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 assert.match(String((race.find(r=>r.status==='rejected') as PromiseRejectedResult).reason),/inventory changed/);
 const latest=await readSourceInventory(client,project.id,locator);
 await publishSourceInventory(client,project.id,{...next,run_id:'remove',expected_revision:latest.revision,values:[]});
 assert.equal((await queryKnowledge(client,project.id,{scope:'deployment'})).length,0);
 console.log('PASS local source smoke: five kinds, source-change regeneration, stable replay, readback provenance, deployment retrieval, rewrite loss, atomic validator refusal, concurrent CAS, withdrawal');
} finally {
 rmSync(root,{recursive:true,force:true});
 const {error}=await client.from('workspaces').delete().eq('id',workspace);
 if(error) { console.error(error); process.exitCode=1; }
 await client.auth.signOut();
}
