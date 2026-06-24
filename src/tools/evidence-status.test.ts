import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBuildEvidenceStatus } from './evidence-status.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-uuid'),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

const PROJECT_ID = 'proj-1';

/**
 * Build a Supabase mock that dispatches by table. Each table maps to the rows the
 * `client.from(table).select(cols).eq('...', id)` chain resolves to. The terminal call
 * in the tool is `.eq(...)`, which awaits to `{ data, error }`.
 */
function makeClient(tables: {
  tasks?: any[]; // children rows: { id, archived }
  test_cases?: any[];
  acceptance_criteria?: any[]; // { id, checked }
  task_comments?: any[]; // { content }
  errorOn?: string; // a table name whose query should error
}) {
  const rowsFor = (table: string): any[] => (tables as any)[table] ?? [];
  return {
    from: vi.fn((table: string) => {
      const result =
        tables.errorOn === table
          ? { data: null, error: { message: `DB failure on ${table}` } }
          : { data: rowsFor(table), error: null };
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockResolvedValue(result),
      };
      return chain;
    }),
  } as any;
}

describe('getBuildEvidenceStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTaskId.mockResolvedValue('task-uuid');
  });

  it('complete: test cases + all ACs checked + a PR/merge/deploy comment trail', async () => {
    const client = makeClient({
      tasks: [], // no children → leaf
      test_cases: [{ id: 't1' }, { id: 't2' }],
      acceptance_criteria: [{ id: 'a1', checked: true }, { id: 'a2', checked: true }],
      task_comments: [{ content: 'Merged PR #123, deploy is green.' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res).toEqual({
      task_id: 'task-uuid',
      is_umbrella: false,
      has_test_cases: true,
      all_acs_checked: true,
      has_comment_trail: true,
      complete: true,
      exempt_reason: null,
      missing: [],
    });
  });

  it('resolves the task_id via resolveTaskId and reads the four tables', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'PR opened' }],
    });
    await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-1');
    const tablesQueried = client.from.mock.calls.map((c: any[]) => c[0]);
    expect(tablesQueried).toEqual(
      expect.arrayContaining(['tasks', 'test_cases', 'acceptance_criteria', 'task_comments']),
    );
  });

  it('missing test cases → incomplete with "test cases" in missing', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'Merged PR #5' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.complete).toBe(false);
    expect(res.has_test_cases).toBe(false);
    expect(res.missing).toContain('test cases');
  });

  it('unchecked ACs → incomplete and counts the unchecked ones', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [
        { id: 'a1', checked: true },
        { id: 'a2', checked: false },
        { id: 'a3', checked: false },
      ],
      task_comments: [{ content: 'Deployed to staging' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.complete).toBe(false);
    expect(res.all_acs_checked).toBe(false);
    expect(res.missing).toContain('2 unchecked acceptance criteria');
  });

  it('zero ACs → all_acs_checked is false and missing flags none created', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [],
      task_comments: [{ content: 'Merged PR #9' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.all_acs_checked).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.missing).toContain('acceptance criteria (none created)');
  });

  it('no comment trail → incomplete with the trail flagged missing (benign comments do not count)', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'Looks good, nice work.' }, { content: 'A general note.' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.complete).toBe(false);
    expect(res.has_comment_trail).toBe(false);
    expect(res.missing).toContain('PR/merge/deploy comment trail');
  });

  it('comment trail matches inflected merge/deploy stems and a PR# reference', async () => {
    // Corrected regex intent: `merg`/`deploy` are stems → "Merged"/"Deployed"/"deploying" all count.
    for (const content of ['Merged the PR and deployed to staging.', 'Deploying now.', 'see PR#421']) {
      const client = makeClient({
        tasks: [],
        test_cases: [{ id: 't1' }],
        acceptance_criteria: [{ id: 'a1', checked: true }],
        task_comments: [{ content }],
      });
      const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
      expect(res.has_comment_trail, content).toBe(true);
      expect(res.complete, content).toBe(true);
    }
  });

  it('umbrella (>=1 non-archived child) → complete=true, exempt_reason set, no evidence required', async () => {
    // No test cases / no ACs / no trail — but a live child makes it an exempt umbrella.
    const client = makeClient({
      tasks: [{ id: 'c1', archived: false }],
      test_cases: [],
      acceptance_criteria: [],
      task_comments: [],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.is_umbrella).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.exempt_reason).toBe('umbrella — evidence carried by children');
    expect(res.missing).toEqual([]);
  });

  it('only-archived children → NOT an umbrella (evidence still required)', async () => {
    const client = makeClient({
      tasks: [{ id: 'c1', archived: true }],
      test_cases: [],
      acceptance_criteria: [],
      task_comments: [],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.is_umbrella).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.exempt_reason).toBeNull();
    expect(res.missing).toEqual([
      'test cases',
      'acceptance criteria (none created)',
      'PR/merge/deploy comment trail',
    ]);
  });

  it('throws when a read errors (propagates the Supabase error)', async () => {
    const client = makeClient({
      tasks: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'PR #1' }],
      errorOn: 'test_cases',
    });
    await expect(getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' })).rejects.toThrow(
      'DB failure on test_cases',
    );
  });
});
