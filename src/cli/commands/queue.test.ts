import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
const mocks=vi.hoisted(()=>({query:vi.fn(),brief:vi.fn(),result:[] as unknown[]}));
vi.mock('../run-command.js',()=>({runCommand:async (_opts:unknown,handler:any)=>{mocks.result=await handler({client:{},projectId:'p'});}}));
vi.mock('../../tools/project.js',()=>({getProject:async()=>({key:'APP'})}));
vi.mock('../../tools/query-tasks.js',()=>({queryTasks:mocks.query}));
vi.mock('../../tools/briefs.js',()=>({getBrief:mocks.brief}));
import { registerQueueCommand, formatQueueRow } from './queue.js';
describe('CLI human queue',()=>{
 it('shows Captured handoff without a brief lookup and deduplicates queue signals',async()=>{
  const task={id:'t',task_number:42,title:'Improve setup',workflow_state:'Captured',awaiting_human_reason:'fast-track-merge-pending',awaiting_human_ref:{kind:'fast-track-merge',pr_number:72,pr_url:'https://github.com/example/atlas/pull/72',refusal_reason:'PR #72 is not merged.'}};
  mocks.query.mockResolvedValue([task]);const p=new Command();p.option('--json');registerQueueCommand(p);await p.parseAsync(['queue'],{from:'user'});
  expect(mocks.result).toHaveLength(1);expect(mocks.brief).not.toHaveBeenCalled();
  const line=formatQueueRow(mocks.result[0] as any);expect(line).toContain('APP-42 [Captured]');expect(line).toContain('Merge PR #72, then re-run fast-track');expect(line).toContain('Recording refused: PR #72 is not merged.');
 });
});
