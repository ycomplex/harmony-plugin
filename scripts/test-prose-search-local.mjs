// LOCAL ONLY. Real Git snapshot -> ingestion -> PostgREST publication -> shared search.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createClient} from '@supabase/supabase-js';
const [webRoot,bundle]=process.argv.slice(2);assert(webRoot&&bundle);
const status=JSON.parse(execFileSync('npx',['-y','supabase@2.105.0','status','-o','json'],{cwd:webRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(new URL(status.API_URL).hostname,'127.0.0.1');
const container=execFileSync('docker',['ps','--format','{{.Names}}'],{encoding:'utf8'}).trim().split('\n').find(n=>n.startsWith('supabase_db_'));assert(container);
const sql=input=>execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const fixture=readFileSync(resolve(webRoot,'supabase/tests/b1223_scored_search.test.sql'),'utf8').split('-- 205 procedural')[0].replace(/^begin;$/m,'');
const {syncProse,queryKnowledge}=await import(pathToFileURL(resolve(bundle)));
const project='00000000-0000-0000-0000-000001223020',workspace='00000000-0000-0000-0000-000001223010';
const encode=v=>Buffer.from(JSON.stringify(v)).toString('base64url');
const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({role:'authenticated',sub:'00000000-0000-0000-0000-000001223001',exp:1983812999});
const token=body+'.'+createHmac('sha256',status.JWT_SECRET).update(body).digest('base64url');
const client=createClient(status.API_URL,status.ANON_KEY,{auth:{persistSession:false},global:{headers:{Authorization:`Bearer ${token}`}}});
Object.defineProperty(client,'functions',{configurable:true,value:{invoke:async()=>({data:null,error:{code:'unavailable'}})}});
const root=mkdtempSync(join(tmpdir(),'other-project-prose-'));const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
 sql(fixture);
 git('init');git('config','user.email','fixture@example.invalid');git('config','user.name','Fixture');git('remote','add','origin','https://github.com/other-org/unrelated-product');
 mkdirSync(join(root,'.harmony'));mkdirSync(join(root,'guides'));
 writeFileSync(join(root,'.harmony/prose-sources.json'),JSON.stringify({version:1,repository:'https://github.com/other-org/unrelated-product',ref:'HEAD',sources:[{key:'rules',selectors:[{include:['guides/**/*.md'],kind:'document',scope:'product',domain:['engineering']}]}]}));
 writeFileSync(join(root,'guides/rules.md'),'# Quasar handling\n\nQuasar handling requires explicit review.\n');git('add','.');git('commit','-m','first');const first=git('rev-parse','HEAD');
 await syncProse(client,project,root);let result=await queryKnowledge(client,project,{search:'Quasar handling',scope:'product'});
 assert.equal(result.matches.length,1);assert.equal(result.matches[0].source_kind,'document');assert.equal(result.matches[0].provenance.commit,first);assert.equal(result.matches[0].status,'Source-backed');assert.equal(result.matches[0].authority,'unratified');assert.equal(result.matches[0].score,1/61);
 console.log('PASS unrelated project immutable Git snapshot reaches real scored search with heading provenance and genuine score');
 assert.equal((await syncProse(client,project,root))[0].unchanged,true);
 writeFileSync(join(root,'guides/rules.md'),'# Quasar revised\n\nQuasar handling changed.\n');git('add','.');git('commit','-m','rename');await syncProse(client,project,root);
 result=await queryKnowledge(client,project,{search:'Quasar handling'});assert.equal(result.matches.length,1);assert.equal(result.matches[0].provenance.anchor,'quasar-revised');assert.notEqual(result.matches[0].provenance.commit,first);
 await assert.rejects(syncProse(client,project,root,'.harmony/prose-sources.json',first));
 rmSync(join(root,'guides/rules.md'));git('add','.');git('commit','-m','delete');await syncProse(client,project,root);result=await queryKnowledge(client,project,{search:'Quasar handling'});assert.equal(result.matches.length,0);
 console.log('PASS idempotent replay, rename replacement, stale commit rejection and deletion through complete real ingestion path');
 // Stored entry context is real data, and enrichment remains inside the handler's deadline.
 sql(`insert into public.knowledge_decisions(id,workspace_id,project_id,title,content,type,status,domain,created_by) values('00000000-0000-0000-0000-000001240010','${workspace}','${project}','Quasar handling','Quasar handling entry','convention','Accepted',array['engineering'],'00000000-0000-0000-0000-000001223001');`);
 result=await queryKnowledge(client,project,{search:'Quasar handling'});assert.equal(result.matches[0].claim_context.claim_id,'00000000-0000-0000-0000-000001240010');assert.equal(result.matches[0].name_history_available,true);assert(result.elapsed_ms<6000);
 console.log('PASS real claim-context and historical-wording hydration share the existing search deadline');
}finally{
 sql(`delete from public.knowledge_defined_in where source_id in(select id from public.knowledge_prose_sources where project_id='${project}');delete from public.knowledge_prose_generations where source_id in(select id from public.knowledge_prose_sources where project_id='${project}');delete from public.knowledge_prose_sources where project_id='${project}';delete from public.workspaces where id='${workspace}';delete from auth.users where id='00000000-0000-0000-0000-000001223001';`);rmSync(root,{recursive:true,force:true});
}
console.log('ALL B-1240 LOCAL INGESTION TESTS PASSED');
