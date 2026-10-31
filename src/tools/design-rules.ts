import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BriefDoc } from './briefs.js';

export const ruleReachSchema = z.enum(['this_ticket_only', 'this_surface', 'this_product']);
export const designRuleSchema = z.object({
  ref: z.string().trim().min(1),
  operation: z.enum(['create', 'amend', 'reference']),
  wording: z.string().trim().min(1),
  reach: z.enum(['this_surface', 'this_product']),
  scope: z.enum(['product', 'deployment']),
  domains: z.array(z.string().trim().min(1)).min(1),
  surfaces: z.array(z.string().trim().min(1)),
  entry_id: z.string().uuid().optional(),
  expected_fingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  before: z.string().trim().min(1).optional(),
}).superRefine((rule, context) => {
  if (rule.operation !== 'create' && (!rule.entry_id || !rule.expected_fingerprint)) {
    context.addIssue({ code: 'custom', message: 'Reference and amend require an explicit entry and expected fingerprint' });
  }
  if (rule.operation === 'amend' && !rule.before) {
    context.addIssue({ code: 'custom', message: 'Amend requires the approved before wording' });
  }
  if (rule.operation === 'create' && (rule.entry_id || rule.expected_fingerprint || rule.before)) {
    context.addIssue({ code: 'custom', message: 'Create cannot target an existing entry' });
  }
  if (rule.reach === 'this_surface' && !rule.surfaces.length) {
    context.addIssue({ code: 'custom', message: 'Surface rules require an applicable surface' });
  }
});
export type DesignRule = z.infer<typeof designRuleSchema>;

export function renderRules(reach: string | undefined, rules: DesignRule[] = []): string[] {
  if (!reach) return [];
  return [`**Decision reach:** ${reach}`, '**Rules:**', ...rules.flatMap(rule => [
    `- ${rule.operation}: ${rule.operation === 'create' ? rule.ref : rule.entry_id} (${rule.reach}; ${rule.scope}; domains: ${rule.domains.join(', ')}; surfaces: ${rule.surfaces.join(', ') || 'all'})`,
    ...(rule.before ? [`  Before: ${rule.before}`] : []),
    `  ${rule.operation === 'reference' ? 'Approved wording (reference only)' : 'Approved rule wording'}: ${rule.wording}`,
    ...(rule.expected_fingerprint ? [`  Expected fingerprint: ${rule.expected_fingerprint}`] : []),
  ])];
}

export async function withRuleBundle(client: SupabaseClient, doc: BriefDoc, reason: string): Promise<BriefDoc> {
  if (reason !== 'design-decision-draft' || doc.frame?.kind !== 'design') return doc;
  const frame = doc.frame;
  const rules = frame.rules ?? [];
  const payload = (doc.payload ?? []).filter(item => item.write_kind !== 'rule_bundle');
  if (!frame.decision_reach) {
    if (rules.length || payload.length !== (doc.payload ?? []).length) throw new Error('Rules require an explicit decision_reach');
    return { ...doc, payload };
  }
  if (new Set(rules.map(rule => rule.ref)).size !== rules.length) throw new Error('Rule refs must be unique');
  if (frame.decision_reach === 'this_ticket_only' && rules.some(rule => rule.operation !== 'reference')) {
    throw new Error('Ticket-only designs may reference rules but cannot create or amend them');
  }
  if (frame.decision_reach !== 'this_ticket_only' && !rules.length) throw new Error('Broader reach requires approved rules');
  if (!rules.length) return { ...doc, payload };
  const { data, error } = await client.rpc('knowledge_rule_bundle_capable');
  if (error || data !== true) throw new Error(`Rule promises unavailable until database promotion: ${error?.message ?? 'capability absent'}`);
  return { ...doc, payload: [...payload, { write_kind: 'rule_bundle', ref: 'design-rules', rules }] };
}
