import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerWaitCommands } from './wait.js';
const mocks = vi.hoisted(() => ({ declareWait: vi.fn(), auth: vi.fn() }));
vi.mock('../../tools/wait.js', () => ({ declareWait: mocks.declareWait }));
vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.auth }));
beforeEach(() => vi.clearAllMocks());
describe('wait declare CLI', () => {
  it('passes all flags to the shared handler and emits its JSON result', async () => {
    mocks.auth.mockResolvedValue({ client: {}, projectId: 'p', userId: 'u' });
    mocks.declareWait.mockResolvedValue({ declared: true, waiting_on: { ref: 'pr#42', kind: 'ci' } });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const program = new Command().option('--json');
      registerWaitCommands(program);
      await program.parseAsync(['--json', 'wait', 'declare', '--task', 'B-1363', '--kind', 'ci', '--ref', 'pr#42', '--resume-after', '2026-11-02T14:00:00Z'], { from: 'user' });
      expect(mocks.declareWait).toHaveBeenCalledWith({}, 'p', 'u', { task_id: 'B-1363', kind: 'ci', ref: 'pr#42', resume_after: '2026-11-02T14:00:00Z' });
      expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ declared: true });
    } finally { log.mockRestore(); }
  });
  it('exits nonzero when the declaration fails', async () => {
    mocks.auth.mockResolvedValue({ client: {}, projectId: 'p', userId: 'u' });
    mocks.declareWait.mockRejectedValue(new Error('marker write failed'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit 1'); });
    try {
      const program = new Command(); registerWaitCommands(program);
      await expect(program.parseAsync(['wait', 'declare', '--task', 'B-1363', '--kind', 'ci', '--ref', 'pr#42'], { from: 'user' })).rejects.toThrow('exit 1');
      expect(exit).toHaveBeenCalledWith(1);
    } finally { error.mockRestore(); exit.mockRestore(); }
  });
});
