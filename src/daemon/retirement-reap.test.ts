import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script=new URL('../../container/cloud-worker-reap.sh',import.meta.url).pathname;
describe('Cloud Run retirement confirmation',()=>{
  function run(mode:string) {
    const dir=mkdtempSync(join(tmpdir(),'b1243-reap-'));
    try {
      mkdirSync(join(dir,'bin'));
      writeFileSync(join(dir,'bin','gcloud'),`#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$REAP_TEST_DIR/calls"
case "$*" in
  *"executions list"*)
    [ "$REAP_TEST_MODE" = list-error ] && exit 1
    [ -f "$REAP_TEST_DIR/cancelled" ] && [ "$REAP_TEST_MODE" != still-running ] && exit 0
    echo exact-execution ;;
  *"executions cancel"*)
    [ "$REAP_TEST_MODE" = cancel-error ] && exit 1
    touch "$REAP_TEST_DIR/cancelled" ;;
esac
exit 0
`,{mode:0o755});
      writeFileSync(join(dir,'bin','sleep'),'#!/bin/sh\nexit 0\n',{mode:0o755});
      const r=spawnSync('bash',[script,'run-id','B-1243'],{encoding:'utf8',env:{PATH:`${dir}/bin:${process.env.PATH}`,HOME:dir,HARMONY_CONFIRM_WORKER_STOP:'1',REAP_TEST_DIR:dir,REAP_TEST_MODE:mode}});
      return {status:r.status,calls:readFileSync(join(dir,'calls'),'utf8')};
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
  it('confirms cancellation with a second successful read, without --async',()=>{
    const r=run('success');expect(r.status).toBe(0);
    expect(r.calls.match(/executions list/g)).toHaveLength(2);
    expect(r.calls).toContain('executions cancel exact-execution');expect(r.calls).not.toContain('--async');
  });
  it.each(['list-error','cancel-error','still-running'])('fails closed for %s',mode=>{
    expect(run(mode).status).toBe(1);
  });
});
