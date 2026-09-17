import { describe, it, expect, vi } from 'vitest';
import {
  listWorkflowTransitions,
  listWorkflowTransitionsTool,
  chainSortWorkflowTransitions,
  type WorkflowTransitionChainRow,
} from './workflow-transitions.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_ID = 'proj-1';

// ---------------------------------------------------------------------------
// chainSortWorkflowTransitions (AC2) — the load-bearing ordering piece.
// ---------------------------------------------------------------------------
//
// Fixture provenance (per the ratified build brief — real ticket data, not invented):
//
// B-1021 fixture: pulled live from prod's activity_events for task 8e4a49f8-1180-437a-b921-
// 7683e747c45f (B-1021) on 2026-09-17 — a real, clean, single-hop Deployed → Parked row. Its
// tx_id (931510) is unique among that task's rows — a genuine size-1 group.
//
// B-1029 fixture: pulled live from prod's activity_events for task 48336d51-3166-4b06-9dfb-
// b51baf392533 (B-1029) on 2026-09-17 — the real Deployed→Built (2026-09-16T08:04:00.520654Z)
// and Built→Planned (2026-09-16T08:06:55.179233Z) rows the ratified plan named. LIVE-VERIFIED
// DISCREPANCY: the plan's premise was that this pair "shares a tx_id" (one accept, two hops in
// one transaction) — direct inspection of the real rows shows they do NOT: tx_id 871447 vs
// 871548, roughly 3 minutes apart, i.e. two separate resolve_brief/consume_acceptance_event
// transactions, not one. A project-wide sweep of every field_name='workflow_state' field_change
// row since 2026-09-01 found ZERO real same-task, same-tx_id, multi-row groups — this event
// shape (several hops committed in a single Postgres transaction) is schema-legal but has not
// actually occurred in this environment's observed history. So this fixture is used AS THE REAL
// DATA IT IS (two separate single-row groups) — it still pins the required assertion (the
// function must never reorder ACROSS groups, so Deployed→Built still renders before
// Built→Planned) without fabricating a shared tx_id the real rows don't have. The genuine >1-
// row-group resolution algorithm (the "happy path" merge) is covered separately below by an
// explicitly-labeled CONSTRUCTED fixture, since no real one currently exists to pull.
const B1021_DEPLOYED_TO_PARKED: WorkflowTransitionChainRow = {
  id: '0a3b281f-3de0-45c2-993e-b665bb34bc81',
  task_id: '8e4a49f8-1180-437a-b921-7683e747c45f',
  tx_id: 931510,
  old_value: 'Deployed',
  new_value: 'Parked',
};

const B1029_DEPLOYED_TO_BUILT: WorkflowTransitionChainRow = {
  id: '34d1297b-75c2-4d0c-96e2-f4921083fc74',
  task_id: '48336d51-3166-4b06-9dfb-b51baf392533',
  tx_id: 871447,
  old_value: 'Deployed',
  new_value: 'Built',
};

const B1029_BUILT_TO_PLANNED: WorkflowTransitionChainRow = {
  id: '3463d184-67f7-4c62-941c-5e35678c0f2d',
  task_id: '48336d51-3166-4b06-9dfb-b51baf392533',
  tx_id: 871548,
  old_value: 'Built',
  new_value: 'Planned',
};

