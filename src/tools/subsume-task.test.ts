import { describe, it, expect, vi } from 'vitest';
import { subsumeTask, subsumeTaskTool, type SubsumeTaskArgs } from './subsume-task.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_ID = 'proj-1';
const ABSORBED = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UMBRELLA = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// Chainable mock: `.from(table)` builder whose `.single()` returns the next FIFO
// row from tableResults[table]; `.update(...)` records the patch and resolves to
// updateResult. Tracks all updates for assertions.
function makeClient(opts: {
  tableResults: Record<string, Array<{ data: any; error?: any }>>;
  updateResult?: { error?: any };
  onUpdate?: (table: string, patch: any) => void;
}) {
  function builderFor(table: string) {
    const queue = opts.tableResults[table] ?? [];
    const next = () => queue.shift() ?? { data: null, error: null };
    const builder: any = {};
    const passthrough = () => builder;
    for (const m of ['select', 'eq']) builder[m] = passthrough;
    builder.single = () => Promise.resolve(next());
    builder.maybeSingle = () => Promise.resolve(next());
    builder.update = (patch: any) => {
      opts.onUpdate?.(table, patch);
      const upd: any = {};
      upd.eq = () => upd;
      upd.then = (resolve: any) => resolve(opts.updateResult ?? { error: null });
      return upd;
    };
    return builder;
  }
  return { from: vi.fn((t: string) => builderFor(t)) } as unknown as SupabaseClient;
}

describe('subsumeTask', () => {
  it('TC6 [AC5]: sets subsumed_by_task_id + archived; reports the transition', async () => {
    const updates: Array<{ table: string; patch: any }> = [];
    const client = makeClient({
      tableResults: {
        tasks: [
          { data: { id: ABSORBED, project_id: PROJECT_ID, subsumed_by_task_id: null, archived: false } }, // absorbed load
          { data: { id: UMBRELLA } },                                                                       // umbrella exists
        ],
      },
      onUpdate: (table, patch) => updates.push({ table, patch }),
    });

    const res = await subsumeTask(client, PROJECT_ID, { task_id: ABSORBED, subsumed_by_task_id: UMBRELLA });

    expect(res.already_subsumed).toBe(false);
    expect(res.archived).toBe(true);
    expect(res.task_id).toBe(ABSORBED);
    expect(res.subsumed_by_task_id).toBe(UMBRELLA);
    // the single update set BOTH the reverse-FK pointer and archived=true
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('tasks');
    expect(updates[0].patch).toEqual({ subsumed_by_task_id: UMBRELLA, archived: true });
  });

  it('TC6 [AC5]: idempotent — re-subsuming by the same umbrella is a no-op', async () => {
    const updates: Array<{ table: string; patch: any }> = [];
    const client = makeClient({
      tableResults: {
        tasks: [
          // already subsumed by THIS umbrella + archived
          { data: { id: ABSORBED, project_id: PROJECT_ID, subsumed_by_task_id: UMBRELLA, archived: true } },
        ],
      },
      onUpdate: (table, patch) => updates.push({ table, patch }),
    });

    const res = await subsumeTask(client, PROJECT_ID, { task_id: ABSORBED, subsumed_by_task_id: UMBRELLA });

    expect(res.already_subsumed).toBe(true);
    expect(res.archived).toBe(true);
    expect(updates).toHaveLength(0);   // NO re-write (and thus the trigger won't re-log)
  });

  it('echoes the optional reason in the result', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [
          { data: { id: ABSORBED, project_id: PROJECT_ID, subsumed_by_task_id: null, archived: false } },
          { data: { id: UMBRELLA } },
        ],
      },
    });
    const res = await subsumeTask(client, PROJECT_ID, {
      task_id: ABSORBED, subsumed_by_task_id: UMBRELLA, reason: 'duplicate of the umbrella',
    });
    expect(res.reason).toBe('duplicate of the umbrella');
  });

  it('rejects a ticket subsuming itself', async () => {
    const client = makeClient({ tableResults: {} });
    await expect(
      subsumeTask(client, PROJECT_ID, { task_id: ABSORBED, subsumed_by_task_id: ABSORBED }),
    ).rejects.toThrow('cannot be subsumed by itself');
  });

  it('throws when the umbrella ticket is not found', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [
          { data: { id: ABSORBED, project_id: PROJECT_ID, subsumed_by_task_id: null, archived: false } },
          { data: null, error: { message: 'no rows' } },  // umbrella lookup fails
        ],
      },
    });
    await expect(
      subsumeTask(client, PROJECT_ID, { task_id: ABSORBED, subsumed_by_task_id: UMBRELLA }),
    ).rejects.toThrow('Umbrella ticket not found');
  });

  it('TC7 [AC3]: requires both task_id and subsumed_by_task_id (no implicit disposition)', async () => {
    const client = makeClient({ tableResults: {} });
    // missing the disposition target — guardrail: subsume_task never runs without an explicit umbrella
    await expect(
      subsumeTask(client, PROJECT_ID, { task_id: ABSORBED } as unknown as SubsumeTaskArgs),
    ).rejects.toThrow('subsumed_by_task_id is required');
    await expect(
      subsumeTask(client, PROJECT_ID, { subsumed_by_task_id: UMBRELLA } as unknown as SubsumeTaskArgs),
    ).rejects.toThrow('task_id is required');
  });
});

describe('subsume_task tool schema', () => {
  it('TC7 [AC3]: BOTH the absorbed id AND the umbrella id are required args', () => {
    expect(subsumeTaskTool.name).toBe('subsume_task');
    // the explicit-disposition guardrail is structural: both ids are required, so the
    // tool can never be invoked without a human-chosen umbrella target.
    expect(subsumeTaskTool.inputSchema.required).toEqual(
      expect.arrayContaining(['task_id', 'subsumed_by_task_id']),
    );
    const props = subsumeTaskTool.inputSchema.properties as Record<string, unknown>;
    expect(props.task_id).toBeDefined();
    expect(props.subsumed_by_task_id).toBeDefined();
    expect(props.reason).toBeDefined();
  });

  it('describes itself as explicit-action-only / surface guardrail', () => {
    expect(subsumeTaskTool.description).toMatch(/EXPLICIT-ACTION ONLY|never invoked automatically/);
  });
});
