import { queryEntities } from '../../tools/knowledge.js';
import { linkTicketEntities } from '../../tools/workflow.js';
vi.mock('../../tools/workflow.js', () => ({ linkTicketEntities: vi.fn().mockResolvedValue({ linked: true }) }));
import { renameKnowledgeConcept, previewKnowledgeMerge, mergeKnowledgeConcepts } from '../../tools/knowledge-names.js';
vi.mock('../../tools/knowledge-names.js',()=>({readKnowledgeNames:vi.fn(),renameKnowledgeConcept:vi.fn().mockResolvedValue({entity_id:'c'}),previewKnowledgeMerge:vi.fn().mockResolvedValue({confirmation:'key'}),mergeKnowledgeConcepts:vi.fn().mockResolvedValue({target_entity_id:'now'})}));
import { captureSurfaceRecord, readSurfaceRecords } from '../../tools/surface-records.js';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('../../tools/surface-records.js', () => ({ captureSurfaceRecord: vi.fn().mockResolvedValue({changed:true}), readSurfaceRecords: vi.fn().mockResolvedValue({availability:'available',records:[]}) }));
import { readFeatureAccounts, applyFeatureAmendment } from '../../tools/feature-accounts.js';
import { publishDefinition } from '../../tools/knowledge-definitions.js';
vi.mock('../../tools/knowledge-definitions.js', () => ({ publishDefinition: vi.fn().mockResolvedValue({ id: 'definition', current_revision: 'revision' }) }));
import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';
import { registerKnowledgeCommands } from './knowledge.js';
import { updateKnowledgeEntry, queryKnowledge, proposeLegacyClaims } from '../../tools/knowledge.js';
import { saveKnowledgeQuestion, previewKnowledgeQuestions } from '../../tools/knowledge-questions.js';

vi.mock('../../tools/knowledge-questions.js', () => ({
  saveKnowledgeQuestion: vi.fn().mockResolvedValue({ id: 'q', question_state: 'open' }),
  previewKnowledgeQuestions: vi.fn().mockResolvedValue({ entries: [{ approved: false }] }),
  importKnowledgeQuestions: vi.fn(),
}));

vi.mock('../../tools/knowledge.js', () => ({
  queryEntities: vi.fn().mockResolvedValue([]), queryKnowledge: vi.fn(), getKnowledgeEntry: vi.fn(), createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn().mockResolvedValue({ id: 'entry', title: 'Specimen' }),
  supersedeKnowledgeEntry: vi.fn(),
  proposeLegacyClaims: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../tools/feature-accounts.js', () => ({
  createFeatureAccount: vi.fn(), readFeatureAccounts: vi.fn().mockResolvedValue({availability:'available',accounts:[]}), previewFeatureAmendment: vi.fn(), proposeFeatureAmendment: vi.fn(), applyFeatureAmendment: vi.fn().mockResolvedValue({applied_revision:1}),
}));
const output = vi.hoisted(() => ({ text: '' }));
vi.mock('../run-command.js', () => ({
  runCommand: async (_opts: unknown, action: (ctx: unknown) => unknown, format?: (data: unknown) => string) => {
    const data = await action({ client: 'client', projectId: 'project' });
    if (format) output.text = format(data);
    return data;
  },
}));

describe('knowledge update command', () => {
  it('passes amendment controls to the shared handler', async () => {
    const program = new Command();
    registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'update', 'entry', '--content', 'New section', '--content-mode', 'prepend_section', '--allow-shrink'], { from: 'user' });
    expect(updateKnowledgeEntry).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({
      entry_id: 'entry', content: 'New section', content_mode: 'prepend_section', allow_shrink: true,
    }));
  });
  it('does not implicitly enable the destructive override on ordinary updates', async () => {
    const program = new Command();
    registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'update', 'entry', '--content', 'Replacement'], { from: 'user' });
    expect(updateKnowledgeEntry).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({
      content: 'Replacement', content_mode: undefined, allow_shrink: undefined,
    }));
  });
  it('passes stamp, rollout and explicit clears through the shared handler', async () => {
    const program = new Command();
    registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'update', 'entry', '--verified-against', '{"plugin_version":"0.16.8","at":"2026-10-22T12:00:00Z"}', '--rollout-state', 'partly-live', '--open-steps', '["Promote"]', '--acting-task', 'ticket-uuid'], { from: 'user' });
    expect(updateKnowledgeEntry).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({
      verified_against: { plugin_version: '0.16.8', at: '2026-10-22T12:00:00Z' }, rollout_state: 'partly-live', open_steps: ['Promote'], acting_task_id: 'ticket-uuid',
    }));
    await program.parseAsync(['knowledge', 'update', 'entry', '--verified-against', 'null', '--rollout-state', 'live', '--open-steps', '[]'], { from: 'user' });
    expect(updateKnowledgeEntry).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({ verified_against: null, rollout_state: 'live', open_steps: [] }));
  });

});

