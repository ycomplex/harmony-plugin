// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTaskId } from './resolve-task-id.js';

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
