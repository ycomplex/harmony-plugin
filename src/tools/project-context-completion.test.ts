import { describe, expect, it } from 'vitest';
import { completingContextReferences, type ContextBrief, type ContextEvent } from './project-context-completion.js';
import { resolveContextBlock, type ContextSource } from './project-context.js';
const task = { id: 'scaffold', title: 'Decide the architecture', task_number: 2, workflow_state: 'Verified', labels: ['decision-only'] };
const brief: ContextBrief = { id: '01657515', reason: 'design-decision-draft', doc: {
  frame: {}, payload: [{ write_kind: 'knowledge_entry_content', entry_id: 'd1dc1b99' },
    { write_kind: 'rule_bundle', decision_id: 'd1dc1b99' }],
} };
const accept: ContextEvent = { created_at: '2026-11-02T17:38:20Z', event_type: 'brief_resolved',
  metadata: { command: 'accept', brief_id: brief.id, provenance: 'human-in-session' } };
const edge: ContextEvent = { created_at: '2026-11-02T17:38:24Z', event_type: 'field_change', field_name: 'workflow_state', old_value: 'Designed', new_value: 'Verified' };
const decision: ContextSource = { id: 'd1dc1b99', project_id: 'luma', source_task_id: task.id, type: 'technical-design',
  status: 'Accepted', superseded_by: null, source_activity: 'design-decide', madr: { project_context: { summary: 'Use tokens.' } }, content: '' };
const resolve = (sources: ContextSource[], completions = completingContextReferences(task, [accept, accept, edge], [brief])) =>
  resolveContextBlock('luma', 'architecture', 'Architecture', [task], sources, new Map(), 'LDS', completions);
describe('recorded completing authority', () => {
  it.each([
    ['LDS-2', '01657515', 'd1dc1b99', '2026-11-02T17:38:20Z', '2026-11-02T17:38:24Z'],
    ['LDS-3', 'c31b05c6', '08778522', '2026-11-03T09:42:17Z', '2026-11-03T09:42:33Z'],
  ])('resolves the exact payload-only %s shape with duplicate accepts and companion entries', (_ticket, briefId, sourceId, acceptedAt, verifiedAt) => {
    const b = { ...brief, id: briefId, doc: { frame: {}, payload: [
      { write_kind: 'knowledge_entry_content', entry_id: sourceId }, { write_kind: 'rule_bundle', decision_id: sourceId },
    ] } };
    const a = { ...accept, created_at: acceptedAt, metadata: { ...accept.metadata, brief_id: briefId } };
    const completions = completingContextReferences(task, [a, a, { ...edge, created_at: verifiedAt }], [b]);
    expect(completions).toEqual([{ brief_id: briefId, source_ids: [sourceId] }]);
    const companions = [
      ...Array.from({ length: 6 }, (_, i) => ({ ...decision, id: `clarify-${i}`, type: 'product-design', source_activity: 'clarify', madr: null, underwriting_brief_id: 'clarify-brief' })),
      { ...decision, id: 'no-split', type: 'convention', source_activity: 'decompose', madr: null },
      { ...decision, id: '71a32e0a', type: 'business', source_activity: 'clarify', madr: null },
      { ...decision, id: 'rule', type: 'convention', source_activity: null, madr: null, tags: ['rule'], underwriting_brief_id: briefId },
    ];
    expect(resolve([{ ...decision, id: sourceId }, ...companions], completions)).toMatchObject({ state: 'accepted', source_ids: [sourceId], summary: 'Use tokens.' });
    expect(resolve([{ ...decision, id: sourceId }, ...companions], [])).toMatchObject({ state: 'accepted', source_ids: [sourceId] });
  });
  it('prefers explicit decision_ref and follows project-local supersession', () => {
    const completions = completingContextReferences(task, [accept], [{ ...brief, decision_ref: 'd1dc1b99', doc: { frame: { completion: { gate: 'design', to_state: 'Verified' } }, payload: [{ write_kind: 'rule_bundle', decision_id: 'wrong' }] } }]);
    expect(resolve([{ ...decision, status: 'Superseded', superseded_by: 'next' }, { ...decision, id: 'next', source_task_id: null }, { ...decision, id: 'other' }], completions)).toMatchObject({ state: 'accepted', source_ids: ['next'] });
  });
  it('uses fallback for agent accepts or missing markers, but never consumes them', () => {
    for (const t of [task, { ...task, labels: [] }]) {
      const events = t === task ? [{ ...accept, metadata: { ...accept.metadata, provenance: 'agent-synthesized:orchestrator' } }, edge] : [accept, edge];
      const completions = completingContextReferences(t, events, [brief]);
      expect(completions).toEqual([]);
      expect(resolve([decision], completions).state).toBe('accepted');
    }
  });
  it('requires legacy completion evidence, not timestamps alone', () => {
    expect(completingContextReferences(task, [accept], [brief])).toEqual([]);
    expect(completingContextReferences(task, [accept, { ...edge, old_value: 'Planned' }], [brief])).toEqual([]);
    const intervening = { ...edge, created_at: '2026-11-02T17:38:22Z', new_value: 'Parked' };
    expect(completingContextReferences(task, [accept, intervening, edge], [brief])).toEqual([]);
  });
  it('refuses qualifying unreadable/conflicting links instead of falling back', () => {
    expect(resolve([{ ...decision, id: 'fallback' }]).diagnostics.join()).toContain('Unreadable completing');
    const conflicting = [{ ...brief, doc: { ...brief.doc, payload: [...brief.doc!.payload!, { write_kind: 'rule_bundle', decision_id: 'other' }] } }];
    expect(resolve([decision], completingContextReferences(task, [accept, edge], conflicting)).diagnostics.join()).toContain('conflicting');
    expect(resolve([{ ...decision, superseded_by: 'missing' }]).diagnostics.join()).toContain('Unreadable successor');
    expect(resolve([{ ...decision, superseded_by: decision.id }]).diagnostics.join()).toContain('cycle');
    expect(resolve([{ ...decision, project_id: 'other' }]).state).toBe('unresolved');
  });
  it('only counts genuine design+madr candidates, irrespective of type', () => {
    const architectureRule = { ...decision, id: 'rule', type: 'architecture', tags: ['rule'], underwriting_brief_id: brief.id };
    expect(resolve([decision, architectureRule], []).state).toBe('accepted');
    expect(resolve([decision, { ...decision, id: 'genuine', type: 'business' }], []).diagnostics.join()).toContain('Competing');
    expect(resolve([{ ...decision, madr: null }], []).diagnostics.join()).toContain('no readable Accepted');
  });
});
