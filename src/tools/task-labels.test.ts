import { describe, it, expect, vi } from 'vitest';
import { manageTaskLabels } from './task-labels.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-abc-123'),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

const TASK_UUID = 'task-abc-123';
const TASK_VISUAL_ID = 'B-42';
const PROJECT_ID = 'project-xyz-789';

function createMockClient(overrides: {
  insertData?: any;
  insertError?: any;
  deleteData?: any;
  deleteError?: any;
} = {}) {
  const chain: any = {};
  // Track which operation we're on
  let callCount = 0;

  chain.from = vi.fn().mockImplementation(() => {
    callCount++;
    return chain;
  });

  // Insert chain: insert → select → resolves
  chain.insert = vi.fn().mockReturnValue(chain);
  // Delete chain: delete → eq → in → resolves
  chain.delete = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.in = vi.fn().mockResolvedValue({
    data: overrides.deleteData ?? null,
    error: overrides.deleteError ?? null,
  });
  chain.select = vi.fn().mockResolvedValue({
    data: overrides.insertData ?? [],
    error: overrides.insertError ?? null,
  });

  return chain;
}

describe('manageTaskLabels', () => {
  it('resolves visual ID before operating on labels', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const labelsToAdd = ['label-1'];
    const client = createMockClient({ insertData: [{ task_id: TASK_UUID, label_id: 'label-1' }] });

    await manageTaskLabels(client, PROJECT_ID, { task_id: TASK_VISUAL_ID, add: labelsToAdd });

    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, TASK_VISUAL_ID);
    expect(client.insert).toHaveBeenCalledWith([
      { task_id: TASK_UUID, label_id: 'label-1' },
    ]);
  });

  it('adds labels to a task', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const labelsToAdd = ['label-1', 'label-2'];
    const insertedRows = [
      { task_id: TASK_UUID, label_id: 'label-1' },
      { task_id: TASK_UUID, label_id: 'label-2' },
    ];

    const client = createMockClient({ insertData: insertedRows });
    const result = await manageTaskLabels(client, PROJECT_ID, {
      task_id: TASK_UUID,
      add: labelsToAdd,
    });

    expect(client.from).toHaveBeenCalledWith('task_labels');
    expect(client.insert).toHaveBeenCalledWith([
      { task_id: TASK_UUID, label_id: 'label-1' },
      { task_id: TASK_UUID, label_id: 'label-2' },
    ]);
    expect(result).toEqual({ added: labelsToAdd, removed: [] });
  });

  it('removes labels from a task', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const labelsToRemove = ['label-3', 'label-4'];

    const client = createMockClient();
    const result = await manageTaskLabels(client, PROJECT_ID, {
      task_id: TASK_UUID,
      remove: labelsToRemove,
    });

    expect(client.from).toHaveBeenCalledWith('task_labels');
    expect(client.delete).toHaveBeenCalled();
    expect(client.eq).toHaveBeenCalledWith('task_id', TASK_UUID);
    expect(client.in).toHaveBeenCalledWith('label_id', labelsToRemove);
    expect(result).toEqual({ added: [], removed: labelsToRemove });
  });

  it('can add and remove in the same call', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const labelsToAdd = ['label-1'];
    const labelsToRemove = ['label-2'];
    const insertedRows = [{ task_id: TASK_UUID, label_id: 'label-1' }];

    // Need separate chains for add and remove since they hit different .from() calls
    const insertChain: any = {};
    insertChain.insert = vi.fn().mockReturnValue(insertChain);
    insertChain.select = vi.fn().mockResolvedValue({ data: insertedRows, error: null });

    const deleteChain: any = {};
    deleteChain.delete = vi.fn().mockReturnValue(deleteChain);
    deleteChain.eq = vi.fn().mockReturnValue(deleteChain);
    deleteChain.in = vi.fn().mockResolvedValue({ data: null, error: null });

    let fromCallCount = 0;
    const client: any = {
      from: vi.fn().mockImplementation(() => {
        fromCallCount++;
        // First call is for insert (add), second is for delete (remove)
        return fromCallCount === 1 ? insertChain : deleteChain;
      }),
    };

    const result = await manageTaskLabels(client, PROJECT_ID, {
      task_id: TASK_UUID,
      add: labelsToAdd,
      remove: labelsToRemove,
    });

    expect(client.from).toHaveBeenCalledTimes(2);
    expect(insertChain.insert).toHaveBeenCalledWith([
      { task_id: TASK_UUID, label_id: 'label-1' },
    ]);
    expect(deleteChain.eq).toHaveBeenCalledWith('task_id', TASK_UUID);
    expect(deleteChain.in).toHaveBeenCalledWith('label_id', labelsToRemove);
    expect(result).toEqual({ added: labelsToAdd, removed: labelsToRemove });
  });

  it('throws on insert error', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockClient({ insertError: { message: 'Insert failed' } });
    await expect(
      manageTaskLabels(client, PROJECT_ID, { task_id: TASK_UUID, add: ['label-1'] }),
    ).rejects.toThrow('Insert failed');
  });

  it('throws on delete error', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockClient({ deleteError: { message: 'Delete failed' } });
    await expect(
      manageTaskLabels(client, PROJECT_ID, { task_id: TASK_UUID, remove: ['label-1'] }),
    ).rejects.toThrow('Delete failed');
  });

  it('returns empty results when neither add nor remove provided', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockClient();
    const result = await manageTaskLabels(client, PROJECT_ID, { task_id: TASK_UUID });

    expect(client.from).not.toHaveBeenCalled();
    expect(result).toEqual({ added: [], removed: [] });
  });
});
