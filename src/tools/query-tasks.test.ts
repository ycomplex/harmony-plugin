import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryTasks, queryTasksTool } from './query-tasks.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// Mock Supabase client builder
function createMockClient(data: any[] | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.gte = vi.fn().mockReturnValue(chain);
  chain.lte = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

const PROJECT_ID = 'proj-1';

const baseTasks = [
  {
    id: 't1',
    title: 'Task One',
    status: 'To Do',
    priority: 'high',
    task_number: 1,
    assignee_id: 'user-a',
    epic_id: 'epic-1',
    description: 'desc',
    field_values: {},
    archived: false,
    due_date: '2026-03-20',
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-15T00:00:00Z',
    task_labels: [{ labels: { id: 'label-1', name: 'Bug', color: '#ff0000' } }],
  },
  {
    id: 't2',
    title: 'Task Two',
    status: 'In Progress',
    priority: 'medium',
    task_number: 2,
    assignee_id: 'user-b',
    epic_id: null,
    description: null,
    field_values: {},
    archived: false,
    due_date: null,
    created_at: '2026-03-02T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z',
    task_labels: [],
  },
  {
    id: 't3',
    title: 'Task Three',
    status: 'To Do',
    priority: 'low',
    task_number: 3,
    assignee_id: 'user-a',
    epic_id: 'epic-1',
    description: null,
    field_values: {},
    archived: false,
    due_date: '2026-04-01',
    created_at: '2026-03-03T00:00:00Z',
    updated_at: '2026-03-14T00:00:00Z',
    task_labels: [
      { labels: { id: 'label-1', name: 'Bug', color: '#ff0000' } },
      { labels: { id: 'label-2', name: 'Feature', color: '#00ff00' } },
    ],
  },
];

describe('queryTasks', () => {
  it('returns all non-archived tasks when no filters given', async () => {
    const client = createMockClient(baseTasks);
    const result = await queryTasks(client, PROJECT_ID, {});

    expect(client.from).toHaveBeenCalledWith('tasks');
    expect(client.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(client.eq).toHaveBeenCalledWith('archived', false);
    expect(result).toHaveLength(3);
  });

  it('applies status filter', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { status: 'To Do' });

    expect(client.eq).toHaveBeenCalledWith('status', 'To Do');
  });

  it('applies assignee filter', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { assignee_id: 'user-a' });

    expect(client.eq).toHaveBeenCalledWith('assignee_id', 'user-a');
  });

  it('applies epic_id filter', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { epic_id: 'epic-1' });

    expect(client.eq).toHaveBeenCalledWith('epic_id', 'epic-1');
  });

  it('applies priority filter', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { priority: 'high' });

    expect(client.eq).toHaveBeenCalledWith('priority', 'high');
  });

  it('applies due date range filters', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { due_date_from: '2026-03-15', due_date_to: '2026-03-25' });

    expect(client.gte).toHaveBeenCalledWith('due_date', '2026-03-15');
    expect(client.lte).toHaveBeenCalledWith('due_date', '2026-03-25');
  });

  it('applies stale_days filter', async () => {
    const client = createMockClient(baseTasks);
    // Mock Date.now so cutoff is deterministic
    const now = new Date('2026-03-16T00:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(now);

    await queryTasks(client, PROJECT_ID, { stale_days: 5 });

    // 5 days before 2026-03-16 = 2026-03-11
    expect(client.lte).toHaveBeenCalledWith('updated_at', '2026-03-11T00:00:00.000Z');

    vi.restoreAllMocks();
  });

  it('applies sort_by parameter', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { sort_by: 'due_date' });

    expect(client.order).toHaveBeenCalledWith('due_date', { ascending: true });
  });

  it('applies sort_by updated_at descending', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { sort_by: 'updated_at' });

    expect(client.order).toHaveBeenCalledWith('updated_at', { ascending: false });
  });

  it('applies limit parameter via range', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { limit: 10 });

    expect(client.range).toHaveBeenCalledWith(0, 9);
  });

  it('uses default limit of 50', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, {});

    expect(client.range).toHaveBeenCalledWith(0, 49);
  });

  it('applies offset for pagination', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { limit: 50, offset: 50 });

    expect(client.range).toHaveBeenCalledWith(50, 99);
  });

  it('uses default offset of 0', async () => {
    const client = createMockClient(baseTasks);
    await queryTasks(client, PROJECT_ID, { limit: 25 });

    expect(client.range).toHaveBeenCalledWith(0, 24);
  });

  it('flattens task_labels into labels array', async () => {
    const client = createMockClient(baseTasks);
    const result = await queryTasks(client, PROJECT_ID, {});

    expect(result[0].labels).toEqual([{ id: 'label-1', name: 'Bug', color: '#ff0000' }]);
    expect(result[1].labels).toEqual([]);
    expect(result[2].labels).toEqual([
      { id: 'label-1', name: 'Bug', color: '#ff0000' },
      { id: 'label-2', name: 'Feature', color: '#00ff00' },
    ]);
    // Ensure task_labels is removed
    expect(result[0]).not.toHaveProperty('task_labels');
  });

  it('filters by label_ids client-side (AND logic)', async () => {
    const client = createMockClient(baseTasks);
    const result = await queryTasks(client, PROJECT_ID, { label_ids: ['label-1', 'label-2'] });

    // Only t3 has BOTH labels
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t3');
  });

  it('filters by single label_id', async () => {
    const client = createMockClient(baseTasks);
    const result = await queryTasks(client, PROJECT_ID, { label_ids: ['label-2'] });

    // Only t3 has label-2
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t3');
  });

  it('throws on Supabase error', async () => {
    const client = createMockClient(null, { message: 'DB failure' });
    await expect(queryTasks(client, PROJECT_ID, {})).rejects.toThrow('DB failure');
  });

  it('passes archived=true when specified', async () => {
    const client = createMockClient([]);
    await queryTasks(client, PROJECT_ID, { archived: true });

    expect(client.eq).toHaveBeenCalledWith('archived', true);
  });
});

