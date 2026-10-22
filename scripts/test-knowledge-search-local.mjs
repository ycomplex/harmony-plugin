// LOCAL ONLY: real handler + PostgREST/SQL, new/absent scored capability and wall clock deadlines.
// node scripts/test-knowledge-search-local.mjs <web-worktree> <esbuild knowledge bundle>
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
const [webRoot, bundle] = process.argv.slice(2);
assert(webRoot && bundle);
const status = JSON.parse(execFileSync('npx',['-y','supabase@2.105.0','status','-o','json'],{cwd:webRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
assert(new URL(status.API_URL).hostname === '127.0.0.1','LOCAL ONLY');
const container=execFileSync('docker',['ps','--format','{{.Names}}'],{encoding:'utf8'}).trim().split('\n').find(n=>n.startsWith('supabase_db_'));
assert(container);
const sql=input=>execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1','-At'],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
const fixture=readFileSync(resolve(webRoot,'supabase/tests/b1223_scored_search.test.sql'),'utf8').split('create temporary table lexical')[0].replace(/^begin;$/m,'');
const {queryKnowledge}=await import(pathToFileURL(resolve(bundle)));
const project='00000000-0000-0000-0000-000001223020';
const workspace='00000000-0000-0000-0000-000001223010';
const signature='public.knowledge_search_scored(uuid,uuid,text,text,text,text,text,text[],text[],boolean)';
let renamed=false, claimsRenamed=false;
const client=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false}});
Object.defineProperty(client,'functions',{configurable:true,value:{invoke:async()=>({data:{embedding:[1,...Array(1535).fill(0)]},error:null})}});
const probe=async(c,args)=>{
 const start=performance.now();const result=await queryKnowledge(c,project,args);const elapsed=performance.now()-start;
 assert(elapsed<6200,`deadline exceeded ${elapsed}ms`);return {result,elapsed};
};
try {
 sql('begin;\n'+fixture+'\ncommit;');
 let {result,elapsed}=await probe(client,{search:' quasar ',tags:[' RARE ',' SURFACE '],type:'technical-design',domain:['engineering'],limit:1});
 assert.equal(result.capability,'scored'); assert.equal(result.matches[0].id,'00000000-0000-0000-0000-000001223206');
 assert.equal(result.matches[0].score,2/61); assert.equal(result.below_cutoff_count,0);
 console.log(`PASS new SQL normalized rare filters BEFORE ranking, genuine fused rank1 score; ${elapsed.toFixed(1)}ms`);
 const many=await queryKnowledge(client,project,{search:'quasar'});
 assert(many.incomplete);assert.equal(many.count_coverage,'partial-scored-union');assert(many.routes_tried.some(r=>r.outcome==='capped'));
 assert(!many.matches.some(r=>r.id==='00000000-0000-0000-0000-000001223206'),'rank206 in both arms correctly falls below cutoff');
 console.log('PASS class-overflow diagnostics and cutoff use real global ranks');
 sql('alter table public.knowledge_decisions rename column claim to b1223_claim; alter table public.knowledge_decisions rename column claim_source to b1223_claim_source;');claimsRenamed=true;
 result=await queryKnowledge(client,project,{search:'quasar',tags:['rare']});assert.equal(result.matches.length,1);
 sql('alter table public.knowledge_decisions rename column b1223_claim to claim; alter table public.knowledge_decisions rename column b1223_claim_source to claim_source;');claimsRenamed=false;
 console.log('PASS optional claim projection columns absent from database');
 Object.defineProperty(client,'functions',{configurable:true,value:{invoke:async()=>({data:null,error:{message:'offline'}})}});
 result=await queryKnowledge(client,project,{search:'quasar',tags:['rare']});assert.equal(result.matches[0].score,1/61);assert(result.incomplete);
 console.log('PASS real lexical route survives embedding failure');
 const hung=createClient(status.API_URL,status.SERVICE_ROLE_KEY,{auth:{persistSession:false},global:{fetch:async(input,init)=>{
   const body=typeof init?.body==='string'?JSON.parse(init.body):null;
   if(String(input).includes('knowledge_search_scored')&&body?._signal==='semantic') return new Promise(()=>{});
   return fetch(input,init);
 }}});
 Object.defineProperty(hung,'functions',{value:{invoke:async()=>({data:{embedding:[1,...Array(1535).fill(0)]},error:null})}});
 ({result,elapsed}=await probe(hung,{search:'quasar',tags:['rare']}));assert.equal(result.matches.length,1);assert(result.routes_tried.some(r=>r.route==='semantic'&&r.outcome==='timeout'));
 console.log(`PASS real lexical partial answer with hung non-aborting semantic transport; ${elapsed.toFixed(1)}ms`);
 // Representative lexical relevance probes from the planning baseline, isolated from quasar fixtures.
 const queries=['hybrid knowledge retrieval','knowledge search','time budget'];
 for(let n=0;n<queries.length;n++) sql(`insert into public.knowledge_decisions(workspace_id,project_id,title,content,type,status,tags,created_by)
 values('${workspace}','${project}','${queries[n]}','${queries[n]} governs reusable architecture and operational decisions','convention','Accepted',array['relevance-probe'],'00000000-0000-0000-0000-000001223001');`);
 for(const query of queries){
   const answer=await queryKnowledge(client,project,{search:query,tags:['relevance-probe'],limit:1});
   assert.equal(answer.matches[0]?.title,query);assert(answer.matches[0].score>=0.0125);
 }
 console.log('PASS representative hybrid knowledge retrieval / knowledge search / time budget relevance probes');
 // Legacy deployment skew: rename capability and reload actual PostgREST schema cache.
 sql(`alter function ${signature} rename to b1223_saved_scored; notify pgrst,'reload schema';`);renamed=true;
 for(let n=0;n<30;n++) {const r=await client.rpc('knowledge_search_scored',{});if(r.error?.code==='PGRST202')break;await new Promise(r=>setTimeout(r,100));}
 const expected=await client.rpc('knowledge_search_rrf',{_workspace_id:workspace,_project_id:project,_query_embedding:null,_query_text:'quasar',_match_limit:null}).select('*').limit(5);
 assert.ifError(expected.error);
 ({result,elapsed}=await probe(client,{search:'quasar',limit:5}));
 assert.equal(result.capability,'scores-unavailable');assert.deepEqual(result.matches,[]);assert.equal(result.below_cutoff_count,null);
 assert.deepEqual(result.unscored_matches.map(r=>r.id),expected.data.map(r=>r.id));assert(result.unscored_matches.every(r=>!('score' in r)));
 console.log(`PASS actual missing-RPC deployment preserves bounded legacy API order, no fabricated scores/count; ${elapsed.toFixed(1)}ms`);
 result=await queryKnowledge(client,project,{search:'quasar',tags:['rare']});assert.equal(result.unscored_matches.length,0);assert(result.routes_tried.some(r=>r.reason==='normalized-tags-unavailable'));
 console.log('PASS legacy normalized-tag limitation explicit, no silently incorrect matches');
} finally {
 if(renamed)sql(`alter function public.b1223_saved_scored(uuid,uuid,text,text,text,text,text,text[],text[],boolean) rename to knowledge_search_scored; notify pgrst,'reload schema';`);
 if(claimsRenamed)sql('alter table public.knowledge_decisions rename column b1223_claim to claim; alter table public.knowledge_decisions rename column b1223_claim_source to claim_source;');
 sql(`delete from public.workspaces where id='${workspace}';delete from auth.users where id='00000000-0000-0000-0000-000001223001';`);
}
console.log('ALL B-1223 LOCAL HANDLER TESTS PASSED');
