import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerKnowledgeCommands } from './knowledge.js';
import { previewMetadataRepairToFile } from '../metadata-preview.js';
vi.mock('../metadata-preview.js', () => ({ previewMetadataRepairToFile: vi.fn().mockResolvedValue({ entries: 2 }) }));
vi.mock('../run-command.js', () => ({ runCommand: async (_opts: unknown, action: (ctx: unknown) => unknown) =>
  action({ client: 'client', projectId: 'project' }) }));
describe('metadata preview command selectors', () => {
  it('passes combined selectors and numeric limit to incremental output', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'preview-metadata-repair', 'review.json', '--tag', 'known',
      '--type', 'specification', '--created-after', '2026-10-01T00:00:00Z',
      '--created-before', '2026-10-23T00:00:00Z', '--limit', '2'], { from: 'user' });
    expect(previewMetadataRepairToFile).toHaveBeenLastCalledWith('client', 'project', 'review.json', {
      tag: 'known', type: 'specification', created_after: '2026-10-01T00:00:00Z',
      created_before: '2026-10-23T00:00:00Z', limit: 2,
    });
  });
  it('preserves the legacy file-only invocation', async () => {
    const program = new Command(); registerKnowledgeCommands(program);
    await program.parseAsync(['knowledge', 'preview-metadata-repair', 'review.json'], { from: 'user' });
    expect(previewMetadataRepairToFile).toHaveBeenLastCalledWith('client', 'project', 'review.json', {
      tag: undefined, type: undefined, created_after: undefined, created_before: undefined, limit: undefined,
    });
  });
});
