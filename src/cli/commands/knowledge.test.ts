import { renameKnowledgeConcept, previewKnowledgeMerge, mergeKnowledgeConcepts } from '../../tools/knowledge-names.js';
vi.mock('../../tools/knowledge-names.js',()=>({readKnowledgeNames:vi.fn(),renameKnowledgeConcept:vi.fn().mockResolvedValue({entity_id:'c'}),previewKnowledgeMerge:vi.fn().mockResolvedValue({confirmation:'key'}),mergeKnowledgeConcepts:vi.fn().mockResolvedValue({target_entity_id:'now'})}));
import { readFeatureAccounts, applyFeatureAmendment } from '../../tools/feature-accounts.js';
import { publishDefinition } from '../../tools/knowledge-definitions.js';
vi.mock('../../tools/knowledge-definitions.js', () => ({ publishDefinition: vi.fn().mockResolvedValue({ id: 'definition', current_revision: 'revision' }) }));
import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';
import { registerKnowledgeCommands } from './knowledge.js';
import { updateKnowledgeEntry, queryKnowledge } from '../../tools/knowledge.js';
import { saveKnowledgeQuestion, previewKnowledgeQuestions } from '../../tools/knowledge-questions.js';

vi.mock('../../tools/knowledge-questions.js', () => ({
  saveKnowledgeQuestion: vi.fn().mockResolvedValue({ id: 'q', question_state: 'open' }),
  previewKnowledgeQuestions: vi.fn().mockResolvedValue({ entries: [{ approved: false }] }),
  importKnowledgeQuestions: vi.fn(),
}));

vi.mock('../../tools/knowledge.js', () => ({
  queryKnowledge: vi.fn(), getKnowledgeEntry: vi.fn(), createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn().mockResolvedValue({ id: 'entry', title: 'Specimen' }),
  supersedeKnowledgeEntry: vi.fn(),
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
