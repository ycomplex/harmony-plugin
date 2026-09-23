import { describe, it, expect, vi } from 'vitest';
import { writeGateSlot } from './gate-slots.js';

/** B-1062 step 5 — the OPTIONAL `ratified_by` override on the `task` route (the ONE route it can
 *  reach — see `WriteGateSlotArgs.ratified_by`'s doc comment for why the `acceptance-event` route
 *  cannot be overridden). A minimal, chainable client mock scoped to exactly this write path. */
function makeTaskRouteClient(existingFieldValues: Record<string, unknown> = {}) {
  const updates: Array<{ table: string; payload: any }> = [];
  const from = vi.fn((table: string) => {
    const chain: any = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.update = vi.fn((payload: any) => { updates.push({ table, payload }); return chain; });
    chain.maybeSingle = vi.fn(async () => ({ data: { field_values: existingFieldValues }, error: null }));
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ error: null });
    return chain;
  });
  return { client: { from } as any, updates };
}

describe('writeGateSlot ratified_by override (B-1062 step 5)', () => {
  it('defaults ratified_by to the gate name when omitted — every existing caller unaffected', async () => {
    const { client, updates } = makeTaskRouteClient();
    await writeGateSlot(client, {
      gate: 'release',
      content: { shipped: 'x' },
      target: { via: 'task', task_id: 'task-1' },
    });
    const slots = updates[0].payload.field_values.gate_slots;
    expect(slots.release.ratified_by).toBe('release');
  });

  it('stamps the override value when supplied (the harmony record gate-walk core stamps "recorded")', async () => {
    const { client, updates } = makeTaskRouteClient();
    await writeGateSlot(client, {
      gate: 'clarify',
      content: { solving: 'x' },
      target: { via: 'task', task_id: 'task-1' },
      ratified_by: 'recorded',
    });
    const slots = updates[0].payload.field_values.gate_slots;
    expect(slots.clarify.ratified_by).toBe('recorded');
    expect(slots.clarify.content).toEqual({ solving: 'x' });
  });

  it('the override replaces ONLY this gate\'s slot — other gates and field_values keys survive', async () => {
    const { client, updates } = makeTaskRouteClient({
      build_pr: { pr_url: 'https://github.com/x/y/pull/1' },
      gate_slots: { verify: { content: { environment: 'staging' }, ratified_by: 'verify', ratified_at: '2026-01-01T00:00:00Z' } },
    });
    await writeGateSlot(client, {
      gate: 'release',
      content: { shipped: 'x' },
      target: { via: 'task', task_id: 'task-1' },
      ratified_by: 'recorded',
    });
    const fv = updates[0].payload.field_values;
    expect(fv.build_pr).toEqual({ pr_url: 'https://github.com/x/y/pull/1' });
    expect(fv.gate_slots.verify.ratified_by).toBe('verify');
    expect(fv.gate_slots.release.ratified_by).toBe('recorded');
  });
});