// Records each builder call so we can assert filters + selected columns.
function recordingClient(rows: Record<string, unknown>[]) {
  const calls: { eq: [string, unknown][]; select?: string } = { eq: [] };
  const builder: Record<string, unknown> = {
    select(cols: string) { calls.select = cols; return builder; },
    eq(col: string, val: unknown) { calls.eq.push([col, val]); return builder; },
    gte() { return builder; },
    lte() { return builder; },
    order() { return builder; },
    range() { return Promise.resolve({ data: rows, error: null }); },
  };
  const client = { from: () => builder } as unknown as SupabaseClient;
  return { client, calls };
}

describe('query_tasks workflow filters', () => {
  it('exposes the workflow filters in its schema', () => {
    const props = queryTasksTool.inputSchema.properties as Record<string, unknown>;
    expect(props.awaiting_human_input).toBeDefined();
    expect(props.workflow_state).toBeDefined();
    expect(props.workflow_activity).toBeDefined();
    expect(props.stale).toBeDefined();
  });

  it('selects the P1 workflow columns', async () => {
    const { client, calls } = recordingClient([]);
    await queryTasks(client, 'proj', {});
    expect(calls.select).toContain('workflow_state');
    expect(calls.select).toContain('awaiting_human_input');
    expect(calls.select).toContain('awaiting_human_reason');
  });

  it('filters by awaiting_human_input and workflow_state', async () => {
    const { client, calls } = recordingClient([]);
    await queryTasks(client, 'proj', { awaiting_human_input: true, workflow_state: 'Built' });
    expect(calls.eq).toContainEqual(['awaiting_human_input', true]);
    expect(calls.eq).toContainEqual(['workflow_state', 'Built']);
  });

  it('filters by stale (the queue\'s Stale read — F5)', async () => {
    const { client, calls } = recordingClient([]);
    await queryTasks(client, 'proj', { stale: true });
    expect(calls.eq).toContainEqual(['stale', true]);
  });
});
