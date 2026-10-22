import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';
import { registerKnowledgeCommands } from './knowledge.js';
import { updateKnowledgeEntry, queryKnowledge } from '../../tools/knowledge.js';

vi.mock('../../tools/knowledge.js', () => ({
  queryKnowledge: vi.fn(), getKnowledgeEntry: vi.fn(), createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn().mockResolvedValue({ id: 'entry', title: 'Specimen' }),
  supersedeKnowledgeEntry: vi.fn(),
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
    await program.parseAsync(['knowledge', 'update', 'entry', '--verified-against', '{"plugin_version":"0.16.8","at":"2026-10-22T12:00:00Z"}', '--rollout-state', 'partly-live', '--open-steps', '["Promote"]'], { from: 'user' });
    expect(updateKnowledgeEntry).toHaveBeenLastCalledWith('client', 'project', expect.objectContaining({
      verified_against: { plugin_version: '0.16.8', at: '2026-10-22T12:00:00Z' }, rollout_state: 'partly-live', open_steps: ['Promote'],
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
