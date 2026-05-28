import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateTask, createTask, getTask, bulkCreateTasks } from './tasks.js';

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
    ).rejects.toThrow(/unfinished dependencies or subtasks/i);
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

  // `tasks` table is queried two ways inside createTask:
  //   1. position lookup: .select().eq().eq().order().limit()
  //   2. parent epic lookup: .select().eq().single()
  // A single chainable object that resolves at .limit() (position) and
  // .single() (parent row) satisfies both.
  function makeClient(insertSpy: ReturnType<typeof vi.fn>, positionData: any[], parentRow: any) {
    const insertResult = {
      select: () => ({ single: vi.fn().mockResolvedValue({ data: { id: 'new-id', project_id: 'proj-1' }, error: null }) }),
    };
    return {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          const chain: any = {
            eq: () => chain,
            order: () => chain,
            limit: vi.fn().mockResolvedValue({ data: positionData, error: null }),
            single: vi.fn().mockResolvedValue({ data: parentRow, error: null }),
          };
          return {
            select: () => chain,
            insert: (payload: any) => { insertSpy(payload); return insertResult; },
          };
        }
        return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
    } as any;
  }

  it('resolves parent_task_id and inherits the parent epic when none is given', async () => {
    const insertSpy = vi.fn();
    const client = makeClient(insertSpy, [{ position: 2 }], { project_id: 'proj-1', epic_id: 'epic-from-parent' });

    await createTask(client, 'proj-1', 'user-1', { title: 'Child', parent_task_id: 'C-88' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({
      parent_task_id: 'resolved-parent-uuid',
      epic_id: 'epic-from-parent',
    });
  });

  it('respects an explicit epic_id over the parent epic', async () => {
    const insertSpy = vi.fn();
    const client = makeClient(insertSpy, [], { project_id: 'proj-1', epic_id: 'epic-from-parent' });

    await createTask(client, 'proj-1', 'user-1', { title: 'Child', parent_task_id: 'C-88', epic_id: 'explicit-epic' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({ epic_id: 'explicit-epic' });
  });

  it('does not inherit a cross-project parent epic', async () => {
    const insertSpy = vi.fn();
    const client = makeClient(insertSpy, [], { project_id: 'other-project', epic_id: 'foreign-epic' });

    await createTask(client, 'proj-1', 'user-1', { title: 'Child', parent_task_id: 'C-88' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({ epic_id: null });
  });

  it('defaults parent_task_id and epic_id to null when no parent is given', async () => {
    const insertSpy = vi.fn();
    const client = makeClient(insertSpy, [], null);

    await createTask(client, 'proj-1', 'user-1', { title: 'Standalone' });

    expect(insertSpy.mock.calls[0][0]).toMatchObject({ parent_task_id: null, epic_id: null });
  });
});

describe('getTask', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
  });

  it('embeds checklist_items (the renamed table) — not the dropped subtasks relation', async () => {
    const selectSpy = vi.fn();
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            select: (sel: string) => {
              selectSpy(sel);
              return {
                eq: () => ({
                  eq: () => ({
                    single: vi.fn().mockResolvedValue({
                      data: {
                        id: 'resolved-uuid',
                        title: 'T',
                        task_labels: [],
                        checklist_items: [{ id: 'ci1', title: 'item', completed: false, position: 0 }],
                      },
                      error: null,
                    }),
                  }),
                }),
              };
            },
          };
        }
        // acceptance_criteria / test_cases: .select().eq().order()
        return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
      }),
    };

    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });

    // The embed must target the renamed table, never the dropped `subtasks` relation.
    expect(selectSpy.mock.calls[0][0]).toContain('checklist_items(');
    expect(selectSpy.mock.calls[0][0]).not.toContain('subtasks(');
    // And the result surfaces them under the new field name.
    expect(result.checklist_items).toHaveLength(1);
    expect((result as any).subtasks).toBeUndefined();
  });
});

describe('bulkCreateTasks', () => {
  // bulk create queries `tasks` two ways:
  //   1. position lookup (the thing under test): one scoped query per distinct status —
  //      .select('position').eq('project_id').eq('status').order().limit(1)
  //   2. insert: .insert(rows).select()
  // This mock resolves the position lookup at .limit() with the per-status max, and
  // captures the inserted rows so positions can be asserted. Spies record the query
  // shape so we can prove the full-table scan is gone.
  function makeBulkClient(opts: {
    maxByStatus: Record<string, number | undefined>;
    insertSpy: (rows: any[]) => void;
    selectSpy?: (sel: string) => void;
    limitSpy?: () => void;
    statusEqSpy?: (val: string) => void;
  }) {
    return {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          let capturedStatus: string | undefined;
          const chain: any = {
            eq: vi.fn((col: string, val: string) => {
              if (col === 'status') {
                capturedStatus = val;
                opts.statusEqSpy?.(val);
              }
              return chain;
            }),
            order: vi.fn(() => chain),
            limit: vi.fn(() => {
              opts.limitSpy?.();
              const max = opts.maxByStatus[capturedStatus as string];
              return Promise.resolve({
                data: max === undefined ? [] : [{ position: max }],
                error: null,
              });
            }),
          };
          return {
            select: vi.fn((sel: string) => {
              opts.selectSpy?.(sel);
              return chain;
            }),
            insert: vi.fn((rows: any[]) => {
              opts.insertSpy(rows);
              return {
                select: vi.fn().mockResolvedValue({
                  data: rows.map((r: any, i: number) => ({ ...r, id: `id-${i}` })),
                  error: null,
                }),
              };
            }),
          };
        }
        // activity_events insert
        return { insert: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
    } as any;
  }

  it('continues positions sequentially from the existing max for a single status', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({ maxByStatus: { Backlog: 2 }, insertSpy });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'a' }, { title: 'b' }, { title: 'c' }],
    });

    const rows = insertSpy.mock.calls[0][0];
    expect(rows.map((r: any) => r.position)).toEqual([3, 4, 5]);
  });

  it('seeds each status independently from its own max', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { 'To Do': 5, Done: undefined },
      insertSpy,
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [
        { title: 'a', status: 'To Do' },
        { title: 'b', status: 'To Do' },
        { title: 'c', status: 'Done' },
      ],
    });

    const rows = insertSpy.mock.calls[0][0];
    const byStatus = (s: string) =>
      rows.filter((r: any) => r.status === s).map((r: any) => r.position);
    expect(byStatus('To Do')).toEqual([6, 7]);
    expect(byStatus('Done')).toEqual([0]);
  });

  it('starts a status with no existing rows at position 0', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({ maxByStatus: {}, insertSpy });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'a', status: 'Archived' }],
    });

    expect(insertSpy.mock.calls[0][0][0].position).toBe(0);
  });

  it('uses a scoped per-status query, not a full-table scan', async () => {
    const insertSpy = vi.fn();
    const selectSpy = vi.fn();
    const limitSpy = vi.fn();
    const statusEqSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: 0 },
      insertSpy,
      selectSpy,
      limitSpy,
      statusEqSpy,
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', { tasks: [{ title: 'a' }] });

    // Regression guard: the old code fetched every row via .select('status, position')
    // with no status filter and no limit. The fix scopes by status and takes one row.
    expect(statusEqSpy).toHaveBeenCalledWith('Backlog');
    expect(limitSpy).toHaveBeenCalled();
    expect(selectSpy).toHaveBeenCalledWith('position');
    expect(selectSpy).not.toHaveBeenCalledWith('status, position');
  });
});
