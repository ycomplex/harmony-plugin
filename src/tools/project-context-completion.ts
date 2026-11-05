import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveDeliverableMarker } from './decision-only.js';

export interface CompletionInput {
  workflow_state: string;
  labels: (string | { name?: string })[];
  reason: string;
  provenance: string;
  completion?: { gate?: string; to_state?: string };
  legacy_design_completion?: boolean;
}
/** Legacy evidence is supplied only by the recorded accept/fast-forward correlation below. */
export function isContextCompletingAccept(input: CompletionInput): boolean {
  const marker = resolveDeliverableMarker(input.labels);
  return input.workflow_state === 'Verified' && marker.intended_gate !== null &&
    ['human-in-session', 'human-in-browser'].includes(input.provenance) &&
    input.reason === (marker.intended_gate === 'clarify' ? 'clarification-draft' : 'design-decision-draft') &&
    (input.completion
      ? input.completion.gate === marker.intended_gate && input.completion.to_state === 'Verified'
      : marker.intended_gate === 'design' && input.legacy_design_completion === true);
}
export interface ContextEvent {
  created_at: string; event_type: string; field_name?: string | null;
  old_value?: string | null; new_value?: string | null; metadata?: Record<string, unknown> | null;
}
export interface ContextBrief {
  id: string; reason: string; decision_ref?: unknown;
  doc?: { frame?: { completion?: CompletionInput['completion'] }; payload?: Record<string, unknown>[] } | null;
}
export interface ContextCompletion { brief_id: string; source_ids: string[] }
export function completingContextReferences(task: Pick<CompletionInput, 'workflow_state' | 'labels'>,
  events: ContextEvent[], briefs: ContextBrief[]): ContextCompletion[] {
  const sorted = [...events].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const result = new Map<string, ContextCompletion>();
  for (const event of sorted) {
    const meta = event.metadata;
    if (event.event_type !== 'brief_resolved' || meta?.command !== 'accept') continue;
    const brief = briefs.find(b => b.id === meta.brief_id);
    if (!brief) continue;
    // Deferred acceptance can commit X -> Designed before the final fast-forward.
    // Only the real field-change row establishes completion; its ledger audit twin does not.
    const acceptedAt = Date.parse(event.created_at);
    const completionEdge = sorted.find(e => Date.parse(e.created_at) > acceptedAt &&
      e.event_type === 'field_change' && e.field_name === 'workflow_state' &&
      e.old_value === 'Designed' && e.new_value === 'Verified');
    const intervening = completionEdge ? sorted.filter(e =>
      Date.parse(e.created_at) >= acceptedAt && Date.parse(e.created_at) < Date.parse(completionEdge.created_at)) : [];
    const legacy = completionEdge !== undefined && !intervening.some(e =>
      (e.event_type === 'brief_resolved' && e.metadata?.command === 'accept' && e.metadata.brief_id !== brief.id) ||
      (e.field_name === 'workflow_state' &&
        (!['field_change', 'acceptance_event_consumed'].includes(e.event_type) || e.new_value !== 'Designed')));
    if (!isContextCompletingAccept({ ...task, reason: brief.reason, provenance: String(meta.provenance ?? ''),
      completion: brief.doc?.frame?.completion, legacy_design_completion: legacy })) continue;
    const payloadIds = (brief.doc?.payload ?? []).flatMap(item => {
      const id = item.write_kind === 'knowledge_entry_content' ? item.entry_id :
        item.write_kind === 'rule_bundle' ? item.decision_id : null;
      return typeof id === 'string' && id ? [id] : [];
    });
    const ref = brief.decision_ref;
    const decisionId = typeof ref === 'string' ? ref :
      ref && typeof ref === 'object' && 'id' in ref ? ref.id : null;
    result.set(brief.id, { brief_id: brief.id,
      source_ids: typeof decisionId === 'string' && decisionId.trim()
        ? [decisionId] : [...new Set(payloadIds)].sort() });
  }
  return [...result.values()];
}
/** Shared read-only evidence path for the projection and after-accept consumer. */
export async function readContextCompletions(client: SupabaseClient, projectId: string,
  task: { id: string; workflow_state: string; labels: CompletionInput['labels'] }): Promise<ContextCompletion[]> {
  if (task.workflow_state !== 'Verified' || !resolveDeliverableMarker(task.labels).intended_gate) return [];
  const events: ContextEvent[] = [], briefs: ContextBrief[] = [];
  for (let offset = 0; ; offset += 500) {
    const result = await client.from('activity_events')
      .select('created_at,event_type,field_name,old_value,new_value,metadata')
      .eq('project_id', projectId).eq('task_id', task.id).order('created_at').order('id').range(offset, offset + 499);
    if (result.error) throw result.error;
    events.push(...(result.data ?? []));
    if ((result.data ?? []).length < 500) break;
  }
  for (const id of new Set(events.filter(e => e.event_type === 'brief_resolved' && e.metadata?.command === 'accept')
    .flatMap(e => typeof e.metadata?.brief_id === 'string' ? [e.metadata.brief_id] : []))) {
    const result = await client.from('briefs').select('id,reason,decision_ref,doc')
      .eq('task_id', task.id).eq('id', id).maybeSingle();
    if (result.error) throw result.error;
    if (result.data) briefs.push(result.data);
  }
  return completingContextReferences(task, events, briefs);
}