describe('chainSortWorkflowTransitions', () => {
  it('B-1021: a single-row group passes through untouched (no order tag)', () => {
    const result = chainSortWorkflowTransitions([B1021_DEPLOYED_TO_PARKED]);
    expect(result).toEqual([B1021_DEPLOYED_TO_PARKED]);
    expect(result[0].order).toBeUndefined();
  });

  it('B-1029: renders Deployed→Built before Built→Planned (real rows; live-verified as two separate groups, not one — see header note)', () => {
    const result = chainSortWorkflowTransitions([B1029_DEPLOYED_TO_BUILT, B1029_BUILT_TO_PLANNED]);
    expect(result.map((r) => `${r.old_value}->${r.new_value}`)).toEqual(['Deployed->Built', 'Built->Planned']);
    expect(result.every((r) => r.order === undefined)).toBe(true);
  });

  // CONSTRUCTED (not pulled from real data — no real same-task/same-tx_id multi-hop group exists
  // in this environment's observed history; see the B-1029 note above). Exercises the actual >1-
  // row-group RESOLUTION algorithm the ratified design calls for: two rows sharing one tx_id whose
  // old_value/new_value chain resolves cleanly.
  it('a constructed resolvable two-hop group (same tx_id) chain-sorts Deployed→Built before Built→Planned', () => {
    const hopTwo: WorkflowTransitionChainRow = {
      id: 'zz-hop-2', task_id: 'synthetic-task', tx_id: 999001, old_value: 'Built', new_value: 'Planned',
    };
    const hopOne: WorkflowTransitionChainRow = {
      id: 'zz-hop-1', task_id: 'synthetic-task', tx_id: 999001, old_value: 'Deployed', new_value: 'Built',
    };
    // Fed in REVERSE (as a naive created_at/tx_id-only DB order might land two same-timestamp rows) —
    // the chain-sort must still resolve the true causal order within the group.
    const result = chainSortWorkflowTransitions([hopTwo, hopOne]);
    expect(result.map((r) => r.id)).toEqual(['zz-hop-1', 'zz-hop-2']);
    expect(result.every((r) => r.order === undefined)).toBe(true);
  });

  // CONSTRUCTED, as instructed — invented rows in one group whose chain cannot be resolved.
  it('an ambiguous group (two rows both structurally "first") falls back to id order and tags every row', () => {
    const rowB: WorkflowTransitionChainRow = {
      id: 'b-row', task_id: 'ambiguous-task', tx_id: 42, old_value: 'Designed', new_value: 'Planned',
    };
    const rowA: WorkflowTransitionChainRow = {
      id: 'a-row', task_id: 'ambiguous-task', tx_id: 42, old_value: 'Built', new_value: 'Deployed',
    };
    // Neither row's old_value equals the other's new_value — two disconnected edges, both "first".
    const result = chainSortWorkflowTransitions([rowB, rowA]);
    expect(result.map((r) => r.id)).toEqual(['a-row', 'b-row']); // id-ascending fallback order
    expect(result.every((r) => r.order === 'fallback')).toBe(true);
  });

  it('a cyclic group (A.old=B.new and B.old=A.new) falls back to id order and tags every row', () => {
    const rowX: WorkflowTransitionChainRow = {
      id: 'x-row', task_id: 'cyclic-task', tx_id: 7, old_value: 'Built', new_value: 'Deployed',
    };
    const rowY: WorkflowTransitionChainRow = {
      id: 'y-row', task_id: 'cyclic-task', tx_id: 7, old_value: 'Deployed', new_value: 'Built',
    };
    const result = chainSortWorkflowTransitions([rowX, rowY]);
    expect(result.map((r) => r.id)).toEqual(['x-row', 'y-row']);
    expect(result.every((r) => r.order === 'fallback')).toBe(true);
  });

  it('groups spanning different tasks with the same tx_id (a real, documented tx_id-collision shape in this environment) are kept separate', () => {
    const taskA: WorkflowTransitionChainRow = { id: 'a1', task_id: 'task-a', tx_id: 5, old_value: 'Built', new_value: 'Deployed' };
    const taskB: WorkflowTransitionChainRow = { id: 'b1', task_id: 'task-b', tx_id: 5, old_value: 'Planned', new_value: 'Built' };
    const result = chainSortWorkflowTransitions([taskA, taskB]);
    // Each is its own (task_id, tx_id) group of size 1 — neither gets fallback-tagged.
    expect(result).toEqual([taskA, taskB]);
  });
});

// ---------------------------------------------------------------------------
// listWorkflowTransitions handler
// ---------------------------------------------------------------------------

function recordingClient(rows: Record<string, unknown>[], opts: { projectKey?: string } = {}) {
  const calls: {
    eq: [string, unknown][];
    gte: [string, unknown][];
    lt: [string, unknown][];
    order: [string, unknown][];
    range?: [number, number];
    select?: string;
  } = { eq: [], gte: [], lt: [], order: [] };

  const activityChain: any = {};
  activityChain.select = vi.fn((cols: string) => { calls.select = cols; return activityChain; });
  activityChain.eq = vi.fn((col: string, val: unknown) => { calls.eq.push([col, val]); return activityChain; });
  activityChain.gte = vi.fn((col: string, val: unknown) => { calls.gte.push([col, val]); return activityChain; });
  activityChain.lt = vi.fn((col: string, val: unknown) => { calls.lt.push([col, val]); return activityChain; });
  activityChain.order = vi.fn((col: string, val: unknown) => { calls.order.push([col, val]); return activityChain; });
  activityChain.range = vi.fn((from: number, to: number) => {
    calls.range = [from, to];
    return Promise.resolve({ data: rows, error: null });
  });

  const client = {
    from: vi.fn((table: string) => {
      if (table === 'projects') {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { key: opts.projectKey ?? 'B' }, error: null }),
            }),
          }),
        };
      }
      return activityChain;
    }),
  } as unknown as SupabaseClient;

  return { client, calls };
}

