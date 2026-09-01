// B-894: `list_conductions` — the MCP tool test suite.
//
// Mirrors create-conduction.test.ts's mocking convention (the tool handler layer): resolveTaskId
// and the shared-core listConductions primitive are mocked; this suite is about the tool's own
// contract — the task filter, newest-first ordering, the empty-list answer, and the EXACT ten-field
// lean row shape.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  listConductions,
  listConductionsTool,
  CONDUCTION_SUMMARY_FIELDS,
} from './list-conductions.js';

const mocks = vi.hoisted(() => ({
  resolveTaskId: vi.fn(),
  listConductionRecords: vi.fn(),
}));

vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: mocks.resolveTaskId }));
vi.mock('./conduction-record.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conduction-record.js')>();
  return { ...actual, listConductions: mocks.listConductionRecords };
});

const client = { fake: 'client' } as never;

// A FULL conduction record — every column the shared core selects, including the ones this tool
// must NOT leak (lease_holder, worker_kind, last_worker_exit_code, current_pr_ref, run_config,
// created_by, leg_started_at, clean_shutdown_at, lease_acquired_at, task_id).
const fullRow = {
  id: 'cond-1',
  task_id: 'uuid-1',
  status: 'active',
  mode: 'controlled',
  lease_holder: 'daemon-a',
  lease_acquired_at: '2026-08-30T00:00:00Z',
  last_heartbeat_at: '2026-08-30T00:05:00Z',
  leg_started_at: '2026-08-30T00:01:00Z',
  clean_shutdown_at: null,
  reap_requested_at: null,
  retry_count: 2,
  worker_kind: 'cloud',
  worker_ref: 'run-42',
  last_worker_exit_code: 0,
  last_worker_exit_class: 'clean',
  current_pr_ref: 'https://github.com/x/y/pull/1',
  started_at: '2026-08-30T00:00:00Z',
  created_by: 'user-7',
  created_at: '2026-08-30T00:00:00Z',
  updated_at: '2026-08-30T00:06:00Z',
  run_config: { note: 'secret' },
  task_priority: 'high',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveTaskId.mockResolvedValue('uuid-1');
  mocks.listConductionRecords.mockResolvedValue([fullRow]);
});

describe('listConductions (list_conductions MCP tool handler)', () => {
  it("resolves the ticket and filters the read to THAT task's conductions", async () => {
    await listConductions(client, 'proj-1', { task_id: 'B-894' });

    expect(mocks.resolveTaskId).toHaveBeenCalledWith(client, 'proj-1', 'B-894');
    expect(mocks.listConductionRecords).toHaveBeenCalledWith(client, {
      task_id: 'uuid-1',
      order: 'desc',
    });
  });

  it('asks for NEWEST FIRST and returns the rows in that order', async () => {
    const older = { ...fullRow, id: 'cond-old', started_at: '2026-08-01T00:00:00Z' };
    const newer = { ...fullRow, id: 'cond-new', started_at: '2026-08-30T00:00:00Z' };
    // The primitive is asked for descending order and returns in it — the tool preserves it.
    mocks.listConductionRecords.mockResolvedValue([newer, older]);

    const result = await listConductions(client, 'proj-1', { task_id: 'B-894' });

    expect(mocks.listConductionRecords.mock.calls[0][1]).toMatchObject({ order: 'desc' });
    expect(result.conductions.map((c) => c.id)).toEqual(['cond-new', 'cond-old']);
  });

  it('returns an EMPTY LIST (never an error) for a ticket that was never conducted', async () => {
    mocks.listConductionRecords.mockResolvedValue([]);

    const result = await listConductions(client, 'proj-1', { task_id: 'B-1' });

    expect(result.conductions).toEqual([]);
  });

  it('returns the EXACT ten-field lean row — no more, no fewer', async () => {
    const result = await listConductions(client, 'proj-1', { task_id: 'B-894' });
    const row = result.conductions[0];

    // Exact key set: an accidental field ADDITION or REMOVAL fails here.
    expect(Object.keys(row).sort()).toEqual([...CONDUCTION_SUMMARY_FIELDS].sort());
    expect(Object.keys(row)).toHaveLength(10);
    expect([...CONDUCTION_SUMMARY_FIELDS].sort()).toEqual(
      [
        'id',
        'status',
        'mode',
        'started_at',
        'last_heartbeat_at',
        'reap_requested_at',
        'last_worker_exit_class',
        'updated_at',
        'worker_ref',
        'retry_count',
      ].sort(),
    );

    expect(row).toEqual({
      id: 'cond-1',
      status: 'active',
      mode: 'controlled',
      started_at: '2026-08-30T00:00:00Z',
      last_heartbeat_at: '2026-08-30T00:05:00Z',
      reap_requested_at: null,
      last_worker_exit_class: 'clean',
      updated_at: '2026-08-30T00:06:00Z',
      worker_ref: 'run-42',
      retry_count: 2,
    });
  });

  it('leaks NONE of the deliberately-excluded daemon/internal fields', async () => {
    const result = await listConductions(client, 'proj-1', { task_id: 'B-894' });
    const row = result.conductions[0] as unknown as Record<string, unknown>;

    for (const excluded of [
      'lease_holder',
      'worker_kind',
      'last_worker_exit_code',
      'current_pr_ref',
      'run_config',
      'created_by',
      'leg_started_at',
      'clean_shutdown_at',
      'lease_acquired_at',
      'task_id',
      'task_priority',
      'created_at',
    ]) {
      expect(excluded in row).toBe(false);
    }
  });

  it('rejects a missing task_id before any resolution', async () => {
    await expect(listConductions(client, 'proj-1', { task_id: '' })).rejects.toThrow(
      /task_id is required/,
    );
    expect(mocks.resolveTaskId).not.toHaveBeenCalled();
    expect(mocks.listConductionRecords).not.toHaveBeenCalled();
  });
});

describe('listConductionsTool (MCP tool descriptor)', () => {
  it('names the tool list_conductions and requires task_id', () => {
    expect(listConductionsTool.name).toBe('list_conductions');
    expect(listConductionsTool.inputSchema.required).toEqual(['task_id']);
  });

  it("tells a future session this is how request_conduction_reap's conduction_id becomes addressable", () => {
    expect(listConductionsTool.description).toMatch(/request_conduction_reap/);
    expect(listConductionsTool.description).toMatch(/conduction_id/);
    expect(listConductionsTool.description).toMatch(/newest first/i);
    expect(listConductionsTool.description).toMatch(/empty list/i);
  });
});