describe('knowledge propose-claims CLI', () => {
  it('passes a bounded preview selection from an ID file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-preview-'));
    try {
      const file = join(dir, 'entries.json'); writeFileSync(file, JSON.stringify(['entry-a', 'entry-b']));
      const program = new Command(); registerKnowledgeCommands(program);
      await program.parseAsync(['knowledge', 'propose-claims', '--entries', file, '--limit', '1'], { from: 'user' });
      expect(proposeLegacyClaims).toHaveBeenLastCalledWith('client', 'project', { entries: ['entry-a', 'entry-b'], limit: 1, apply: false });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('passes the review output unchanged for subset-only apply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claim-review-'));
    try {
      const entries = [{ id: 'entry', claim: 'Teams review claims.', status: 'proposed', reviewed: true }];
      const file = join(dir, 'review.json'); writeFileSync(file, JSON.stringify(entries));
      const program = new Command(); registerKnowledgeCommands(program);
      await program.parseAsync(['knowledge', 'propose-claims', '--entries', file, '--apply'], { from: 'user' });
      expect(proposeLegacyClaims).toHaveBeenLastCalledWith('client', 'project', { entries, limit: 100, apply: true });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([['--apply'], ['--limit', '0'], ['--limit', '1.5'], ['--limit', 'invalid']])('refuses unsafe arguments before invoking the handler: %s', async (...args) => {
    vi.mocked(proposeLegacyClaims).mockClear();
    const program = new Command(); registerKnowledgeCommands(program);
    await expect(program.parseAsync(['knowledge', 'propose-claims', ...args], { from: 'user' })).rejects.toThrow();
    expect(proposeLegacyClaims).not.toHaveBeenCalled();
  });
});

describe('knowledge list human output', () => {
  it('prints both first-class supersession fields including null and empty values', async () => {
    vi.mocked(queryKnowledge).mockResolvedValue([{ id: 'new-id', title: 'New policy', type: 'architecture', status: 'Accepted', tags: [], updated_at: '2026-10-01T00:00:00Z', superseded_by: null, supersedes: ['old-id'] },
      { id: 'old-id', title: 'Old policy', type: 'architecture', status: 'Superseded', tags: [], updated_at: '2026-10-01T00:00:00Z', superseded_by: 'new-id', supersedes: [] }]);
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'list', '--all'], { from: 'user' });
    expect(output.text).toContain('Superseded by');
    expect(output.text).toContain('Supersedes');
    expect(output.text).toContain('old-id');
    expect(output.text).toContain('new-id');
    expect(queryKnowledge).toHaveBeenCalledWith('client', 'project', expect.objectContaining({ include_superseded: true }));
  });
});

describe('knowledge accounts CLI',()=>{
  it('passes scoped history pagination to the shared reader',async()=>{
    const program=new Command();registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge','accounts','list','--surface','Project views','--history-before','12','--history-limit','10'],{from:'user'});
    expect(readFeatureAccounts).toHaveBeenCalledWith('client','project',expect.objectContaining({owner_surface:'Project views',history_before:12,history_limit:10}));
    expect(output.text).toContain('available');
  });
  it('passes only an explicit production confirmation to publication',async()=>{
    const program=new Command();registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge','accounts','apply','amendment','--confirm-production'],{from:'user'});
    expect(applyFeatureAmendment).toHaveBeenCalledWith('client','project',{amendment_id:'amendment',production_event_id:undefined,confirm_production:true});
  });
});

describe('knowledge questions commands', () => {
  it('passes explicit scope and optimistic lifecycle controls to the shared writer', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'questions', 'save', '--id', 'q', '--state', 'decided',
      '--expected-updated-at', '2026-10-22T00:00:00Z', '--decision', 'd'], { from: 'user' });
    expect(saveKnowledgeQuestion).toHaveBeenCalledWith('client', 'project', expect.objectContaining({
      question_id: 'q', state: 'decided', expected_updated_at: '2026-10-22T00:00:00Z', resulting_decision_id: 'd',
    }));
  });
  it('preview invokes only the read-only handler', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'questions', 'preview', 'm'], { from: 'user' });
    expect(previewKnowledgeQuestions).toHaveBeenCalledWith('client', 'project', { milestone_id: 'm' });
    expect(output.text).toContain('"approved": false');
  });
});

describe('definition CLI controls', () => {
  it('forwards definitions-only to the shared reader', async () => {
    vi.mocked(queryKnowledge).mockResolvedValue([]);
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'list', '--definitions-only', '--search', 'Term'], { from: 'user' });
    expect(queryKnowledge).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({ definitions_only: true, search: 'Term' }));
  });
  it('preserves the explicit accepted source and first-publication revision', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'publish-definition', '--concept', 'concept', '--expected-revision', 'null', '--source', 'source', '--wording', 'Meaning.', '--metadata', '{"ticket":"B-1226"}'], { from: 'user' });
    expect(publishDefinition).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({ concept_id: 'concept', expected_revision: null, source_decision_id: 'source', wording: 'Meaning.', metadata: { ticket: 'B-1226' } }));
  });
});

