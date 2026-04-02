import { describe, it, expect, vi } from 'vitest';
import { listComments, addComment } from './comments.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-abc-123'),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

// Mock Supabase client builder for select queries
function createMockSelectClient(data: any[] | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

// Mock Supabase client builder for insert queries
function createMockInsertClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

const TASK_UUID = 'task-abc-123';
const TASK_VISUAL_ID = 'B-42';
const PROJECT_ID = 'project-xyz-789';
const USER_ID = 'user-xyz-456';

const sampleComments = [
  {
    id: 'c1',
    content: 'First comment',
    user_id: 'user-1',
    created_at: '2026-03-10T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
  },
  {
    id: 'c2',
    content: 'Second comment',
    user_id: 'user-2',
    created_at: '2026-03-11T00:00:00Z',
    updated_at: '2026-03-11T00:00:00Z',
  },
];

describe('listComments', () => {
  it('returns comments ordered by created_at ascending', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockSelectClient(sampleComments);
    const result = await listComments(client, PROJECT_ID, { task_id: TASK_UUID });

    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, TASK_UUID);
    expect(client.from).toHaveBeenCalledWith('task_comments');
    expect(client.select).toHaveBeenCalledWith('id, content, user_id, created_at, updated_at');
    expect(client.eq).toHaveBeenCalledWith('task_id', TASK_UUID);
    expect(client.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result).toEqual(sampleComments);
  });

  it('accepts a visual ID and resolves it via resolveTaskId', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockSelectClient(sampleComments);
    await listComments(client, PROJECT_ID, { task_id: TASK_VISUAL_ID });

    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, TASK_VISUAL_ID);
    expect(client.eq).toHaveBeenCalledWith('task_id', TASK_UUID);
  });

  it('returns empty array when no comments exist', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockSelectClient([]);
    const result = await listComments(client, PROJECT_ID, { task_id: TASK_UUID });

    expect(result).toEqual([]);
  });

  it('throws on Supabase error', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockSelectClient(null, { message: 'DB failure' });
    await expect(listComments(client, PROJECT_ID, { task_id: TASK_UUID })).rejects.toThrow('DB failure');
  });
});

describe('addComment', () => {
  const createdComment = {
    id: 'c-new',
    task_id: TASK_UUID,
    user_id: USER_ID,
    content: 'A new comment',
    created_at: '2026-03-16T00:00:00Z',
    updated_at: '2026-03-16T00:00:00Z',
  };

  it('inserts comment and returns it', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockInsertClient(createdComment);
    const result = await addComment(client, PROJECT_ID, USER_ID, {
      task_id: TASK_UUID,
      content: 'A new comment',
    });

    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, TASK_UUID);
    expect(client.from).toHaveBeenCalledWith('task_comments');
    expect(client.insert).toHaveBeenCalledWith({
      task_id: TASK_UUID,
      user_id: USER_ID,
      content: 'A new comment',
    });
    expect(result).toEqual(createdComment);
  });

  it('accepts a visual ID and resolves it', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockInsertClient(createdComment);
    await addComment(client, PROJECT_ID, USER_ID, {
      task_id: TASK_VISUAL_ID,
      content: 'A new comment',
    });

    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, TASK_VISUAL_ID);
    expect(client.insert).toHaveBeenCalledWith({
      task_id: TASK_UUID,
      user_id: USER_ID,
      content: 'A new comment',
    });
  });

  it('normalizes literal \\n sequences to real newlines', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockInsertClient(createdComment);
    await addComment(client, PROJECT_ID, USER_ID, {
      task_id: TASK_UUID,
      content: 'line1\\nline2\\nline3',
    });

    expect(client.insert).toHaveBeenCalledWith({
      task_id: TASK_UUID,
      user_id: USER_ID,
      content: 'line1\nline2\nline3',
    });
  });

  it('throws on Supabase error', async () => {
    mockResolveTaskId.mockResolvedValueOnce(TASK_UUID);
    const client = createMockInsertClient(null, { message: 'Insert failed' });
    await expect(
      addComment(client, PROJECT_ID, USER_ID, { task_id: TASK_UUID, content: 'fail' }),
    ).rejects.toThrow('Insert failed');
  });
});
