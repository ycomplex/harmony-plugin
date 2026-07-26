import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBuildEvidenceStatus } from './evidence-status.js';

vi.mock('./resolve-task-id.js', () => ({
  resolveTaskId: vi.fn().mockResolvedValue('task-uuid'),
}));

import { resolveTaskId } from './resolve-task-id.js';
const mockResolveTaskId = vi.mocked(resolveTaskId);

const PROJECT_ID = 'proj-1';

/** A well-formed pushed-PR reference as the build gate records it (B-722). */
const VALID_BUILD_PR = {
  branch: 'fix/b722-build-gate-pr',
  head_sha: 'abc1234def',
  pr_number: 115,
  pr_url: 'https://github.com/ycomplex/harmony-plugin/pull/115',
  base: 'main',
  opened_at: '2026-07-26T12:00:00Z',
};

/**
 * Build a Supabase mock that dispatches by table. The `tasks` table is read twice
 * (children by `parent_task_id`, the task's own row by `id`), so its dispatch also
 * keys on the eq column. The terminal call in the tool is `.eq(...)`, which awaits
 * to `{ data, error }`.
 */
function makeClient(tables: {
  tasks?: any[]; // children rows: { id, archived }
  task_row?: any[]; // the task's own row: { field_values }
  test_cases?: any[];
  acceptance_criteria?: any[]; // { id, checked }
  task_comments?: any[]; // { content }
  task_labels?: any[]; // { labels: { name } }
  errorOn?: string; // a table name whose query should error
}) {
  const rowsFor = (table: string): any[] => (tables as any)[table] ?? [];
  return {
    from: vi.fn((table: string) => {
      const chain: any = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string) => {
          if (tables.errorOn === table) {
            return Promise.resolve({ data: null, error: { message: `DB failure on ${table}` } });
          }
          const rows = table === 'tasks' && col === 'id' ? (tables.task_row ?? []) : rowsFor(table);
          return Promise.resolve({ data: rows, error: null });
        }),
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

  it('complete: test cases + all ACs checked + a verified pushed-PR reference', async () => {
    const client = makeClient({
      tasks: [], // no children → leaf
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
      test_cases: [{ id: 't1' }, { id: 't2' }],
      acceptance_criteria: [{ id: 'a1', checked: true }, { id: 'a2', checked: true }],
      task_comments: [{ content: 'Merged PR #123, deploy is green.' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res).toEqual({
      task_id: 'task-uuid',
      is_umbrella: false,
      is_decision_only: false,
      has_test_cases: true,
      all_acs_checked: true,
      has_comment_trail: true,
      has_pushed_pr: true,
      complete: true,
      exempt_reason: null,
      missing: [],
    });
  });

  it('resolves the task_id via resolveTaskId and reads the six queries (tasks twice)', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'PR opened' }],
    });
    await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(mockResolveTaskId).toHaveBeenCalledWith(client, PROJECT_ID, 'B-1');
    const tablesQueried = client.from.mock.calls.map((c: any[]) => c[0]);
    expect(tablesQueried).toEqual(
      expect.arrayContaining(['tasks', 'test_cases', 'acceptance_criteria', 'task_comments', 'task_labels']),
    );
    expect(tablesQueried.filter((t: string) => t === 'tasks')).toHaveLength(2);
  });

  // B-722 (the B-713 phantom, pinned): self-reported ACs/tests + a keyword comment used to
  // false-green a build with ZERO persisted code. With completeness keyed on the recorded
  // pushed-PR reference, the exact same phantom now reads incomplete.
  it('B-713 phantom: checked ACs + test cases + keyword comment but NO pushed-PR ref → incomplete', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: {} }], // no build_pr — nothing was ever pushed
      test_cases: [{ id: 't1' }, { id: 't2' }],
      acceptance_criteria: [{ id: 'a1', checked: true }, { id: 'a2', checked: true }],
      task_comments: [{ content: 'design-carry note: the PR shape follows the accepted decision.' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-713' });
    expect(res.has_comment_trail).toBe(true); // the fooled signal still fires…
    expect(res.has_pushed_pr).toBe(false); // …but no longer gates anything
    expect(res.complete).toBe(false);
    expect(res.missing).toContain('pushed PR reference (no verified branch/PR recorded)');
  });

  it('a malformed build_pr ref (missing head_sha) reads as absent', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: { build_pr: { branch: 'fix/x', pr_url: 'https://github.com/x/pull/1' } } }],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.has_pushed_pr).toBe(false);
    expect(res.complete).toBe(false);
  });

  it('missing task row entirely (defensive) → has_pushed_pr false, no throw', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.has_pushed_pr).toBe(false);
    expect(res.complete).toBe(false);
  });

  it('comment trail is informational: a valid pushed-PR ref completes WITHOUT any trail comment (B-722)', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [{ id: 'a1', checked: true }],
      task_comments: [{ content: 'Looks good, nice work.' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.has_comment_trail).toBe(false);
    expect(res.complete).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it('missing test cases → incomplete with "test cases" in missing', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
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
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
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
      task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
      test_cases: [{ id: 't1' }],
      acceptance_criteria: [],
      task_comments: [{ content: 'Merged PR #9' }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.all_acs_checked).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.missing).toContain('acceptance criteria (none created)');
  });

  it('comment trail still detects inflected merge/deploy stems and a PR# reference (informational)', async () => {
    // Corrected regex intent: `merg`/`deploy` are stems → "Merged"/"Deployed"/"deploying" all count.
    for (const content of ['Merged the PR and deployed to staging.', 'Deploying now.', 'see PR#421']) {
      const client = makeClient({
        tasks: [],
        task_row: [{ field_values: { build_pr: VALID_BUILD_PR } }],
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
    // No test cases / no ACs / no PR ref — but a live child makes it an exempt umbrella.
    const client = makeClient({
      tasks: [{ id: 'c1', archived: false }],
      task_row: [{ field_values: {} }],
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
      task_row: [{ field_values: {} }],
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
      'pushed PR reference (no verified branch/PR recorded)',
    ]);
  });

  it('decision-only label → complete=true, exempt_reason set, no evidence required (B-681)', async () => {
    // No test cases / no ACs / no PR ref — but the decision-only marker exempts it: the
    // ticket completes via the deliverable-gate fast-forward and its evidence IS the
    // Accepted decision knowledge.
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: {} }],
      test_cases: [],
      acceptance_criteria: [],
      task_comments: [],
      task_labels: [{ labels: { name: 'decision-only' } }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.is_decision_only).toBe(true);
    expect(res.is_umbrella).toBe(false);
    expect(res.complete).toBe(true);
    expect(res.exempt_reason).toBe('decision-only — the Accepted decision knowledge is the evidence');
    expect(res.missing).toEqual([]);
  });

  it('decision-only + umbrella → umbrella keeps precedence in exempt_reason', async () => {
    const client = makeClient({
      tasks: [{ id: 'c1', archived: false }],
      task_row: [{ field_values: {} }],
      test_cases: [],
      acceptance_criteria: [],
      task_comments: [],
      task_labels: [{ labels: { name: 'decision-only' } }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.is_umbrella).toBe(true);
    expect(res.is_decision_only).toBe(true);
    expect(res.complete).toBe(true);
    expect(res.exempt_reason).toBe('umbrella — evidence carried by children');
  });

  it('other labels do NOT trip the decision-only exemption', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: {} }],
      test_cases: [],
      acceptance_criteria: [],
      task_comments: [],
      task_labels: [{ labels: { name: 'tech-debt' } }, { labels: null }],
    });
    const res = await getBuildEvidenceStatus(client, PROJECT_ID, { task_id: 'B-1' });
    expect(res.is_decision_only).toBe(false);
    expect(res.complete).toBe(false);
    expect(res.exempt_reason).toBeNull();
  });

  it('throws when a read errors (propagates the Supabase error)', async () => {
    const client = makeClient({
      tasks: [],
      task_row: [{ field_values: {} }],
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
