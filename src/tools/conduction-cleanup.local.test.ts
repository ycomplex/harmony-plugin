// Opt-in localhost smoke: real database claims, failed stop, Docker removal and atomic completion.
import { it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createConductionCleanup } from './conduction-cleanup.js';

it.skipIf(process.env.HARMONY_TEST_LOCAL_CLEANUP !== '1')('local worker stop precedes atomic retirement', async()=>{
  const key='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
  const admin=createClient('http://127.0.0.1:54321',key,{auth:{persistSession:false,autoRefreshToken:false}});
  const actor=createClient('http://127.0.0.1:54321',key,{auth:{persistSession:false,autoRefreshToken:false}});
  const auth=await actor.auth.signInWithPassword({email:'test@harmony.local',password:'test-password-123'});
  expect(auth.error).toBeNull();
  const project=process.env.HARMONY_TEST_LOCAL_CLEANUP_PROJECT!;
  expect(project).toMatch(/^[0-9a-f-]{36}$/);
  const id=randomUUID(),name=`harmony-worker-${id}`;
  const created=await admin.from('tasks').insert({project_id:project,title:'B1243 local Docker smoke',created_by:auth.data.user!.id,archived:true,workflow_state:'Proposed',awaiting_human_input:true}).select('id').single();
  expect(created.error).toBeNull();
  try {
    const worker=spawnSync('docker',['run','-d','--name',name,'alpine:3.20','sleep','300'],{encoding:'utf8'});
    expect(worker.status,worker.stderr).toBe(0);
    const inserted=await admin.from('conductions').insert({id,task_id:created.data!.id,status:'parked',mode:'controlled',created_by:auth.data.user!.id,worker_ref:name,leg_started_at:'2026-11-02T12:00:00Z'}).select('*').single();
    expect(inserted.error).toBeNull();
    const api=createConductionCleanup(actor,project,'local-smoke',300000);
    const claimed=await api.claim(inserted.data!);expect(claimed).not.toBeNull();
    expect(await api.finish(claimed!,'simulated unconfirmed stop')).toBe(false);
    expect((await admin.from('conductions').select('status,worker_ref').eq('id',id).single()).data).toMatchObject({status:'parked',worker_ref:name});
    expect(spawnSync('docker',['inspect',name]).status).toBe(0);
    const reap=new URL('../../container/docker-worker-reap.sh',import.meta.url).pathname;
    expect(spawnSync('bash',[reap,id,'B-1243'],{encoding:'utf8'}).status).toBe(0);
    expect(spawnSync('docker',['inspect',name],{stdio:'ignore'}).status).not.toBe(0);
    expect(await api.finish(claimed!)).toBe(true);
    expect(await api.finish(claimed!)).toBe(false);
    expect((await admin.from('tasks').select('workflow_state,awaiting_human_input').eq('id',created.data!.id).single()).data).toMatchObject({workflow_state:'Proposed',awaiting_human_input:true});
    const comments=await admin.from('task_comments').select('id').eq('task_id',created.data!.id).like('content',`Conduction ${id} completed%`);
    expect(comments.data).toHaveLength(1);
  } finally {
    spawnSync('docker',['rm','-f',name],{stdio:'ignore'});
    await admin.from('tasks').delete().eq('id',created.data!.id);
  }
},30000);
