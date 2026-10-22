import { readFeatureAccounts, applyFeatureAmendment } from '../../tools/feature-accounts.js';
import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';
import { registerKnowledgeCommands } from './knowledge.js';
import { updateKnowledgeEntry, queryKnowledge } from '../../tools/knowledge.js';

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