describe('explicit name mutation commands',()=>{
 it('passes rename expectation and operation key without assuming a merge',async()=>{
  const program=new Command();registerKnowledgeCommands(program);
  await program.parseAsync(['knowledge','rename','--concept','c','--expect','Old','--to','Now','--ticket','B-1227','--operation-key','once'],{from:'user'});
  expect(renameKnowledgeConcept).toHaveBeenLastCalledWith('client','project',{concept_id:'c',expected_name:'Old',new_name:'Now',source_task_id:'B-1227',operation_key:'once'});
 });
 it('separates preview and explicit confirmation',async()=>{
  const make=()=>{const p=new Command();registerKnowledgeCommands(p);return p;};
  const args=['knowledge','merge','--source','old','--target','now','--ticket','B-1227'];
  await make().parseAsync([...args,'--preview'],{from:'user'});
  expect(previewKnowledgeMerge).toHaveBeenLastCalledWith('client','project',{source_id:'old',target_id:'now',source_task_id:'B-1227'});
  await make().parseAsync([...args,'--confirm','reviewed-key'],{from:'user'});
  expect(mergeKnowledgeConcepts).toHaveBeenLastCalledWith('client','project',{source_id:'old',target_id:'now',source_task_id:'B-1227',confirmation:'reviewed-key'});
  await expect(make().parseAsync([...args,'--preview','--confirm','key'],{from:'user'})).rejects.toThrow('exactly one');
 });
});

describe('knowledge surfaces CLI',()=>{
  it('reads with the same owner and component identity',async()=>{
    const program=new Command();registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge','surfaces','read','--surface','Views','--component','web/src/Views.tsx'],{from:'user'});
    expect(readSurfaceRecords).toHaveBeenCalledWith('client','project',{owner_surface:'Views',component_ref:'web/src/Views.tsx'});
  });
  it('passes a JSON capture to the shared writer',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'surface-cli-'));const args={owner_surface:'Views',labels:['Name']};
    try { const file=join(dir,'capture.json');writeFileSync(file,JSON.stringify(args));
      const program=new Command();registerKnowledgeCommands(program);
      await program.parseAsync(['knowledge','surfaces','capture','--file',file],{from:'user'});
      expect(captureSurfaceRecord).toHaveBeenCalledWith('client','project',args);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
});

it('prints search scores and coverage and passes composable CLI filters', async () => {
  const envelope = { matches: [{id:'a', score:1/61}], unscored_matches:[], score_cutoff:0.0125, below_cutoff_count:2, incomplete:true, count_coverage:'partial-scored-union' };
  vi.mocked(queryKnowledge).mockResolvedValue(envelope as any);
  const program = new Command(); registerKnowledgeCommands(program);
  await program.parseAsync(['knowledge','list','--search','quasar','--type','convention','--status','Asserted','--tag',' Rare ','--domain','engineering','--context-tag','surface','--limit','3'],{from:'user'});
  expect(JSON.parse(output.text)).toEqual(envelope);
  expect(queryKnowledge).toHaveBeenLastCalledWith('client','project',expect.objectContaining({ search:'quasar', type:'convention', status:'Asserted', tags:[' Rare '], domain:['engineering'], context_tags:['surface'], limit:3 }));
});

it('explains admission and definition participation in knowledge list help', () => {
  const program = new Command();
  registerKnowledgeCommands(program);
  const list = program.commands.find(c=>c.name()==='knowledge')!.commands.find(c=>c.name()==='list')!;
  let help='';
  list.configureOutput({writeOut:text=>{help+=text;}});
  list.outputHelp();
  expect(help).toContain('relevance_admission');
  expect(help).toContain('definitions_included');
  expect(help).toContain('not a storage-capability flag');
});

describe('entity selection CLI', () => {
  it('forwards identity and kind instead of reducing them to names', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge','entities','--entity-id','feature-id','--name','Knowledge','--kind','feature'], {from:'user'});
    expect(queryEntities).toHaveBeenCalledWith('client','project',{entity_id:'feature-id',name:'Knowledge',kind:'feature'});
    await program.parseAsync(['knowledge','link-entities','--task','B-1255','--decision','decision-id','--entity-id','concept-id','--kind','concept'], {from:'user'});
    expect(linkTicketEntities).toHaveBeenCalledWith('client','project',expect.objectContaining({task_id:'B-1255',decision_id:'decision-id',entity_id:'concept-id',kind:'concept'}));
  });
});
