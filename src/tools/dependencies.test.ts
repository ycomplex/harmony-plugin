import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDependencies, manageDependencies } from './dependencies.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
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
    expect(result).toEqual({ blocked_by: [], blocking: [] });
  });
});

describe('manageDependencies', () => {
  beforeEach(async () => {
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockReset();
  });

  it('adds blockers via insert', async () => {
    const insertSelect = vi.fn().mockResolvedValue({ data: [{ id: 'd1' }], error: null });
    const client: any = {
      from: vi.fn(() => ({
        insert: vi.fn(() => ({ select: insertSelect })),
      })),
    };
    // We need resolveTaskId to return different values for the task vs its blocker
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockResolvedValueOnce('task-a').mockResolvedValueOnce('task-b');

    const result = await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      add: ['task-b'],
    });
    expect(client.from).toHaveBeenCalledWith('task_dependencies');
    expect(result.added).toEqual([{ id: 'd1' }]);
  });

  it('removes blockers by id', async () => {
    const eqSpy = vi.fn().mockResolvedValue({ error: null });
    const client: any = {
      from: vi.fn(() => ({
        delete: vi.fn(() => ({ in: vi.fn(() => ({ eq: eqSpy })) })),
      })),
    };
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockResolvedValue('task-a');
    const result = await manageDependencies(client, 'proj-1', 'user-1', {
      task_id: 'task-a',
      remove: ['d1', 'd2'],
    });
    expect(result.removed).toEqual(['d1', 'd2']);
  });

  it('rejects self-blocking', async () => {
    const client: any = { from: vi.fn() };
    const resolveMock = (await import('./resolve-task-id.js')).resolveTaskId as ReturnType<typeof vi.fn>;
    resolveMock.mockResolvedValue('task-a'); // both task and blocker resolve to same ID
    await expect(
      manageDependencies(client, 'proj-1', 'user-1', { task_id: 'task-a', add: ['task-a'] }),
    ).rejects.toThrow(/itself/);
  });
});
