import { describe, it, expect, vi } from 'vitest';
import { createMilestone, listMilestones, shipMilestone } from './milestones.js';

const PROJECT_ID = 'proj-1';
const MILESTONE_ID = 'ms-1';

type TaskRow = { id: string; status: string; title: string; workflow_state: string };

/**
 * Builds a Supabase mock for shipMilestone(). It services three tables:
 *   - projects:   .select('custom_statuses, mode').eq('id', …).single()
 *   - tasks read: .select('id, status, title, workflow_state').eq('milestone_id', …)
 *   - tasks write:.update({ milestone_id: null }).in('id', [...])  (captured in nulledIds)
 *   - milestones: .update({...}).eq('id', …).select().single()
 *
 * Returns the mock client plus a `nulledIds` getter so a test can assert exactly which
 * task ids had their milestone_id stripped.
 */
function createMockClient(opts: {
  mode: string;
  customStatuses?: string[];
  tasks: TaskRow[];
}) {
  const nulledIds: string[][] = [];

  const client: any = {
    nulledIds,
    from: vi.fn((table: string) => {
      if (table === 'projects') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: {
              custom_statuses: opts.customStatuses ?? ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'],
              mode: opts.mode,
            },
            error: null,
          }),
        };
      }
      if (table === 'tasks') {
        return {
          // read path: .select(...).eq('milestone_id', …) — resolves to the task list
          select: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({ data: opts.tasks, error: null }),
          })),
          // write path: .update({ milestone_id: null }).in('id', [...])
          update: vi.fn(() => ({
            in: vi.fn((_col: string, ids: string[]) => {
              nulledIds.push(ids);
              return Promise.resolve({ data: null, error: null });
            }),
          })),
        };
      }
      if (table === 'milestones') {
        return {
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          select: vi.fn().mockReturnThis(),
          single: vi.fn().mockResolvedValue({
            data: { id: MILESTONE_ID, name: 'v1', status: 'shipped' },
            error: null,
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    }),
  };
  return client;
}

describe('shipMilestone', () => {
  // B-571: in opinionated mode the legacy `status` column is inert; completion lives in
  // `workflow_state` (terminal = 'Verified'). A Verified task must count as shipped and
  // must NOT be stripped off the milestone, even when its status is non-terminal.
  it('opinionated mode: Verified task (non-terminal status) counts done and is not stripped (B-571)', async () => {
    const tasks: TaskRow[] = [
      // Verified, but status is NOT the terminal 'Done' — pre-B-571 this was mis-classed non-done.
      { id: 't-verified', status: 'In Progress', title: 'Done feature', workflow_state: 'Verified' },
      // Not verified, non-terminal status — genuinely incomplete, should be stripped.
      { id: 't-open', status: 'In Progress', title: 'WIP feature', workflow_state: 'Built' },
    ];
    const client = createMockClient({ mode: 'opinionated', tasks });

    const result = await shipMilestone(client, PROJECT_ID, { milestone_id: MILESTONE_ID });

    expect(result.shipped_task_count).toBe(1);
    expect(result.removed_tasks.map((t: any) => t.id)).toEqual(['t-open']);
    // Only the genuinely-open task had its milestone_id nulled; the Verified one was kept.
    expect(client.nulledIds).toEqual([['t-open']]);
  });

  // B-571 union arm: a Manual→Opinionated task can have a terminal `status` but a
  // non-Verified `workflow_state`. The union (Verified OR terminal status) still counts it done.
  it('opinionated mode: terminal status with non-Verified workflow_state still counts done (B-571)', async () => {
    const tasks: TaskRow[] = [
      { id: 't-legacy-done', status: 'Done', title: 'Legacy done', workflow_state: 'Built' },
    ];
    const client = createMockClient({ mode: 'opinionated', tasks });

    const result = await shipMilestone(client, PROJECT_ID, { milestone_id: MILESTONE_ID });

    expect(result.shipped_task_count).toBe(1);
    expect(result.removed_tasks).toEqual([]);
    // Nothing was stripped.
    expect(client.nulledIds).toEqual([]);
  });

  // Manual mode: behaviour is unchanged — partition is purely status === doneStatus.
  // A Verified workflow_state is irrelevant here.
  it('manual mode: partition is purely status === doneStatus (workflow_state ignored)', async () => {
    const tasks: TaskRow[] = [
      { id: 't-done', status: 'Done', title: 'Completed', workflow_state: 'Built' },
      // Verified workflow_state but non-terminal status — in MANUAL mode this is NOT done.
      { id: 't-verified-but-open', status: 'In Progress', title: 'Verified-ish', workflow_state: 'Verified' },
    ];
    const client = createMockClient({ mode: 'manual', tasks });

    const result = await shipMilestone(client, PROJECT_ID, { milestone_id: MILESTONE_ID });

    expect(result.shipped_task_count).toBe(1);
    expect(result.removed_tasks.map((t: any) => t.id)).toEqual(['t-verified-but-open']);
    expect(client.nulledIds).toEqual([['t-verified-but-open']]);
  });
});

/**
 * Builds a Supabase mock for createMilestone(). It services two chains on 'milestones':
 *   - position read: .select('position').eq('project_id', …).order('position', {ascending:false}).limit(1)
 *   - insert:        .insert({...}).select().single()  (payload captured via insertMock)
 */
function createCreateMockClient(existingRows: Array<{ position: number }> | null) {
  const insertMock = vi.fn(() => ({
    select: vi.fn(() => ({
      single: vi.fn().mockResolvedValue({
        data: { id: 'ms-new', name: 'v2' },
        error: null,
      }),
    })),
  }));

  const client: any = {
    insertMock,
    from: vi.fn((table: string) => {
      if (table !== 'milestones') throw new Error(`unexpected table ${table}`);
      const selectChain: any = {
        eq: vi.fn(() => selectChain),
        order: vi.fn(() => selectChain),
        limit: vi.fn().mockResolvedValue({ data: existingRows, error: null }),
      };
      return {
        select: vi.fn(() => selectChain),
        insert: insertMock,
      };
    }),
  };
  return client;
}

describe('createMilestone', () => {
  // B-702: inserts without a position defaulted to the column default 0, colliding with
  // existing rows (duplicate positions made the web reorder a no-op). The create path must
  // assign max+1, matching the web app's create hook.
  it('inserts position max+1 when the project already has milestones (B-702)', async () => {
    const client = createCreateMockClient([{ position: 5 }]);

    await createMilestone(client, PROJECT_ID, 'user-1', { name: 'v2' });

    expect(client.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ position: 6 })
    );
  });

  it('inserts position 0 on a project with no milestones (B-702)', async () => {
    const client = createCreateMockClient([]);

    await createMilestone(client, PROJECT_ID, 'user-1', { name: 'v1' });

    expect(client.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0 })
    );
  });
});

describe('listMilestones', () => {
  // B-702: legacy rows can share a position (pre-fix inserts all defaulted to 0), so the
  // reader must tie-break on created_at for a stable order, matching the web reader.
  it('orders by position then created_at for a stable order on duplicate positions (B-702)', async () => {
    const orderCalls: string[] = [];
    const chain: any = {
      select: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      order: vi.fn((col: string) => {
        orderCalls.push(col);
        return chain;
      }),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: [{ id: 'ms-1' }], error: null }).then(resolve, reject),
    };
    const client: any = { from: vi.fn(() => chain) };

    const result = await listMilestones(client, PROJECT_ID, {});

    expect(orderCalls).toEqual(['position', 'created_at']);
    expect(result).toEqual([{ id: 'ms-1' }]);
  });
});
