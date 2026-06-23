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

  // B-556: list_subtasks must expose each child's real workflow_state (+ awaiting/stale
  // lifecycle fields), not just the legacy status — which is inert in opinionated mode.
  it('selects the lifecycle fields and passes workflow_state through (B-556)', async () => {
    const selectSpy = vi.fn().mockReturnThis();
    const client: any = {
      from: vi.fn(() => ({
        select: selectSpy,
        in: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({
          data: [{
            id: 'c1', parent_task_id: 'root-uuid', title: 'Child A',
            status: 'Backlog', workflow_state: 'Designed',
            awaiting_human_input: false, awaiting_human_reason: null, stale: false,
            archived: false,
          }],
          error: null,
        }),
      })),
    };
    const result = await listSubtasks(client, 'proj-1', { task_id: 'root' });
    const cols = selectSpy.mock.calls[0][0] as string;
    expect(cols).toContain('workflow_state');
    expect(cols).toContain('awaiting_human_input');
    expect(cols).toContain('awaiting_human_reason');
    expect(cols).toContain('stale');
    expect(cols).toContain('status'); // legacy field retained (back-compat)
    expect(result[0].workflow_state).toBe('Designed');
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

  // B-556: list_parent has the identical gap — the parent fetch must also carry the
  // lifecycle fields so a caller sees the parent's real workflow_state.
  it('selects the lifecycle fields on the parent fetch and passes workflow_state through (B-556)', async () => {
    let call = 0;
    const selectSpy = vi.fn().mockReturnThis();
    const client: any = {
      from: vi.fn(() => ({
        select: selectSpy,
        eq: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() => {
          call += 1;
          if (call === 1) return Promise.resolve({ data: { parent_task_id: 'p1' }, error: null });
          return Promise.resolve({
            data: {
              id: 'p1', task_number: 1, title: 'Parent', status: 'In Progress',
              workflow_state: 'Built', awaiting_human_input: true,
              awaiting_human_reason: 'release-decision-pending', stale: false,
            },
            error: null,
          });
        }),
      })),
    };
    const result = await listParent(client, 'proj-1', { task_id: 'B-1' });
    // the SECOND select (the parent fetch) carries the lifecycle columns
    const parentCols = selectSpy.mock.calls[1][0] as string;
    expect(parentCols).toContain('workflow_state');
    expect(parentCols).toContain('awaiting_human_input');
    expect(parentCols).toContain('awaiting_human_reason');
    expect(parentCols).toContain('stale');
    expect(parentCols).toContain('status'); // legacy field retained (back-compat)
    expect(result?.workflow_state).toBe('Built');
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
