/** B-1384: shared deliverable marker contract. Legacy decision-only always means design.
 * Keep these exports stable: inception consumers (including B-1388) share this resolver.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export type DeliverableKind = 'none' | 'capture' | 'decision' | 'conflict';
export type DeliverableGate = 'clarify' | 'design';
export interface DeliverableMarker {
  kind: DeliverableKind;
  intended_gate: DeliverableGate | null;
}
export interface DeliverableStatus extends DeliverableMarker {
  guard_available: boolean;
}
export function resolveDeliverableMarker(labels: readonly (string | { name?: string })[]): DeliverableMarker {
  const names = labels.map(label => typeof label === 'string' ? label : label.name);
  const capture = names.includes('capture-only');
  const decision = names.includes('decision-only');
  if (capture && decision) return { kind: 'conflict', intended_gate: null };
  if (capture) return { kind: 'capture', intended_gate: 'clarify' };
  if (decision) return { kind: 'decision', intended_gate: 'design' };
  return { kind: 'none', intended_gate: null };
}

export function isMissingCompletionCapability(error: { code?: string; message?: string }): boolean {
  return error.code === '42883' || error.code === 'PGRST202';
}
/** Only missing function/schema-cache means unavailable. Other failures remain visible. */
export async function readDeliverableStatus(
  client: SupabaseClient, taskId: string, labels: readonly (string | { name?: string })[],
): Promise<DeliverableStatus> {
  const marker = resolveDeliverableMarker(labels);
  // Ordinary tickets require no new schema and retain their existing read behavior.
  if (marker.kind === 'none') return { ...marker, guard_available: false };
  const { data, error } = await client.rpc('decision_only_completion_status', { _task_id: taskId });
  if (error) {
    if (isMissingCompletionCapability(error)) return { ...marker, guard_available: false };
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.contract_version !== 1 || typeof row.conflicting_markers !== 'boolean'
      || ![null, 'clarify', 'design'].includes(row.intended_gate)) {
    throw new Error('Malformed guarded deliverable-completion capability response');
  }
  if (row.conflicting_markers !== (marker.kind === 'conflict') || row.intended_gate !== marker.intended_gate) {
    throw new Error('Deliverable markers changed during capability read; re-read the ticket');
  }
  return { ...marker, guard_available: true };
}

export function assertCaptureAvailable(status: DeliverableStatus): void {
  if (status.kind === 'capture' && !status.guard_available) {
    throw new Error('Capture-only completion guard unavailable: file a worker-question; do not stamp, exempt or advance this ticket');
  }
  if (status.kind === 'conflict') throw new Error('Conflicting capture-only and decision-only markers: correct the labels before completion');
}

/** A proposed capture marker is not on the task yet; inspect the installed contract without guessing its current gate. */
export async function requireCaptureCompletionCapability(client: SupabaseClient, taskId: string): Promise<void> {
  const { data, error } = await client.rpc('decision_only_completion_status', { _task_id: taskId });
  if (error) {
    if (isMissingCompletionCapability(error)) throw new Error('Capture-only guarded completion unavailable; file a worker-question');
    throw error;
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.contract_version !== 1 || typeof row.conflicting_markers !== 'boolean' || ![null, 'clarify', 'design'].includes(row.intended_gate)) throw new Error('Malformed guarded deliverable-completion capability response');
  if (row.conflicting_markers) throw new Error('Conflicting deliverable markers');
}
