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
