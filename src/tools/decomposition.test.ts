import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listSubtasks, listParent, manageSubtasks } from './decomposition.js';

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

describe('manageSubtasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inherits project and epic when add_new omits them', async () => {
    const insertSpy = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [{ id: 'c1' }], error: null }) }));
    const fromMock = vi.fn((table: string) => {
      if (table !== 'tasks') return { from: vi.fn() };
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: { project_id: 'proj-1', epic_id: 'epic-1' }, error: null }),
          })),
        })),
        insert: insertSpy,
      };
    });
    const client: any = { from: fromMock };

    await manageSubtasks(client, 'proj-1', 'user-1', {
      task_id: 'parent-1',
      add_new: [{ title: 'New child' }],
    });

    const insertedRows = insertSpy.mock.calls[0][0];
    expect(insertedRows[0].project_id).toBe('proj-1');
    expect(insertedRows[0].epic_id).toBe('epic-1');
    expect(insertedRows[0].parent_task_id).toBeDefined();
    // B-465: add_new must default status explicitly so the documented example (which omits
    // status) works without relying on supabase-js dropping undefined + the DB default.
    expect(insertedRows[0].status).toBe('Backlog');
  });

  it('rejects self-attach', async () => {
    const fromMock = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: { project_id: 'proj-1', epic_id: null }, error: null }),
        })),
      })),
    }));
    const client: any = { from: fromMock };
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockResolvedValue('same-uuid');
    await expect(
      manageSubtasks(client, 'proj-1', 'user-1', { task_id: 'p1', add: ['p1'] }),
    ).rejects.toThrow(/own subtask/);
  });
});
