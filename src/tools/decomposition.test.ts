import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSubtasks, listParent } from './decomposition.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('root-uuid'),
}));

describe('listSubtasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns immediate children at depth=1', async () => {
    const client: any = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [{ id: 'c1', parent_task_id: 'root-uuid', title: 'Child A', status: 'To Do', archived: false }],
          error: null,
        }),
      })),
    };
    const result = await listSubtasks(client, 'proj-1', { task_id: 'root' });
    expect(result).toHaveLength(1);
    expect(client.from).toHaveBeenCalledWith('tasks');
  });
});

describe('listParent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns null when the task has no parent', async () => {
    const client: any = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockResolvedValue({ data: { parent_task_id: null }, error: null }),
      })),
    };
    const result = await listParent(client, 'proj-1', { task_id: 'B-1' });
    expect(result).toBeNull();
  });

  it('returns the parent task when set', async () => {
    let call = 0;
    const client: any = {
      from: vi.fn(() => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() => {
          call += 1;
          if (call === 1) return Promise.resolve({ data: { parent_task_id: 'p1' }, error: null });
          return Promise.resolve({ data: { id: 'p1', task_number: 1, title: 'Parent', status: 'In Progress' }, error: null });
        }),
      })),
    };
    const result = await listParent(client, 'proj-1', { task_id: 'B-1' });
    expect(result?.title).toBe('Parent');
  });
});
