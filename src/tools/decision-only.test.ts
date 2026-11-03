import { describe, expect, it } from 'vitest';
import { resolveDeliverableMarker, readDeliverableStatus, assertCaptureAvailable } from './decision-only.js';
import type { SupabaseClient } from '@supabase/supabase-js';
const client = (data: unknown, error: unknown = null) => ({ rpc: async () => ({ data, error }) }) as unknown as SupabaseClient;
describe('deliverable markers', () => {
  it.each([
    [[], 'none', null], [['capture-only'], 'capture', 'clarify'],
    [['decision-only'], 'decision', 'design'], [['capture-only', 'decision-only'], 'conflict', null],
  ])('resolves %j without guessing from criteria', (labels, kind, intended_gate) => {
    expect(resolveDeliverableMarker(labels as string[])).toEqual({ kind, intended_gate });
  });
  it('blocks capture on an older schema while retaining legacy design meaning', async () => {
    const old = client(null, { code: 'PGRST202' });
    expect(() => assertCaptureAvailable({ kind: 'capture', intended_gate: 'clarify', guard_available: false })).toThrow('unavailable');
    expect(await readDeliverableStatus(old, 'task', ['decision-only'])).toEqual({ kind: 'decision', intended_gate: 'design', guard_available: false });
  });
  it('requires the complete installed contract', async () => {
    expect(await readDeliverableStatus(client([{ contract_version: 1, intended_gate: 'clarify', conflicting_markers: false }]), 'task', ['capture-only'])).toEqual({ kind: 'capture', intended_gate: 'clarify', guard_available: true });
    await expect(readDeliverableStatus(client([]), 'task', ['capture-only'])).rejects.toThrow('Malformed');
    await expect(readDeliverableStatus(client(null, { code: '42501' }), 'task', ['capture-only'])).rejects.toEqual({ code: '42501' });
  });
});
