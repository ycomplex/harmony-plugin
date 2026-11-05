import { Command } from 'commander';
import { beforeEach, expect, it, vi } from 'vitest';
import { registerProjectCommands } from './project.js';
const ports = vi.hoisted(() => ({ read: vi.fn(), check: vi.fn(), refresh: vi.fn(), after: vi.fn(), output: vi.fn() }));
vi.mock('../../tools/project-context.js', () => ({ readProjectContext: ports.read }));
vi.mock('../../tools/project-context-file.js', () => ({ checkProjectContextFile: ports.check, refreshProjectContextFile: ports.refresh }));
vi.mock('../../tools/project-context-consumer.js', () => ({ refreshAfterCompletingAccept: ports.after }));
vi.mock('../run-command.js', () => ({ runCommand: async (_options: unknown, run: (ctx: unknown) => Promise<unknown>) => {
  ports.output(await run({ client: 'client', projectId: 'project', userId: 'user' }));
} }));
beforeEach(() => vi.clearAllMocks());
it('preserves check fields and the additive outcome through the CLI', async () => {
  const snapshot = { applicability: 'not_applicable', blocks: [], diagnostics: [] };
  const file = { path: '/repo/CLAUDE.md', stale: false, outcome: 'not_applicable', source_ids: [], diagnostics: [], fingerprint: null };
  ports.read.mockResolvedValue(snapshot); ports.check.mockResolvedValue(file);
  const program = new Command(); registerProjectCommands(program);
  await program.parseAsync(['node', 'harmony', 'project', 'context', 'check', '--root', '/repo', '--json']);
  expect(ports.check).toHaveBeenCalledWith('/repo', snapshot);
  expect(ports.output).toHaveBeenCalledWith({ ...file, snapshot });
  expect(ports.refresh).not.toHaveBeenCalled();
});
it('propagates read errors instead of presenting not-applicable', async () => {
  ports.read.mockRejectedValue(new Error('permission denied'));
  const program = new Command(); registerProjectCommands(program);
  await expect(program.parseAsync(['node', 'harmony', 'project', 'context', 'check', '--json'])).rejects.toThrow('permission denied');
  expect(ports.output).not.toHaveBeenCalled();
});
