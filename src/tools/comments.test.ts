import { describe, it, expect, vi } from 'vitest';
import { listComments, addComment } from './comments.js';

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

const TASK_ID = 'task-abc-123';
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
    const client = createMockSelectClient(sampleComments);
    const result = await listComments(client, { task_id: TASK_ID });

    expect(client.from).toHaveBeenCalledWith('task_comments');
    expect(client.select).toHaveBeenCalledWith('id, content, user_id, created_at, updated_at');
    expect(client.eq).toHaveBeenCalledWith('task_id', TASK_ID);
    expect(client.order).toHaveBeenCalledWith('created_at', { ascending: true });
    expect(result).toEqual(sampleComments);
  });

  it('returns empty array when no comments exist', async () => {
    const client = createMockSelectClient([]);
    const result = await listComments(client, { task_id: TASK_ID });

    expect(result).toEqual([]);
  });

  it('throws on Supabase error', async () => {
    const client = createMockSelectClient(null, { message: 'DB failure' });
    await expect(listComments(client, { task_id: TASK_ID })).rejects.toThrow('DB failure');
  });
});

describe('addComment', () => {
  const createdComment = {
    id: 'c-new',
    task_id: TASK_ID,
    user_id: USER_ID,
    content: 'A new comment',
    created_at: '2026-03-16T00:00:00Z',
    updated_at: '2026-03-16T00:00:00Z',
  };

  it('inserts comment and returns it', async () => {
    const client = createMockInsertClient(createdComment);
    const result = await addComment(client, USER_ID, {
      task_id: TASK_ID,
      content: 'A new comment',
    });

    expect(client.from).toHaveBeenCalledWith('task_comments');
    expect(client.insert).toHaveBeenCalledWith({
      task_id: TASK_ID,
      user_id: USER_ID,
      content: 'A new comment',
    });
    expect(result).toEqual(createdComment);
  });

  it('throws on Supabase error', async () => {
    const client = createMockInsertClient(null, { message: 'Insert failed' });
    await expect(
      addComment(client, USER_ID, { task_id: TASK_ID, content: 'fail' }),
    ).rejects.toThrow('Insert failed');
  });
});
