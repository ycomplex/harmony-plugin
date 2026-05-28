// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTaskId, resolveTaskIds } from './resolve-task-id.js';

// Mock getProject
vi.mock('./project.js', () => ({
  getProject: vi.fn(),
}));

import { getProject } from './project.js';
const mockGetProject = vi.mocked(getProject);

// Helper to build a mock Supabase client
function mockClient(taskRow: { id: string } | null, error: any = null) {
  const single = vi.fn().mockResolvedValue({ data: taskRow, error });
  const eq2 = vi.fn().mockReturnValue({ single });
  const eq1 = vi.fn().mockReturnValue({ eq: eq2 });
  const select = vi.fn().mockReturnValue({ eq: eq1 });
  const from = vi.fn().mockReturnValue({ select });
  return { from, select, eq1, eq2, single } as any;
}

const PROJECT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TASK_UUID = '11111111-2222-3333-4444-555555555555';

describe('resolveTaskId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns UUID input as-is without any DB call', async () => {
    const client = mockClient(null);
    const result = await resolveTaskId(client, PROJECT_ID, TASK_UUID);
    expect(result).toBe(TASK_UUID);
    expect(client.from).not.toHaveBeenCalled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it('resolves bare task number to UUID', async () => {
    const client = mockClient({ id: TASK_UUID });
    const result = await resolveTaskId(client, PROJECT_ID, '43');
    expect(result).toBe(TASK_UUID);
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.select).toHaveBeenCalledWith('id');
    expect(client.eq1).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(client.eq2).toHaveBeenCalledWith('task_number', 43);
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it('resolves visual ID (B-43) to UUID', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockClient({ id: TASK_UUID });
    const result = await resolveTaskId(client, PROJECT_ID, 'B-43');
    expect(result).toBe(TASK_UUID);
    expect(mockGetProject).toHaveBeenCalledWith(client, PROJECT_ID);
    expect(client.eq2).toHaveBeenCalledWith('task_number', 43);
  });

  it('resolves visual ID case-insensitively (b-43)', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockClient({ id: TASK_UUID });
    const result = await resolveTaskId(client, PROJECT_ID, 'b-43');
    expect(result).toBe(TASK_UUID);
  });

  it('errors with helpful message when project key does not match', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, 'C-43')).rejects.toThrow(
      /this token is scoped to project B.*Did you mean B-43/
    );
    // Should NOT query tasks table — error before that
    expect(client.from).not.toHaveBeenCalled();
  });

  it('errors when task number is not found', async () => {
    const client = mockClient(null, { message: 'no rows', code: 'PGRST116' });
    await expect(resolveTaskId(client, PROJECT_ID, '999')).rejects.toThrow(
      /No task with number 999/
    );
  });

  it('errors on invalid format', async () => {
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, 'not-valid-at-all')).rejects.toThrow(
      /Invalid task identifier.*Use a UUID/
    );
  });

  it('errors on number exceeding PostgreSQL integer max', async () => {
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, '99999999999999')).rejects.toThrow(
      /Invalid task number/
    );
  });

  it('errors on zero task number', async () => {
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, '0')).rejects.toThrow(
      /Invalid task number/
    );
  });

  it('errors on visual ID with zero task number (B-0)', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, 'B-0')).rejects.toThrow(
      /Invalid task number/
    );
  });

  it('errors on negative number input', async () => {
    const client = mockClient(null);
    await expect(resolveTaskId(client, PROJECT_ID, '-1')).rejects.toThrow(
      /Invalid task identifier/
    );
  });
});

// Helper to build a mock Supabase client for the batched (.in) query.
function mockBatchClient(rows: Array<{ id: string; task_number: number }> | null, error: any = null) {
  const inFn = vi.fn().mockResolvedValue({ data: rows, error });
  const eq = vi.fn().mockReturnValue({ in: inFn });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  return { from, select, eq, in: inFn } as any;
}

const TASK_UUID_2 = '66666666-7777-8888-9999-aaaaaaaaaaaa';

