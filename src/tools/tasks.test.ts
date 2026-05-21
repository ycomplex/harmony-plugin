import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateTask, createTask } from './tasks.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
}));

vi.mock('./members.js', () => ({
  resolveAssignee: vi.fn().mockResolvedValue('assignee-uuid'),
}));

describe('updateTask', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('rejects status change to terminal when task is blocked', async () => {
    const tasksUpdate = vi.fn();
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: () => ({
              eq: () => ({
                single: vi.fn().mockResolvedValue({
                  data: { custom_statuses: ['Backlog', 'To Do', 'Done'] },
                  error: null,
                }),
              }),
            }),
          };
        }
        // tasks table — not expected to be called because the pre-flight throws first
        return {
          update: tasksUpdate,
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
    };

    await expect(
      updateTask(client, 'proj-1', { task_id: 'B-1', status: 'Done' }),
    ).rejects.toThrow(/unresolved blockers/i);
    expect(client.rpc).toHaveBeenCalledWith('task_blocked_from_terminal', {
      _task_id: 'resolved-uuid',
    });
    expect(tasksUpdate).not.toHaveBeenCalled();
  });

  it('allows status change to terminal when task is not blocked', async () => {
    const updateSingle = vi.fn().mockResolvedValue({
      data: { id: 'resolved-uuid', status: 'Done' },
      error: null,
    });
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: () => ({
              eq: () => ({
                single: vi.fn().mockResolvedValue({
                  data: { custom_statuses: ['Backlog', 'To Do', 'Done'] },
                  error: null,
                }),
              }),
            }),
          };
        }
        // tasks table — update chain
        return {
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: updateSingle,
                })),
              })),
            })),
          })),
        };
      }),
      rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
    };

    const result = await updateTask(client, 'proj-1', {
      task_id: 'B-1',
      status: 'Done',
    });
    expect(client.rpc).toHaveBeenCalledWith('task_blocked_from_terminal', {
      _task_id: 'resolved-uuid',
    });
    expect(result).toEqual({ id: 'resolved-uuid', status: 'Done' });
  });

  it('skips the blocker check for non-terminal status changes', async () => {
    const updateSingle = vi.fn().mockResolvedValue({
      data: { id: 'resolved-uuid', status: 'To Do' },
      error: null,
    });
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'projects') {
          return {
            select: () => ({
              eq: () => ({
                single: vi.fn().mockResolvedValue({
                  data: { custom_statuses: ['Backlog', 'To Do', 'Done'] },
                  error: null,
                }),
              }),
            }),
          };
        }
        return {
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  single: updateSingle,
                })),
              })),
            })),
          })),
        };
      }),
      rpc: vi.fn(),
    };

    await updateTask(client, 'proj-1', { task_id: 'B-1', status: 'To Do' });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('resolves and passes parent_task_id to update payload', async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    // First call resolves child task, second resolves the parent
    resolveMock.mockResolvedValueOnce('child-uuid').mockResolvedValueOnce('parent-uuid');

    const updatePayloadSpy = vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: { id: 'child-uuid', parent_task_id: 'parent-uuid' },
              error: null,
            }),
          })),
        })),
      })),
    }));

    const client: any = {
      from: vi.fn(() => ({
        update: updatePayloadSpy,
      })),
      rpc: vi.fn(),
    };

    await updateTask(client, 'proj-1', { task_id: 'B-2', parent_task_id: 'p1' });

    expect(updatePayloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ parent_task_id: 'parent-uuid' }),
    );
  });
});

describe('createTask', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-parent-uuid');
  });

  function makeClient(insertSpy: ReturnType<typeof vi.fn>, positionData: any[]) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            // position lookup: .select().eq().eq().order().limit()
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: vi.fn().mockResolvedValue({ data: positionData, error: null }),
                  }),
                }),
              }),
            }),
            insert: insertSpy,
          };
        }
        // activity_events insert
        return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
    } as any;
  }

  it('resolves and sets parent_task_id on the inserted task', async () => {
    const insertSpy = vi.fn(() => ({
      select: () => ({ single: vi.fn().mockResolvedValue({ data: { id: 'new-id', project_id: 'proj-1' }, error: null }) }),
    }));
    const client = makeClient(insertSpy, [{ position: 2 }]);

    await createTask(client, 'proj-1', 'user-1', { title: 'Child', parent_task_id: 'C-88' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({ parent_task_id: 'resolved-parent-uuid' });
  });

  it('defaults parent_task_id to null when omitted', async () => {
    const insertSpy = vi.fn(() => ({
      select: () => ({ single: vi.fn().mockResolvedValue({ data: { id: 'new-id', project_id: 'proj-1' }, error: null }) }),
    }));
    const client = makeClient(insertSpy, []);

    await createTask(client, 'proj-1', 'user-1', { title: 'Standalone' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({ parent_task_id: null });
  });
});
