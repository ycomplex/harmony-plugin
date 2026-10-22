import { Command } from 'commander';
import { describe, it, expect, vi } from 'vitest';
import { registerKnowledgeCommands } from './knowledge.js';
import { updateKnowledgeEntry } from '../../tools/knowledge.js';

vi.mock('../../tools/knowledge.js', () => ({
  queryKnowledge: vi.fn(), getKnowledgeEntry: vi.fn(), createKnowledgeEntry: vi.fn(),
  updateKnowledgeEntry: vi.fn().mockResolvedValue({ id: 'entry', title: 'Specimen' }),
  supersedeKnowledgeEntry: vi.fn(),
}));
vi.mock('../run-command.js', () => ({
  runCommand: async (_opts: unknown, action: (ctx: unknown) => unknown) => action({ client: 'client', projectId: 'project' }),
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
