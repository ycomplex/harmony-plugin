import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import { registerConductCommand } from './conduct.js';
import { ActiveConductionExistsError } from '../../tools/conduction-record.js';

// House gotcha (B-685): module-scope mock impls get stripped by restore/clear — every
// implementation is (re-)armed in beforeEach, never at module scope.
const mocks = vi.hoisted(() => ({
  getAuthenticatedContext: vi.fn(),
  resolveTaskId: vi.fn(),
  createConduction: vi.fn(),
}));

vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.getAuthenticatedContext }));
vi.mock('../../tools/resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));
vi.mock('../../tools/conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/conduction-record.js')>();
  return { ...actual, createConduction: mocks.createConduction };
});

class ExitSentinel extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const ctx = { client: { fake: 'client' }, projectId: 'proj-1', userId: 'user-1' };

const conductionRow = {
  id: 'cond-9',
  task_id: 'uuid-1',
  status: 'active',
  mode: 'controlled',
  created_by: 'user-1',
};

function makeProgram(): Command {
  const program = new Command();
  program.name('harmony').option('--json', 'Output results as JSON', false);
  registerConductCommand(program);
  return program;
}

const run = (argv: string[]) => makeProgram().parseAsync(argv, { from: 'user' });

let logSpy: MockInstance;
let errSpy: MockInstance;
let exitSpy: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedContext.mockResolvedValue(ctx);
  mocks.resolveTaskId.mockResolvedValue('uuid-1');
  mocks.createConduction.mockResolvedValue(conductionRow);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
});

afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  exitSpy.mockRestore();
});

describe('harmony conduct <ticket>', () => {
  it('resolves the ticket, creates a controlled conduction credited to the caller, and prints the pickup message', async () => {
    await run(['conduct', 'B-696']);

    expect(mocks.resolveTaskId).toHaveBeenCalledWith(ctx.client, 'proj-1', 'B-696');
    expect(mocks.createConduction).toHaveBeenCalledWith(ctx.client, {
      task_id: 'uuid-1',
      mode: 'controlled',
      created_by: 'user-1',
    });
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('cond-9');
    expect(output).toMatch(/daemon will pick it up/i);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('honors --json: emits the conduction record as JSON', async () => {
    await run(['--json', 'conduct', 'B-696']);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(JSON.parse(output)).toEqual(conductionRow);
  });

  it('maps ActiveConductionExistsError to a clean "already being conducted" message and exit 1', async () => {
    mocks.createConduction.mockRejectedValue(new ActiveConductionExistsError('uuid-1'));

    await expect(run(['conduct', 'B-696'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/already being conducted/i);
    // The clean message, not the raw lease-primitive internals.
    expect(errOutput).not.toMatch(/insert-or-fail/i);
  });

  it('surfaces the resolver error for an unknown ticket and exits 1', async () => {
    mocks.resolveTaskId.mockRejectedValue(new Error("Task B-999 not found in this project"));

    await expect(run(['conduct', 'B-999'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/B-999 not found/);
    expect(mocks.createConduction).not.toHaveBeenCalled();
  });
});
