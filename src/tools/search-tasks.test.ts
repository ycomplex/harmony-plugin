import { describe, it, expect, vi } from 'vitest';
import { searchTasks, searchTasksTool } from './search-tasks.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_ID = 'proj-1';

const rpcRows = [
  {
    task_id: 't1',
    task_number: 552,
    project_key: 'B',
    title: 'Route 1: lexical/trigram ticket search',
    workflow_state: 'Designed',
    status: 'In Progress',
    archived: false,
    similarity: 0.82,
  },
  {
    task_id: 't2',
    task_number: 499,
    project_key: 'B',
    title: 'Split umbrella: dedup retrieval surfaces',
    workflow_state: null,
    status: 'To Do',
    archived: false,
    similarity: 0.41,
  },
];

function createMockClient(data: any[] | null, error: any = null) {
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { rpc } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
}

describe('searchTasks', () => {
  it('calls the search_tasks RPC with the server project id and defaults', async () => {
    const client = createMockClient(rpcRows);
    await searchTasks(client, PROJECT_ID, { query: 'ticket search' });

    expect((client as any).rpc).toHaveBeenCalledWith('search_tasks', {
      _project_id: PROJECT_ID,
      _query_text: 'ticket search',
      _match_limit: 20,
      _include_archived: false,
    });
  });

  it('passes through limit and include_archived', async () => {
    const client = createMockClient(rpcRows);
    await searchTasks(client, PROJECT_ID, { query: 'x', limit: 5, include_archived: true });

    expect((client as any).rpc).toHaveBeenCalledWith('search_tasks', {
      _project_id: PROJECT_ID,
      _query_text: 'x',
      _match_limit: 5,
      _include_archived: true,
    });
  });

  it('maps rows to matches with a visual_id and similarity', async () => {
    const client = createMockClient(rpcRows);
    const result = await searchTasks(client, PROJECT_ID, { query: 'ticket search' });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 't1',
      task_number: 552,
      visual_id: 'B-552',
      title: 'Route 1: lexical/trigram ticket search',
      workflow_state: 'Designed',
      status: 'In Progress',
      archived: false,
      similarity: 0.82,
    });
    expect(result[1].visual_id).toBe('B-499');
    expect(result[1].workflow_state).toBeNull();
  });

  it('returns an empty array when the RPC yields no rows', async () => {
    const client = createMockClient(null);
    const result = await searchTasks(client, PROJECT_ID, { query: 'nothing' });
    expect(result).toEqual([]);
  });

  it('throws when query is missing/blank', async () => {
    const client = createMockClient(rpcRows);
    await expect(searchTasks(client, PROJECT_ID, { query: '  ' })).rejects.toThrow('query is required');
    expect((client as any).rpc).not.toHaveBeenCalled();
  });

  it('throws on RPC error', async () => {
    const client = createMockClient(null, { message: 'RPC failure' });
    await expect(searchTasks(client, PROJECT_ID, { query: 'x' })).rejects.toThrow('RPC failure');
  });
});

describe('search_tasks tool schema', () => {
  it('requires query and exposes limit + include_archived', () => {
    expect(searchTasksTool.name).toBe('search_tasks');
    expect(searchTasksTool.inputSchema.required).toContain('query');
    const props = searchTasksTool.inputSchema.properties as Record<string, unknown>;
    expect(props.query).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.include_archived).toBeDefined();
  });
});
