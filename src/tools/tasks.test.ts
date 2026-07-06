import { describe, it, expect, vi, beforeEach } from 'vitest';
import { updateTask, createTask, getTask, bulkCreateTasks } from './tasks.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
  resolveTaskIds: vi.fn(),
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

  // B-629: a nullable FK can be cleared by passing real JSON `null`, mirroring parent_task_id.
  // Captures the UPDATE payload via a single update spy shared across all tables (no status
  // change → no projects lookup or rpc).
  function makeUpdatePayloadClient(updatePayloadSpy: ReturnType<typeof vi.fn>) {
    return {
      from: vi.fn(() => ({ update: updatePayloadSpy })),
      rpc: vi.fn(),
    } as any;
  }
  function makeUpdateSpy(resultData: any) {
    return vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({ data: resultData, error: null }),
          })),
        })),
      })),
    }));
  }

  it('B-629: clears subsumed_by_task_id by passing JSON null (un-fold the pointer)', async () => {
    const updatePayloadSpy = makeUpdateSpy({ id: 'resolved-uuid', subsumed_by_task_id: null });
    const client = makeUpdatePayloadClient(updatePayloadSpy);

    await updateTask(client, 'proj-1', { task_id: 'B-2', subsumed_by_task_id: null });

    expect(updatePayloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subsumed_by_task_id: null }),
    );
  });

  it('B-582: clears milestone_id by passing JSON null', async () => {
    const updatePayloadSpy = makeUpdateSpy({ id: 'resolved-uuid', milestone_id: null });
    const client = makeUpdatePayloadClient(updatePayloadSpy);

    await updateTask(client, 'proj-1', { task_id: 'B-2', milestone_id: null });

    expect(updatePayloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ milestone_id: null }),
    );
  });

  it('B-629: a full un-fold call clears subsumed_by_task_id and sets archived:false in one update', async () => {
    const updatePayloadSpy = makeUpdateSpy({ id: 'resolved-uuid', subsumed_by_task_id: null, archived: false });
    const client = makeUpdatePayloadClient(updatePayloadSpy);

    await updateTask(client, 'proj-1', { task_id: 'B-2', archived: false, subsumed_by_task_id: null });

    expect(updatePayloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subsumed_by_task_id: null, archived: false }),
    );
  });

  it('B-629: resolves a visual subsumed_by_task_id to a UUID before writing (mirrors parent_task_id)', async () => {
    const resolveMock = (await import('./resolve-task-id.js'))
      .resolveTaskId as ReturnType<typeof vi.fn>;
    // First call resolves the task being updated, second resolves the umbrella.
    resolveMock.mockResolvedValueOnce('child-uuid').mockResolvedValueOnce('umbrella-uuid');

    const updatePayloadSpy = makeUpdateSpy({ id: 'child-uuid', subsumed_by_task_id: 'umbrella-uuid' });
    const client = makeUpdatePayloadClient(updatePayloadSpy);

    await updateTask(client, 'proj-1', { task_id: 'B-2', subsumed_by_task_id: 'B-10' });

    expect(updatePayloadSpy).toHaveBeenCalledWith(
      expect.objectContaining({ subsumed_by_task_id: 'umbrella-uuid' }),
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
        if (table === 'attachments') {
          // B-449: .select().eq('task_id').eq('status').order(...)
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  order: vi.fn().mockResolvedValue({
                    data: [
                      {
                        id: 'att-1',
                        filename: 'spec.pdf',
                        content_type: 'application/pdf',
                        byte_size: 1234,
                        created_at: '2026-06-15T00:00:00Z',
                      },
                    ],
                    error: null,
                  }),
                }),
              }),
            }),
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

  it('B-449: surfaces attachment metadata (additive, finalized-only)', async () => {
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'resolved-uuid', title: 'T', task_labels: [], checklist_items: [] },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          const orderSpy = vi.fn().mockResolvedValue({
            data: [
              { id: 'att-1', filename: 'spec.pdf', content_type: 'application/pdf', byte_size: 1234, created_at: '2026-06-15T00:00:00Z' },
            ],
            error: null,
          });
          const statusEq = vi.fn(() => ({ order: orderSpy }));
          const taskEq = vi.fn(() => ({ eq: statusEq }));
          return { select: vi.fn(() => ({ eq: taskEq })), __statusEq: statusEq };
        }
        return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
      }),
    };

    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });

    expect((result as any).attachments).toHaveLength(1);
    expect((result as any).attachments[0]).toMatchObject({ id: 'att-1', filename: 'spec.pdf' });
  });

  it('B-449: tolerates a missing/blocked attachments table — get_task does not regress', async () => {
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'resolved-uuid', title: 'T', task_labels: [], checklist_items: [] },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          // simulate the select chain throwing (e.g. table absent on an old DB)
          return { select: () => ({ eq: () => ({ eq: () => ({ order: vi.fn().mockRejectedValue(new Error('relation "attachments" does not exist')) }) }) }) };
        }
        return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
      }),
    };

    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });
    expect((result as any).attachments).toEqual([]);
    expect(result.title).toBe('T');
  });

  it('B-485: surfaces the active brief pending_resolution so the conductor can poll get_task for a reshape', async () => {
    const pending = { command: 'iterate', detail: 'narrow to the auth flow' };
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'resolved-uuid', title: 'T', task_labels: [], checklist_items: [], workflow_state: 'Proposed', awaiting_human_input: false },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'briefs') {
          // fetchPendingResolution: .select('pending_resolution').eq('task_id').eq('status').maybeSingle()
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: vi.fn().mockResolvedValue({ data: { pending_resolution: pending }, error: null }),
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          return { select: () => ({ eq: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) }) };
        }
        // acceptance_criteria / test_cases
        return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
      }),
    };

    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });
    expect((result as any).pending_resolution).toEqual(pending);
  });

  it('B-485: pending_resolution is null when the briefs read fails (older DB) — get_task does not regress', async () => {
    const client: any = {
      from: vi.fn((table: string) => {
        if (table === 'tasks') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  single: vi.fn().mockResolvedValue({
                    data: { id: 'resolved-uuid', title: 'T', task_labels: [], checklist_items: [] },
                    error: null,
                  }),
                }),
              }),
            }),
          };
        }
        if (table === 'briefs') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: vi.fn().mockResolvedValue({ data: null, error: { message: 'column briefs.pending_resolution does not exist' } }),
                }),
              }),
            }),
          };
        }
        if (table === 'attachments') {
          return { select: () => ({ eq: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) }) };
        }
        return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
      }),
    };

    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });
    expect((result as any).pending_resolution).toBeNull();
    expect(result.title).toBe('T');
  });

  // B-493: get_task computes a deterministic `risk_classes` floor signal.
  // This mock supports the briefs chain (.select().eq().eq().maybeSingle()) so the
  // active brief's content contributes to the scanned text.
  const makeRiskClient = (opts: {
    title: string;
    description?: string;
    briefContent?: string;
  }): any => ({
    from: vi.fn((table: string) => {
      if (table === 'tasks') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: vi.fn().mockResolvedValue({
                  data: {
                    id: 'resolved-uuid',
                    title: opts.title,
                    description: opts.description ?? null,
                    task_labels: [],
                    checklist_items: [],
                  },
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'briefs') {
        // .select('content').eq('task_id').eq('status').maybeSingle()
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: opts.briefContent ? { content: opts.briefContent } : null,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === 'attachments') {
        return { select: () => ({ eq: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) }) };
      }
      // acceptance_criteria / test_cases
      return { select: () => ({ eq: () => ({ order: vi.fn().mockResolvedValue({ data: [], error: null }) }) }) };
    }),
  });

  it('returns risk_classes computed from ticket text + active brief', async () => {
    // Clean ticket text, but the active brief's drafted decision introduces an RLS policy → auth trips.
    const client = makeRiskClient({
      title: 'Improve the dashboard header',
      description: 'Tidy the copy and spacing.',
      briefContent: 'Decision: add an RLS policy so the row is only visible to its owner.',
    });
    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });
    expect((result as any).risk_classes).toEqual(['auth']);
  });

  it('returns an empty risk_classes for a benign ticket with no active brief', async () => {
    const client = makeRiskClient({ title: 'Add a dropdown', description: 'New menu component.' });
    const result = await getTask(client, 'proj-1', { task_id: 'B-1' });
    expect((result as any).risk_classes).toEqual([]);
  });

  it('accepts optional changed_paths and adds path-based risk matches', async () => {
    const client = makeRiskClient({ title: 'Refactor a helper', description: 'No behaviour change.' });
    const result = await getTask(client, 'proj-1', {
      task_id: 'B-1',
      changed_paths: ['supabase/migrations/20260618_add_col.sql', 'src/auth.ts'],
    });
    // migration path → data-migration; auth.ts path → auth + shared-core; canonical order.
    expect((result as any).risk_classes).toEqual(['auth', 'data-migration', 'shared-core']);
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
    // B-447: rows the parent-metadata lookup (.select('id, project_id, epic_id').in('id', uuids))
    // resolves to, so epic inheritance can be asserted.
    parentRows?: any[];
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
            // B-447: parent-metadata batch lookup terminates at .in('id', uuids).
            in: vi.fn(() => Promise.resolve({ data: opts.parentRows ?? [], error: null })),
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

  beforeEach(async () => {
    // Default: resolveTaskIds echoes each input to a predictable `resolved-<input>` UUID,
    // preserving order (the real impl resolves an array in one query and keeps order).
    const resolveIdsMock = (await import('./resolve-task-id.js'))
      .resolveTaskIds as ReturnType<typeof vi.fn>;
    resolveIdsMock.mockReset();
    resolveIdsMock.mockImplementation(async (_c: any, _p: any, inputs: string[]) =>
      inputs.map(i => `resolved-${i}`),
    );
  });

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

  // B-447: bulk_create_tasks gains per-item parent_task_id, reaching parity with create_task.
  it('B-447: stamps the resolved parent_task_id on a row given a valid parent', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: -1 },
      insertSpy,
      parentRows: [{ id: 'resolved-C-88', project_id: 'proj-1', epic_id: 'epic-from-parent' }],
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'child', parent_task_id: 'C-88' }],
    });

    const rows = insertSpy.mock.calls[0][0];
    expect(rows[0]).toMatchObject({ parent_task_id: 'resolved-C-88', epic_id: 'epic-from-parent' });
  });

  it('B-447: nests multiple items under the same parent and items under different parents', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: -1 },
      insertSpy,
      parentRows: [
        { id: 'resolved-P-1', project_id: 'proj-1', epic_id: 'epic-1' },
        { id: 'resolved-P-2', project_id: 'proj-1', epic_id: 'epic-2' },
      ],
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [
        { title: 'a', parent_task_id: 'P-1' },
        { title: 'b', parent_task_id: 'P-1' },
        { title: 'c', parent_task_id: 'P-2' },
      ],
    });

    const rows = insertSpy.mock.calls[0][0];
    expect(rows.map((r: any) => r.parent_task_id)).toEqual([
      'resolved-P-1',
      'resolved-P-1',
      'resolved-P-2',
    ]);
    // Each item inherits its own parent's epic.
    expect(rows.map((r: any) => r.epic_id)).toEqual(['epic-1', 'epic-1', 'epic-2']);
  });

  it('B-447: an item omitting parent_task_id gets parent_task_id null (no regression)', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({ maxByStatus: { Backlog: -1 }, insertSpy });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'standalone' }],
    });

    const resolveIdsMock = (await import('./resolve-task-id.js'))
      .resolveTaskIds as ReturnType<typeof vi.fn>;
    // No parent inputs → resolveTaskIds is never called.
    expect(resolveIdsMock).not.toHaveBeenCalled();
    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({ parent_task_id: null, epic_id: null });
  });

  it('B-447: inherits the same-project parent epic when no epic_id is given', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: -1 },
      insertSpy,
      parentRows: [{ id: 'resolved-C-88', project_id: 'proj-1', epic_id: 'inherited-epic' }],
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'child', parent_task_id: 'C-88' }],
    });

    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({ epic_id: 'inherited-epic' });
  });

  it('B-447: an explicit epic_id wins over the inherited parent epic', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: -1 },
      insertSpy,
      parentRows: [{ id: 'resolved-C-88', project_id: 'proj-1', epic_id: 'epic-from-parent' }],
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'child', parent_task_id: 'C-88', epic_id: 'explicit-epic' }],
    });

    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({ epic_id: 'explicit-epic' });
  });

  it('B-447: does not inherit a cross-project parent epic (epic_id null)', async () => {
    const insertSpy = vi.fn();
    const client = makeBulkClient({
      maxByStatus: { Backlog: -1 },
      insertSpy,
      parentRows: [{ id: 'resolved-C-88', project_id: 'other-project', epic_id: 'foreign-epic' }],
    });

    await bulkCreateTasks(client, 'proj-1', 'user-1', {
      tasks: [{ title: 'child', parent_task_id: 'C-88' }],
    });

    expect(insertSpy.mock.calls[0][0][0]).toMatchObject({
      parent_task_id: 'resolved-C-88',
      epic_id: null,
    });
  });

  it('B-447: rejects the whole call (no insert) when a parent_task_id is invalid', async () => {
    const insertSpy = vi.fn();
    const resolveIdsMock = (await import('./resolve-task-id.js'))
      .resolveTaskIds as ReturnType<typeof vi.fn>;
    resolveIdsMock.mockReset();
    resolveIdsMock.mockRejectedValueOnce(new Error('No task(s) with number(s) 999 in this project'));

    const client = makeBulkClient({ maxByStatus: { Backlog: -1 }, insertSpy });

    await expect(
      bulkCreateTasks(client, 'proj-1', 'user-1', {
        tasks: [{ title: 'a', parent_task_id: 'C-999' }],
      }),
    ).rejects.toThrow(/No task\(s\) with number/);
    expect(insertSpy).not.toHaveBeenCalled();
  });
});
