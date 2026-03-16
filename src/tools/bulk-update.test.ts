import { describe, it, expect, vi } from 'vitest';
import { bulkUpdateTasks } from './bulk-update.js';

const PROJECT_ID = 'proj-1';

function createMockClient(data: any[] | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

const updatedTasks = [
  { id: 't1', title: 'Task One', status: 'Done', priority: 'high' },
  { id: 't2', title: 'Task Two', status: 'Done', priority: 'medium' },
];

describe('bulkUpdateTasks', () => {
  it('updates status on multiple tasks', async () => {
    const client = createMockClient(updatedTasks);
    const result = await bulkUpdateTasks(client, PROJECT_ID, {
      task_ids: ['t1', 't2'],
      status: 'Done',
    });

    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.update).toHaveBeenCalledWith({ status: 'Done' });
    expect(client.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(client.in).toHaveBeenCalledWith('id', ['t1', 't2']);
    expect(client.select).toHaveBeenCalled();
    expect(result).toEqual(updatedTasks);
  });

  it('throws when task_ids is empty', async () => {
    const client = createMockClient([]);
    await expect(
      bulkUpdateTasks(client, PROJECT_ID, { task_ids: [], status: 'Done' }),
    ).rejects.toThrow('task_ids must not be empty');
  });

  it('throws when no update fields provided', async () => {
    const client = createMockClient([]);
    await expect(
      bulkUpdateTasks(client, PROJECT_ID, { task_ids: ['t1'] }),
    ).rejects.toThrow('At least one update field must be provided');
  });

  it('builds payload only from defined fields', async () => {
    const client = createMockClient(updatedTasks);
    await bulkUpdateTasks(client, PROJECT_ID, {
      task_ids: ['t1', 't2'],
      status: 'In Progress',
      priority: 'high',
    });

    expect(client.update).toHaveBeenCalledWith({
      status: 'In Progress',
      priority: 'high',
    });
  });

  it('does not include undefined fields in payload', async () => {
    const client = createMockClient(updatedTasks);
    await bulkUpdateTasks(client, PROJECT_ID, {
      task_ids: ['t1'],
      priority: 'low',
    });

    // Only priority should be in the payload, not status/assignee_id/archived
    expect(client.update).toHaveBeenCalledWith({ priority: 'low' });
  });

  it('supports setting assignee_id to null (unassign)', async () => {
    const client = createMockClient(updatedTasks);
    await bulkUpdateTasks(client, PROJECT_ID, {
      task_ids: ['t1'],
      assignee_id: null,
    });

    expect(client.update).toHaveBeenCalledWith({ assignee_id: null });
  });

  it('supports archived field', async () => {
    const client = createMockClient(updatedTasks);
    await bulkUpdateTasks(client, PROJECT_ID, {
      task_ids: ['t1', 't2'],
      archived: true,
    });

    expect(client.update).toHaveBeenCalledWith({ archived: true });
  });

  it('throws on Supabase error', async () => {
    const client = createMockClient(null, { message: 'DB failure' });
    await expect(
      bulkUpdateTasks(client, PROJECT_ID, {
        task_ids: ['t1'],
        status: 'Done',
      }),
    ).rejects.toThrow('DB failure');
  });
});
