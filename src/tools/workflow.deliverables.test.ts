import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { advanceWorkflow } from './workflow.js';
vi.mock('./resolve-task-id.js', () => ({ resolveTaskId: async () => 'task' }));
function world({ marker = 'decision-only', state = 'Designed', human = true, proof = true, installed = true, pending = false, legacy = false } = {}) {
  const update = vi.fn();
  const gate = marker === 'capture-only' ? 'clarify' : 'design';
  const result = (data: unknown) => ({ data, error: null });
  const client = {
    rpc: async () => installed ? result([{ contract_version: 1, intended_gate: gate, conflicting_markers: false }]) : { data: null, error: { code: 'PGRST202' } },
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const method of ['select', 'eq', 'in', 'order']) chain[method] = () => chain;
      chain.single = async () => result({ workflow_state: state, stale: false, pending_acceptance_event_id: pending ? 'event' : null });
      chain.update = (patch: unknown) => { update(patch); return chain; };
      chain.limit = async () => result(proof ? [{ id: 'brief', reason: gate === 'clarify' ? 'clarification-draft' : 'design-decision-draft', status: 'accepted', resolved_command: 'accept', doc: legacy ? {} : { frame: { completion: { gate, to_state: 'Verified', realization: 'agreed' } } }, content: legacy ? 'Accepting this completes the ticket to Verified; realization stays agreed.' : '' }] : []);
      chain.then = (resolve: (value: unknown) => unknown) => resolve(result(table === 'workflow_transitions' ? [
        { from_state: 'Clarified', activity: 'fast-forwarding', to_state: 'Verified' },
        { from_state: 'Designed', activity: 'fast-forwarding', to_state: 'Verified' },
      ] : table === 'task_labels' ? [{ labels: { name: marker } }] : table === 'activity_events' ? [{ metadata: { brief_id: 'brief', command: 'accept', provenance: human ? 'human-in-browser' : 'agent-synthesized:orchestrator' } }] : []));
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, update };
}
const run = (client: SupabaseClient) => advanceWorkflow(client, 'project', { task_id: 'B-1', activity: 'fast-forwarding' });
describe('deliverable fast-forward', () => {
  it('keeps legacy bare markers at clarify in discovery', async () => {
    const w = world({ state: 'Clarified' });
    await expect(run(w.client)).rejects.toThrow('gate mismatch');
    expect(w.update).not.toHaveBeenCalled();
  });
  it.each([true, false])('completes design on installed=%s only with explicit human proof', async installed => {
    const w = world({ installed });
    expect((await run(w.client)).to_state).toBe('Verified');
    expect(w.update).toHaveBeenCalledWith({ workflow_state: 'Verified', workflow_activity: 'fast-forwarding' });
  });
  it('recovers an announced legacy human completing accept without a build detour', async () => {
    expect((await run(world({ legacy: true, installed: false }).client)).to_state).toBe('Verified');
  });
  it('requires a fresh completing brief when proof is absent', async () => {
    const w = world({ proof: false });
    await expect(run(w.client)).rejects.toThrow('completing brief required');
    expect(w.update).not.toHaveBeenCalled();
  });
  it('rejects synthesized proof and unfinished acceptance payloads', async () => {
    await expect(run(world({ human: false }).client)).rejects.toThrow('human-authored');
    await expect(run(world({ pending: true }).client)).rejects.toThrow('Consume');
  });
  it('requires installed guarded capture completion', async () => {
    await expect(run(world({ marker: 'capture-only', state: 'Clarified', installed: false }).client)).rejects.toThrow('unavailable');
    expect((await run(world({ marker: 'capture-only', state: 'Clarified' }).client)).to_state).toBe('Verified');
  });
});