const ROW = (over: Record<string, unknown> = {}) => ({
  id: 'ev-1',
  task_id: 't1',
  tx_id: 100,
  old_value: 'Built',
  new_value: 'Deployed',
  created_at: '2026-09-10T00:00:00Z',
  tasks: { task_number: 42, title: 'A task', milestone_id: 'ms-1', epic_id: 'ep-1', parent_task_id: null },
  ...over,
});

describe('listWorkflowTransitions', () => {
  it('requires both from and to', async () => {
    const { client } = recordingClient([]);
    await expect(listWorkflowTransitions(client, PROJECT_ID, { from: '', to: '2026-01-01' } as any))
      .rejects.toThrow(/requires both `from` and `to`/);
    await expect(listWorkflowTransitions(client, PROJECT_ID, { to: '2026-01-01' } as any))
      .rejects.toThrow(/requires both `from` and `to`/);
    await expect(listWorkflowTransitions(client, PROJECT_ID, { from: '2026-01-01' } as any))
      .rejects.toThrow(/requires both `from` and `to`/);
  });

  it('scopes to the project and defaults field_name to workflow_state', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08' });
    expect(calls.eq).toContainEqual(['project_id', PROJECT_ID]);
    expect(calls.eq).toContainEqual(['event_type', 'field_change']);
    expect(calls.eq).toContainEqual(['field_name', 'workflow_state']);
    expect(calls.gte).toContainEqual(['created_at', '2026-09-01']);
    expect(calls.lt).toContainEqual(['created_at', '2026-09-08']);
  });

  it('field_name is itself an overridable filter', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', field_name: 'priority' });
    expect(calls.eq).toContainEqual(['field_name', 'priority']);
  });

  it('applies the new_value filter', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', new_value: 'Deployed' });
    expect(calls.eq).toContainEqual(['new_value', 'Deployed']);
  });

  it('applies the old_value filter', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', old_value: 'Built' });
    expect(calls.eq).toContainEqual(['old_value', 'Built']);
  });

  it('applies the milestone_id filter via the embedded tasks relationship', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', milestone_id: 'ms-1' });
    expect(calls.eq).toContainEqual(['tasks.milestone_id', 'ms-1']);
    expect(calls.select).toContain('tasks!inner(');
  });

  it('applies the epic_id filter via the embedded tasks relationship', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', epic_id: 'ep-1' });
    expect(calls.eq).toContainEqual(['tasks.epic_id', 'ep-1']);
  });

  it('orders by created_at ASC then tx_id ASC (the two-stage ordering — the PostgREST half)', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08' });
    expect(calls.order).toEqual([
      ['created_at', { ascending: true }],
      ['tx_id', { ascending: true }],
    ]);
  });

  it('defaults limit to 100 and offset to 0 via range', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08' });
    expect(calls.range).toEqual([0, 99]);
  });

  it('applies a custom limit/offset via range', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', limit: 10, offset: 20 });
    expect(calls.range).toEqual([20, 29]);
  });

  it('hard-caps limit at 500 even when a larger limit is requested', async () => {
    const { client, calls } = recordingClient([]);
    await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', limit: 5000 });
    expect(calls.range).toEqual([0, 499]);
  });

  it('lean view (default): task_id, visual_id, old_value, new_value, created_at — no title, no tx_id/id', async () => {
    const { client } = recordingClient([ROW()], { projectKey: 'HAR' });
    const result = await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08' });
    expect(result).toEqual([{
      task_id: 't1',
      visual_id: 'HAR-42',
      old_value: 'Built',
      new_value: 'Deployed',
      created_at: '2026-09-10T00:00:00Z',
    }]);
  });

  it("view:'full' adds title", async () => {
    const { client } = recordingClient([ROW()], { projectKey: 'HAR' });
    const result = await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08', view: 'full' });
    expect(result[0]).toMatchObject({ title: 'A task' });
  });

  it('tags a fallback-ordered row with order:"fallback" in the returned payload', async () => {
    const rowA = ROW({ id: 'a', task_id: 'amb-task', tx_id: 9, old_value: 'Built', new_value: 'Deployed' });
    const rowB = ROW({ id: 'b', task_id: 'amb-task', tx_id: 9, old_value: 'Designed', new_value: 'Planned' });
    const { client } = recordingClient([rowA, rowB], { projectKey: 'HAR' });
    const result = await listWorkflowTransitions(client, PROJECT_ID, { from: '2026-09-01', to: '2026-09-08' });
    expect(result.every((r: any) => r.order === 'fallback')).toBe(true);
  });

  it('exposes from/to as required in its schema', () => {
    expect(listWorkflowTransitionsTool.inputSchema.required).toEqual(['from', 'to']);
  });
});
