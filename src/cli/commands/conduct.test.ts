import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { Command } from 'commander';
import { registerConductCommand } from './conduct.js';
import {
  ActiveConductionExistsError,
  ConductorExcludedError,
  TicketParkedError,
  TicketStaleReviveRefusedError,
} from '../../tools/conduction-record.js';

// House gotcha (B-685): module-scope mock impls get stripped by restore/clear — every
// implementation is (re-)armed in beforeEach, never at module scope.
const mocks = vi.hoisted(() => ({
  getAuthenticatedContext: vi.fn(),
  resolveTaskId: vi.fn(),
  createConduction: vi.fn(),
  assertNotExcluded: vi.fn(),
  reviveParkedTicketIfNeeded: vi.fn(),
  getProjectConductionDefaults: vi.fn(),
}));

vi.mock('../auth.js', () => ({ getAuthenticatedContext: mocks.getAuthenticatedContext }));
vi.mock('../../tools/resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));
vi.mock('../../tools/conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../tools/conduction-record.js')>();
  return {
    ...actual,
    createConduction: mocks.createConduction,
    assertNotExcluded: mocks.assertNotExcluded,
    reviveParkedTicketIfNeeded: mocks.reviveParkedTicketIfNeeded,
  };
});
// B-925: getProjectConductionDefaults is mocked here (defaults to `{}` — no project defaults) so
// every pre-B-925 test in this file, which asserts createConduction is called with NO run_config
// key at all, stays true unchanged; fillRunConfigDefaults itself is the REAL implementation, since
// it is pure and cheap to exercise for real through these CLI-level tests.
vi.mock('../../config/conduction-defaults.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/conduction-defaults.js')>();
  return {
    ...actual,
    getProjectConductionDefaults: mocks.getProjectConductionDefaults,
  };
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
  mocks.assertNotExcluded.mockResolvedValue(undefined);
  mocks.createConduction.mockResolvedValue(conductionRow);
  // B-964: a no-op by default, exactly like a non-Parked ticket.
  mocks.reviveParkedTicketIfNeeded.mockResolvedValue(undefined);
  mocks.getProjectConductionDefaults.mockResolvedValue({});
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
  it('resolves the ticket, checks it is not excluded, creates a controlled conduction credited to the caller, and prints the pickup message + operator-contract note', async () => {
    await run(['conduct', 'B-696']);

    expect(mocks.resolveTaskId).toHaveBeenCalledWith(ctx.client, 'proj-1', 'B-696');
    expect(mocks.assertNotExcluded).toHaveBeenCalledWith(ctx.client, 'uuid-1');
    expect(mocks.createConduction).toHaveBeenCalledWith(ctx.client, {
      task_id: 'uuid-1',
      mode: 'controlled',
      created_by: 'user-1',
    });
    // B-758: the excluded-check must run BEFORE the duplicate-guard create call.
    const excludedOrder = mocks.assertNotExcluded.mock.invocationCallOrder[0];
    const createOrder = mocks.createConduction.mock.invocationCallOrder[0];
    expect(excludedOrder).toBeLessThan(createOrder);

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('cond-9');
    expect(output).toMatch(/daemon will pick it up/i);
    // The B-758 operator-contract sentence — non-optional, must appear verbatim in substance.
    expect(output).toMatch(
      /the duplicate-guard can only detect an active conduction record.*in-progress\s+terminal session.*stopped before handing it off/is,
    );
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

  it('maps ConductorExcludedError to a clean "taken away from the conductor" refusal and exit 1 (B-758)', async () => {
    mocks.assertNotExcluded.mockRejectedValue(new ConductorExcludedError('uuid-1'));

    await expect(run(['conduct', 'B-696'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/taken away from the conductor/i);
    expect(errOutput).toMatch(/Return it first/i);
    // Excluded-check runs BEFORE createConduction — a duplicate-conduction create must never fire.
    expect(mocks.createConduction).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// B-964 — `--unpark` / `--resume-to` on the CLI
// ---------------------------------------------------------------------------

describe('harmony conduct <ticket> --unpark (B-964)', () => {
  it('threads --unpark and --resume-to into reviveParkedTicketIfNeeded, BEFORE assertNotExcluded and createConduction', async () => {
    await run(['conduct', 'B-696', '--unpark', '--resume-to', 'Designed']);

    expect(mocks.reviveParkedTicketIfNeeded).toHaveBeenCalledWith(
      ctx.client,
      'proj-1',
      'user-1',
      'uuid-1',
      expect.objectContaining({ unpark: true, resume_to: 'Designed' }),
    );
    const reviveOrder = mocks.reviveParkedTicketIfNeeded.mock.invocationCallOrder[0];
    const excludedOrder = mocks.assertNotExcluded.mock.invocationCallOrder[0];
    const createOrder = mocks.createConduction.mock.invocationCallOrder[0];
    expect(reviveOrder).toBeLessThan(excludedOrder);
    expect(excludedOrder).toBeLessThan(createOrder);
  });

  it('without --unpark, still calls reviveParkedTicketIfNeeded (unpark: undefined) — a Parked ticket refuses via the SAME typed error the MCP tool uses', async () => {
    mocks.reviveParkedTicketIfNeeded.mockRejectedValue(new TicketParkedError('uuid-1'));

    await expect(run(['conduct', 'B-696'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/Parked/);
    expect(errOutput).toMatch(/unpark: true/);
    expect(mocks.createConduction).not.toHaveBeenCalled();

    const call = mocks.reviveParkedTicketIfNeeded.mock.calls[0];
    expect(call[4].unpark).toBe(false); // commander's declared default for --unpark
  });

  it('maps TicketStaleReviveRefusedError to a clean refusal naming harmony-stale-patch and exit 1', async () => {
    mocks.reviveParkedTicketIfNeeded.mockRejectedValue(new TicketStaleReviveRefusedError('uuid-1'));

    await expect(run(['conduct', 'B-696', '--unpark'])).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = errSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errOutput).toMatch(/harmony-stale-patch/);
    expect(mocks.createConduction).not.toHaveBeenCalled();
  });

  it('succeeds end-to-end with --unpark when the revive resolves cleanly', async () => {
    await run(['conduct', 'B-696', '--unpark']);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(mocks.createConduction).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// B-925 — project conduction defaults filled into `harmony conduct`'s run_config
// ---------------------------------------------------------------------------

describe('harmony conduct <ticket> --model / --session-resume / --auto-approve-gates (B-925)', () => {
  it('passing neither --session-resume nor --no-session-resume produces no session_resume key at all', async () => {
    await run(['conduct', 'B-696']);

    const call = mocks.createConduction.mock.calls[0][1] as Record<string, unknown>;
    expect('run_config' in call).toBe(false);
  });

  it('--no-session-resume produces the explicit session_resume: {enabled: false} encoding, never an omitted key', async () => {
    await run(['conduct', 'B-696', '--no-session-resume']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    expect(call.run_config).toEqual({ session_resume: { enabled: false } });
  });

  it('--session-resume produces the explicit session_resume: {enabled: true} encoding', async () => {
    await run(['conduct', 'B-696', '--session-resume']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    expect(call.run_config).toEqual({ session_resume: { enabled: true } });
  });

  it('--no-auto-approve-gates produces the explicit auto_approve_gates: [] encoding, never an omitted key', async () => {
    await run(['conduct', 'B-696', '--no-auto-approve-gates']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    expect(call.run_config).toEqual({ auto_approve_gates: [] });
  });

  it('--auto-approve-gates parses a comma-separated list', async () => {
    await run(['conduct', 'B-696', '--auto-approve-gates', 'clarify,plan']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    expect(call.run_config).toEqual({ auto_approve_gates: ['clarify', 'plan'] });
  });

  it('--model fills run_config.model.default', async () => {
    await run(['conduct', 'B-696', '--model', 'claude-opus-5']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    expect(call.run_config).toEqual({ model: { default: 'claude-opus-5' } });
  });

  it('fills an unset field from the project default, and leaves an explicitly-set field alone', async () => {
    mocks.getProjectConductionDefaults.mockResolvedValue({
      model: 'claude-sonnet-5',
      session_resume: { enabled: true },
    });

    await run(['conduct', 'B-696', '--no-session-resume']);

    const call = mocks.createConduction.mock.calls[0][1] as { run_config?: unknown };
    // session_resume was explicit (false) -> untouched by the default (which says true); model was
    // never passed -> filled in from the project default.
    expect(call.run_config).toEqual({
      session_resume: { enabled: false },
      model: { default: 'claude-sonnet-5' },
    });
  });

  it('fetches the project defaults for this project id, after resolving the task', async () => {
    await run(['conduct', 'B-696']);

    expect(mocks.getProjectConductionDefaults).toHaveBeenCalledWith(ctx.client, 'proj-1');
  });
});