describe('resolveTaskIds (batched)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a batch of bare numbers in a single query, preserving input order', async () => {
    const client = mockBatchClient([
      { id: 'id-7', task_number: 7 },
      { id: 'id-43', task_number: 43 },
    ]);
    const result = await resolveTaskIds(client, PROJECT_ID, ['43', '7']);
    expect(result).toEqual(['id-43', 'id-7']);
    expect(client.from).toHaveBeenCalledTimes(1);
    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.select).toHaveBeenCalledWith('id, task_number');
    expect(client.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(client.in).toHaveBeenCalledWith('task_number', [43, 7]);
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it('passes UUID inputs through without any DB call', async () => {
    const client = mockBatchClient(null);
    const result = await resolveTaskIds(client, PROJECT_ID, [TASK_UUID, TASK_UUID_2]);
    expect(result).toEqual([TASK_UUID, TASK_UUID_2]);
    expect(client.from).not.toHaveBeenCalled();
    expect(mockGetProject).not.toHaveBeenCalled();
  });

  it('resolves a mix of UUID, bare number, and visual ID in order', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockBatchClient([
      { id: 'id-7', task_number: 7 },
      { id: 'id-43', task_number: 43 },
    ]);
    const result = await resolveTaskIds(client, PROJECT_ID, [TASK_UUID, '7', 'B-43']);
    expect(result).toEqual([TASK_UUID, 'id-7', 'id-43']);
    expect(client.in).toHaveBeenCalledWith('task_number', [7, 43]);
    expect(mockGetProject).toHaveBeenCalledTimes(1);
  });

  it('validates the project key for visual IDs, fetching the project once', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockBatchClient([
      { id: 'id-1', task_number: 1 },
      { id: 'id-2', task_number: 2 },
    ]);
    const result = await resolveTaskIds(client, PROJECT_ID, ['B-1', 'B-2']);
    expect(result).toEqual(['id-1', 'id-2']);
    expect(mockGetProject).toHaveBeenCalledTimes(1);
  });

  it('errors (without querying) when a visual ID key does not match the project', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockBatchClient(null);
    await expect(resolveTaskIds(client, PROJECT_ID, ['7', 'C-43'])).rejects.toThrow(
      /this token is scoped to project B.*Did you mean B-43/
    );
    expect(client.from).not.toHaveBeenCalled();
  });

  it('deduplicates repeated task numbers in the IN query but keeps per-input output', async () => {
    mockGetProject.mockResolvedValue({ id: PROJECT_ID, key: 'B' } as any);
    const client = mockBatchClient([{ id: 'id-7', task_number: 7 }]);
    const result = await resolveTaskIds(client, PROJECT_ID, ['7', 'B-7', '7']);
    expect(result).toEqual(['id-7', 'id-7', 'id-7']);
    expect(client.in).toHaveBeenCalledWith('task_number', [7]);
  });

  it('issues exactly one tasks query regardless of how many numbers (no N+1)', async () => {
    const client = mockBatchClient([
      { id: 'id-1', task_number: 1 },
      { id: 'id-2', task_number: 2 },
      { id: 'id-3', task_number: 3 },
      { id: 'id-4', task_number: 4 },
      { id: 'id-5', task_number: 5 },
    ]);
    const result = await resolveTaskIds(client, PROJECT_ID, ['1', '2', '3', '4', '5']);
    expect(result).toHaveLength(5);
    expect(client.from).toHaveBeenCalledTimes(1);
  });

  it('returns an empty array for empty input without any DB call', async () => {
    const client = mockBatchClient(null);
    const result = await resolveTaskIds(client, PROJECT_ID, []);
    expect(result).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('errors listing task numbers that do not resolve', async () => {
    const client = mockBatchClient([{ id: 'id-7', task_number: 7 }]);
    await expect(resolveTaskIds(client, PROJECT_ID, ['7', '999'])).rejects.toThrow(/999/);
  });

  it('errors (without querying) on an invalid identifier', async () => {
    const client = mockBatchClient(null);
    await expect(resolveTaskIds(client, PROJECT_ID, ['7', 'not-valid-at-all'])).rejects.toThrow(
      /Invalid task identifier.*Use a UUID/
    );
    expect(client.from).not.toHaveBeenCalled();
  });

  it('errors (without querying) on a number exceeding the PostgreSQL integer max', async () => {
    const client = mockBatchClient(null);
    await expect(resolveTaskIds(client, PROJECT_ID, ['99999999999999'])).rejects.toThrow(
      /Invalid task number/
    );
    expect(client.from).not.toHaveBeenCalled();
  });
});
