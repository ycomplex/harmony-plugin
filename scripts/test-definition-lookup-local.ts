// Local Supabase only. Run via esbuild to a temporary bundle; never targets a hosted board.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { queryKnowledge } from '../src/tools/knowledge.js';
import { publishDefinition } from '../src/tools/knowledge-definitions.js';
// Local fixture writes must not reference this worker's production conduction UUID.
delete process.env.HARMONY_CONDUCTION_ID; delete process.env.HARMONY_LEG;
const webRoot=process.env.HARMONY_LOCAL_WEB_ROOT;
if(!webRoot)throw new Error('Set HARMONY_LOCAL_WEB_ROOT to the local web checkout with E2E fixtures');
const seed=JSON.parse(readFileSync(`${webRoot}/e2e/.auth/seed-data.json`,'utf8'));
const anon=readFileSync(`${webRoot}/.env.e2e`,'utf8').match(/VITE_SUPABASE_PUBLISHABLE_KEY=["']?([^\n"']+)/)![1];
const client=createClient('http://127.0.0.1:54321',anon,{auth:{persistSession:false,autoRefreshToken:false}});
const login=await client.auth.signInWithPassword({email:'test@harmony.local',password:'test-password-123'});
if(login.error)throw login.error;
function sql(text:string){const result=spawnSync('docker',['exec','-i','supabase_db_lhgljwwetammvsngmbic','psql','-U','postgres','-v','ON_ERROR_STOP=1'],{input:text,encoding:'utf8'});if(result.status)throw new Error(result.stderr);}
const entity=randomUUID(),source=randomUUID();let hidden=false;
try{
 const base={workspace_id:seed.workspaceId,project_id:seed.opinionatedProjectId};
 const c=await client.from('knowledge_entities').insert({...base,id:entity,kind:'concept',name:'Local lookup smoke term'});if(c.error)throw c.error;
 const s=await client.from('knowledge_decisions').insert({...base,id:source,title:'Local lookup smoke refinement',content:'Accepted change of the Local lookup smoke term definition.',type:'specification',status:'Accepted',created_by:seed.userId,domain:['product']});if(s.error)throw s.error;
 const definition=await publishDefinition(client,seed.opinionatedProjectId,{concept_id:entity,expected_revision:null,source_decision_id:source,wording:'A quotable definition.',refinement_ids:[source]});
 const found=await queryKnowledge(client,seed.opinionatedProjectId,{search:'Local lookup smoke term',domain:['product']});
 if(found[0]?.id!==definition.id||found[1]?.id!==source||found.filter(x=>x.id===source).length!==1)throw new Error('Definition/refinement precedence or deduplication failed');
 const only=await queryKnowledge(client,seed.opinionatedProjectId,{definitions_only:true,search:'Local lookup smoke term'});
 if(only.length!==1||only[0].id!==definition.id)throw new Error('Definitions-only returned ordinary knowledge');
 sql("ALTER FUNCTION public.read_knowledge_definitions(uuid,uuid,text,text[],integer,integer) RENAME TO b1226_hidden_read_definitions; NOTIFY pgrst, 'reload schema';");hidden=true;
 const old=await queryKnowledge(client,seed.opinionatedProjectId,{});
 if(!old.some(x=>x.id===source)||old.some(x=>'kind' in x && x.kind==='definition'))throw new Error('Old-schema ordinary lookup failed');
 try{await queryKnowledge(client,seed.opinionatedProjectId,{definitions_only:true});throw new Error('Missing schema was not reported');}catch(error){if(!(error as Error).message.includes('Definitions are not available'))throw error;}
 sql("ALTER FUNCTION public.b1226_hidden_read_definitions(uuid,uuid,text,text[],integer,integer) RENAME TO read_knowledge_definitions; NOTIFY pgrst, 'reload schema';");hidden=false;
 let restored=false;
 for(let i=0;i<20;i++){try{restored=(await queryKnowledge(client,seed.opinionatedProjectId,{definitions_only:true})).some(x=>x.id===definition.id);if(restored)break;}catch(error){if(!(error as Error).message.includes('Definitions are not available'))throw error;}await new Promise(resolve=>setTimeout(resolve,200));}
 if(!restored)throw new Error('Restored capability was cached as absent');
 console.log('PASS actual queryKnowledge: definition-first, linked refinement deduplication, definitions-only, old-schema ordinary fallback, explicit unavailable and fresh re-probe');
}finally{
 if(hidden)sql("ALTER FUNCTION public.b1226_hidden_read_definitions(uuid,uuid,text,text[],integer,integer) RENAME TO read_knowledge_definitions; NOTIFY pgrst, 'reload schema';");
 sql(`DELETE FROM public.knowledge_definitions WHERE concept_id='${entity}'; DELETE FROM public.knowledge_decisions WHERE id='${source}'; DELETE FROM public.knowledge_entities WHERE id='${entity}';`);
 await client.auth.signOut();
}
