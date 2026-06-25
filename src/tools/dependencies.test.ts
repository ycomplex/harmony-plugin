import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDependencies, manageDependencies } from './dependencies.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
  resolveTaskIds: vi.fn().mockResolvedValue([]),
}));

describe('listDependencies', () => {
  let client: any;
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
    resolveMock.mockResolvedValue('resolved-uuid');
    const builder = () => {
      const b: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockResolvedValue({ data: [], error: null }),
      };
      return b;
    };
    client = { from: vi.fn(builder) };
  });

  it('queries task_dependencies twice (both directions)', async () => {
    const result = await listDependencies(client, 'proj-1', { task_id: 'B-1' });
    expect(client.from).toHaveBeenCalledWith('task_dependencies');
    expect(client.from).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ depends_on: [], blocks: [] });
  });

  // B-572: list_dependencies must expose each related task's real workflow_state (+ the
  // awaiting/stale lifecycle fields) on BOTH directions — depends_on (the dependency embed)
  // and blocks (the dependent embed) — not just the legacy status, which is inert in
  // opinionated mode (B-487). Mirrors B-556 for list_subtasks/list_parent.
  it('selects the lifecycle fields on BOTH embeds and passes workflow_state through (B-572)', async () => {
    const selectSpy = vi.fn().mockReturnThis();
    const dependsOnRow = {
      id: 'link-1', task_id: 'resolved-uuid', blocked_by_task_id: 'dep-1',
      created_at: '2026-01-01', created_by: 'user-1',
      dependency: {
        id: 'dep-1', task_number: 10, title: 'Upstream',
        status: 'In Progress', workflow_state: 'Designed',
        awaiting_human_input: false, awaiting_human_reason: null, stale: false,
      },
    };
    const blocksRow = {
      id: 'link-2', task_id: 'dependent-1', blocked_by_task_id: 'resolved-uuid',
      created_at: '2026-01-02', created_by: 'user-1',
      dependent: {
        id: 'dependent-1', task_number: 20, title: 'Downstream',
        status: 'Backlog', workflow_state: 'Built',
        awaiting_human_input: true, awaiting_human_reason: 'release-decision-pending', stale: false,
      },
    };
    let call = 0;
    const directional = {
      select: selectSpy,
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockImplementation(() => {
        call += 1;
        // first call = depends_on direction, second = blocks direction
        return Promise.resolve({ data: call === 1 ? [dependsOnRow] : [blocksRow], error: null });
      }),
    };
    client = { from: vi.fn(() => directional) };

    const result = await listDependencies(client, 'proj-1', { task_id: 'B-1' });

    // BOTH selects must carry the lifecycle columns (additive — status retained)
    const dependsOnCols = selectSpy.mock.calls[0][0] as string;
    const blocksCols = selectSpy.mock.calls[1][0] as string;
    for (const cols of [dependsOnCols, blocksCols]) {
      expect(cols).toContain('workflow_state');
      expect(cols).toContain('awaiting_human_input');
      expect(cols).toContain('awaiting_human_reason');
      expect(cols).toContain('stale');
      expect(cols).toContain('status'); // legacy field retained (back-compat)
    }

    // workflow_state passes through alongside the retained status on both directions
    expect(result.depends_on[0].dependency.workflow_state).toBe('Designed');
    expect(result.depends_on[0].dependency.status).toBe('In Progress');
    expect(result.blocks[0].dependent.workflow_state).toBe('Built');
    expect(result.blocks[0].dependent.status).toBe('Backlog');
  });
});

describe('manageDependencies', () => {
  let resolveTaskIdMock: ReturnType<typeof vi.fn>;
  let resolveTaskIdsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import('./resolve-task-id.js');
    resolveTaskIdMock = mod.resolveTaskId as ReturnType<typeof vi.fn>;
    resolveTaskIdsMock = mod.resolveTaskIds as ReturnType<typeof vi.fn>;
    resolveTaskIdMock.mockReset();
    resolveTaskIdsMock.mockReset();
  });

  it('adds dependencies via insert', async () => {
    const insertSelect = vi.fn().mockResolvedValue({ data: [{ id: 'd1' }], error: null });
    const client: any = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({ select: insertSelect })),
      })),
    };
    resolveTaskIdMock.mockResolvedValue('task-a');
    resolveTaskIdsMock.mockResolvedValue(['task-b']);

    const result = await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      add: ['task-b'],
    });
    expect(client.from).toHaveBeenCalledWith('task_dependencies');
    expect(result.added).toEqual([{ id: 'd1' }]);
  });

  it('resolves the whole add[] list with a single batched resolveTaskIds call', async () => {
    const insertSelect = vi.fn().mockResolvedValue({ data: [{ id: 'd1' }, { id: 'd2' }], error: null });
    const client: any = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({ select: insertSelect })),
      })),
    };
    resolveTaskIdMock.mockResolvedValue('task-a');
    resolveTaskIdsMock.mockResolvedValue(['task-b', 'task-c']);

    await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      add: ['task-b', 'task-c'],
    });
    expect(resolveTaskIdsMock).toHaveBeenCalledTimes(1);
    expect(resolveTaskIdsMock).toHaveBeenCalledWith(client, 'proj-1', ['task-b', 'task-c']);
  });

  it('inserts one row per resolved dependency', async () => {
    const insertSpy = vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: [], error: null }) }));
    const client: any = { from: vi.fn(() => ({ insert: insertSpy })) };
    resolveTaskIdMock.mockResolvedValue('task-a');
    resolveTaskIdsMock.mockResolvedValue(['task-b', 'task-c']);

    await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      add: ['task-b', 'task-c'],
    });
    expect(insertSpy).toHaveBeenCalledWith([
      { task_id: 'task-a', blocked_by_task_id: 'task-b', created_by: 'user-1' },
      { task_id: 'task-a', blocked_by_task_id: 'task-c', created_by: 'user-1' },
    ]);
  });

  it('removes dependencies by id', async () => {
    const eqSpy = vi.fn().mockResolvedValue({ error: null });
    const client: any = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({ in: vi.fn(() => ({ eq: eqSpy })) })),
      })),
    };
    resolveTaskIdMock.mockResolvedValue('task-a');
    const result = await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      remove: ['d1', 'd2'],
    });
    expect(result.removed).toEqual(['d1', 'd2']);
  });

  it('rejects self-dependencies', async () => {
    const client: any = { from: vi.fn() };
    resolveTaskIdMock.mockResolvedValue('task-a');
    resolveTaskIdsMock.mockResolvedValue(['task-a']); // dependency resolves to the same ID
    await expect(
      manageDependencies(client, 'proj-1', 'user-1', { task_id: 'task-a', add: ['task-a'] }),
    ).rejects.toThrow(/itself/);
  });
});
