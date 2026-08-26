// B-758: `create_conduction` — the MCP tool test suite.
//
// Mirrors conduct.test.ts's mocking convention one layer down (the tool handler, not the CLI
// command): resolveTaskId and the conduction-record primitives (assertNotExcluded, createConduction)
// are mocked; the typed errors (ActiveConductionExistsError, ConductorExcludedError) are the real
// classes so `instanceof` checks in the handler exercise real behavior.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConduction, createConductionTool } from './create-conduction.js';
import {
  ActiveConductionExistsError,
  ConductorExcludedError,
} from './conduction-record.js';

const mocks = vi.hoisted(() => ({
  resolveTaskId: vi.fn(),
  assertNotExcluded: vi.fn(),
  insertConduction: vi.fn(),
}));

vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));
vi.mock('./conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conduction-record.js')>();
  return {
    ...actual,
    assertNotExcluded: mocks.assertNotExcluded,
    createConduction: mocks.insertConduction,
  };
});

const client = { fake: 'client' } as never;

const conductionRow = {
  id: 'cond-9',
  task_id: 'uuid-1',
  status: 'active',
  mode: 'controlled',
  lease_holder: null,
  created_by: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTaskId.mockResolvedValue('uuid-1');
  mocks.assertNotExcluded.mockResolvedValue(undefined);
  mocks.insertConduction.mockResolvedValue(conductionRow);
});

describe('createConduction (create_conduction MCP tool handler)', () => {
  it('resolves the ticket, checks it is not excluded BEFORE creating, and returns the conduction + the operator-contract note', async () => {
    const result = await createConduction(client, 'proj-1', { task_id: 'B-758' });

    expect(mocks.resolveTaskId).toHaveBeenCalledWith(client, 'proj-1', 'B-758');
    expect(mocks.assertNotExcluded).toHaveBeenCalledWith(client, 'uuid-1');
    expect(mocks.insertConduction).toHaveBeenCalledWith(client, {
      task_id: 'uuid-1',
      mode: 'controlled',
    });

    // The excluded-check must run BEFORE the duplicate-guard create call.
    const excludedOrder = mocks.assertNotExcluded.mock.invocationCallOrder[0];
    const createOrder = mocks.insertConduction.mock.invocationCallOrder[0];
    expect(excludedOrder).toBeLessThan(createOrder);

    expect(result.conduction).toEqual(conductionRow);
    // B-758: the operator-contract sentence — non-optional, must appear verbatim in substance.
    expect(result.message).toMatch(
      /the duplicate-guard can only detect an active conduction record.*in-progress\s+terminal session.*stopped before handing it off/is,
    );
    expect(result.message).toContain('cond-9');
  });

  it('B-743: passes run_config through to the insert, validated, when given', async () => {
    await createConduction(client, 'proj-1', {
      task_id: 'B-758',
      run_config: { note: "don't touch the migration file" },
    });

    expect(mocks.insertConduction).toHaveBeenCalledWith(client, {
      task_id: 'uuid-1',
      mode: 'controlled',
      run_config: { note: "don't touch the migration file" },
    });
  });

  it('B-743: omits run_config from the insert entirely when not given — byte-for-byte unchanged for every pre-B-743 caller', async () => {
    await createConduction(client, 'proj-1', { task_id: 'B-758' });

    expect(mocks.insertConduction).toHaveBeenCalledWith(client, {
      task_id: 'uuid-1',
      mode: 'controlled',
    });
    const call = mocks.insertConduction.mock.calls[0][1];
    expect('run_config' in call).toBe(false);
  });

  it('B-743: rejects a malformed run_config before ever resolving/creating', async () => {
    await expect(
      createConduction(client, 'proj-1', {
        task_id: 'B-758',
        // @ts-expect-error -- deliberately malformed for the test
        run_config: { session_resume: { enabled: 'yes' } },
      }),
    ).rejects.toThrow();
    expect(mocks.insertConduction).not.toHaveBeenCalled();
  });

  it('rejects a missing task_id before any resolution', async () => {
    await expect(createConduction(client, 'proj-1', { task_id: '' })).rejects.toThrow(
      /task_id is required/,
    );
    expect(mocks.resolveTaskId).not.toHaveBeenCalled();
  });

  it('maps ConductorExcludedError to a clean "taken away from the conductor" refusal — never a raw error', async () => {
    mocks.assertNotExcluded.mockRejectedValue(new ConductorExcludedError('uuid-1'));

    const err = await createConduction(client, 'proj-1', { task_id: 'B-758' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/taken away from the conductor/i);
    expect(err.message).toMatch(/Return it first/i);
    // The clean message, not the raw internal ConductorExcludedError wording.
    expect(err.message).not.toMatch(/conductor_excluded_at is set/i);
    expect(mocks.insertConduction).not.toHaveBeenCalled();
  });

  it('maps ActiveConductionExistsError to a clean "already being conducted" refusal — never a raw postgres error', async () => {
    mocks.insertConduction.mockRejectedValue(new ActiveConductionExistsError('uuid-1', 'duplicate key value violates unique constraint'));

    const err = await createConduction(client, 'proj-1', { task_id: 'B-758' }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/already being conducted/i);
    // The clean message, not the raw lease-primitive internals / postgres text.
    expect(err.message).not.toMatch(/insert-or-fail/i);
    expect(err.message).not.toMatch(/duplicate key value/i);
  });

  it('re-throws any other operational error unchanged', async () => {
    mocks.insertConduction.mockRejectedValue(new Error('JWT expired'));
    await expect(createConduction(client, 'proj-1', { task_id: 'B-758' })).rejects.toThrow(
      'JWT expired',
    );
  });
});

describe('createConductionTool (MCP tool descriptor)', () => {
  it('names the tool create_conduction, requires task_id, and states the operator contract in its description', () => {
    expect(createConductionTool.name).toBe('create_conduction');
    expect(createConductionTool.inputSchema.required).toEqual(['task_id']);
    expect(createConductionTool.description).toMatch(
      /duplicate-guard can only detect an active conduction record/i,
    );
  });
});
