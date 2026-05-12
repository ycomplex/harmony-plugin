import { describe, it, expect, vi, beforeEach } from 'vitest';
import { listDependencies } from './dependencies.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('resolved-uuid'),
}));

describe('listDependencies', () => {
  let client: any;
  beforeEach(() => {
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
