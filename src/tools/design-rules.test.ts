import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BriefDoc } from './briefs.js';
import { renderEntry, renderBrief } from './briefs.js';
import { designRuleSchema, withRuleBundle, type DesignRule } from './design-rules.js';
import { validateBriefFrame } from './brief-frame-schema.js';

const rule: DesignRule = { ref: 'single-writer', operation: 'create', wording: 'Acceptance uses one ledger writer.',
  reach: 'this_surface', scope: 'product', domains: ['engineering'], surfaces: ['design gate composition'] };
function document(reach: 'this_surface' | 'this_ticket_only' = 'this_surface'): BriefDoc {
  return { decide: 'Approve the design?', recommend: { text: 'Use one writer.', confidence: 'high' },
    items: [], frame: { kind: 'design', track: 'technical-design', tracks: [], reach: ['Design gate'],
      decision_reach: reach, rules: [rule] } };
}
function client(data: boolean | null = true, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) } as unknown as SupabaseClient;
}
describe('canonical design rules', () => {
  it('creates no rule promise for a ticket-only design without rules', async () => {
    const doc = document('this_ticket_only');
    if (doc.frame?.kind === 'design') doc.frame.rules = [];
    const database = client();
    expect((await withRuleBundle(database, doc, 'design-decision-draft')).payload).toEqual([]);
    expect(database.rpc).not.toHaveBeenCalled();
  });
  it('derives one bundle from the same declarations the human sees', async () => {
    const doc = await withRuleBundle(client(), document(), 'design-decision-draft');
    expect(doc.payload).toEqual([{ write_kind: 'rule_bundle', ref: 'design-rules', rules: [rule] }]);
    expect(renderBrief(doc)).toContain(rule.wording);
    expect(renderEntry(doc)).not.toContain(rule.wording);
    expect(renderEntry(doc)).toContain('Rule citations');
    expect((await withRuleBundle(client(), doc, 'design-decision-draft')).payload).toHaveLength(1);
  });
  it('refuses unsupported promises without changing the approved declaration', async () => {
    const doc = document();
    await expect(withRuleBundle(client(null, { message: 'RPC absent' }), doc, 'design-decision-draft')).rejects.toThrow('RPC absent');
    expect(doc.frame).toMatchObject({ rules: [rule] });
  });
  it('keeps legacy frames usable and rejects broader reach without rules', () => {
    const frame = { kind: 'design', track: 'technical-design', tracks: [], reach: [] };
    expect(() => validateBriefFrame(frame, 'design')).not.toThrow();
    expect(() => validateBriefFrame({ ...frame, decision_reach: 'this_product', rules: [] })).toThrow('non-empty');
    expect(() => validateBriefFrame(document('this_ticket_only').frame)).toThrow('Ticket-only');
  });
  it('requires explicit amendment targets, fingerprints and before wording', () => {
    expect(designRuleSchema.safeParse({ ...rule, operation: 'amend' }).success).toBe(false);
    expect(designRuleSchema.safeParse({ ...rule, operation: 'reference', entry_id: 'not-a-uuid' }).success).toBe(false);
    expect(designRuleSchema.safeParse({ ...rule, operation: 'amend', entry_id: '00000000-0000-4000-8000-000000000001',
      expected_fingerprint: 'a'.repeat(64), before: 'Use another writer.' }).success).toBe(true);
  });
});
