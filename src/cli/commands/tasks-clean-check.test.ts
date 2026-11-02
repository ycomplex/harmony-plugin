import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerTaskCommands } from './tasks.js';
const mocks = vi.hoisted(() => ({ recover: vi.fn(), getTask: vi.fn(), auth: vi.fn() }));
vi.mock('../../tools/wait.js', () => ({ recoverDeclaredWait: mocks.recover }));
vi.mock('../../tools/tasks.js', () => ({ getTask: mocks.getTask, listTasks: vi.fn(), createTask: vi.fn(), updateTask: vi.fn() }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.auth }));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ client: {}, projectId: 'p' });
  mocks.getTask.mockResolvedValue({ workflow_state: 'Built', waiting_on: null });
});
describe('tasks clean-check wait recovery', () => {
  it('recovers before reading the projected row and diagnoses the named leg on stderr', async () => {
    const started = '2026-11-02T10:00:00.000Z';
    mocks.recover.mockResolvedValue({ ref: 'pr#42', kind: 'human-step' });
    const error = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command().option('--json'); registerTaskCommands(program);
      await program.parseAsync(['--json', 'tasks', 'clean-check', 'B-1363', '--leg-started-at', started], { from: 'user' });
      expect(mocks.recover).toHaveBeenCalledWith({}, 'p', 'B-1363', Date.parse(started), expect.any(Number));
      expect(mocks.recover.mock.invocationCallOrder[0]).toBeLessThan(mocks.getTask.mock.invocationCallOrder[0]);
      expect(error).toHaveBeenCalledWith(`Recovered leg ${started} comment-only WAITING-ON ref=pr#42 as human-step\n`);
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ workflow_state: 'Built' });
    } finally { error.mockRestore(); log.mockRestore(); }
  });
  it('does not infer waits without a leg boundary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command().option('--json'); registerTaskCommands(program);
      await program.parseAsync(['--json', 'tasks', 'clean-check', 'B-1363'], { from: 'user' });
      expect(mocks.recover).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
