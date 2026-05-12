import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateTask } from './tasks.js';

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
});
