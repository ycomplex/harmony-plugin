import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readContextCompletions, completingContextReferences, lastAcceptedDesignReferences, isContextCompletingAccept, type ContextBrief, type ContextEvent } from './project-context-completion.js';
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
    // Exercise both a deferred commit and the commit sharing the accept's timestamp.
    for (const committedAt of [acceptedAt.replace('Z', '.500Z'), acceptedAt]) {
      const commit = { ...edge, created_at: committedAt, old_value: 'Decomposed', new_value: 'Designed' };
      const completions = completingContextReferences(task, [a, a, commit,
        { ...commit, event_type: 'acceptance_event_consumed' }, { ...edge, created_at: verifiedAt },
        { ...edge, event_type: 'acceptance_event_consumed', created_at: verifiedAt }], [b]);
      expect(completions).toEqual([{ brief_id: briefId, source_ids: [sourceId] }]);
      const companions = [
        ...Array.from({ length: 6 }, (_, i) => ({ ...decision, id: `clarify-${i}`, type: 'product-design', source_activity: 'clarify', madr: null, underwriting_brief_id: 'clarify-brief' })),
        { ...decision, id: 'no-split', type: 'convention', source_activity: 'decompose', madr: null },
        { ...decision, id: '71a32e0a', type: 'business', source_activity: 'clarify', madr: null },
        { ...decision, id: 'rule', type: 'convention', source_activity: null, madr: null, tags: ['rule'], underwriting_brief_id: briefId },
      ];
      expect(resolve([{ ...decision, id: sourceId }, ...companions], completions)).toMatchObject({ state: 'accepted', source_ids: [sourceId], summary: 'Use tokens.' });
      expect(resolve([{ ...decision, id: sourceId }, ...companions], [])).toMatchObject({ state: 'accepted', source_ids: [sourceId] });
    }
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
    const otherAccept = { ...accept, created_at: '2026-11-02T17:38:22Z', metadata: { ...accept.metadata, brief_id: 'another-brief' } };
    expect(completingContextReferences(task, [accept, otherAccept, edge], [brief])).toEqual([]);
    expect(completingContextReferences(task, [accept, { ...edge, event_type: 'acceptance_event_consumed' }], [brief])).toEqual([]);
    expect(completingContextReferences(task, [accept, { ...intervening, created_at: accept.created_at }, edge], [brief])).toEqual([]);
  });
  it('refuses qualifying unreadable/conflicting links instead of falling back', () => {
    expect(resolve([{ ...decision, id: 'fallback' }]).diagnostics.join()).toContain('Unreadable completing');
    const conflicting = [{ ...brief, doc: { ...brief.doc, payload: [...brief.doc!.payload!, { write_kind: 'rule_bundle', decision_id: 'other' }] } }];
    expect(resolve([decision], completingContextReferences(task, [accept, edge], conflicting)).diagnostics.join()).toContain('conflicting');
    expect(resolve([{ ...decision, superseded_by: 'missing' }]).diagnostics.join()).toContain('Unreadable successor');
    expect(resolve([{ ...decision, superseded_by: decision.id }]).diagnostics.join()).toContain('cycle');
    expect(resolve([{ ...decision, project_id: 'other' }]).state).toBe('unresolved');
  });
  it('only counts genuine design candidates, irrespective of type', () => {
    const architectureRule = { ...decision, id: 'rule', type: 'architecture', tags: ['rule'], underwriting_brief_id: brief.id };
    expect(resolve([decision, architectureRule], []).state).toBe('accepted');
    expect(resolve([decision, { ...decision, id: 'genuine', type: 'business' }], []).diagnostics.join()).toContain('Competing');
    expect(resolve([{ ...decision, madr: null }], []).diagnostics.join()).toContain('needs a bounded authored');
  });
});

describe('brief reference and query contracts', () => {
  it.each(['explicit', { type: 'decision', id: 'explicit' }])('uses a valid decision reference %j ahead of payload links', decision_ref => {
    const completions = completingContextReferences(task, [accept, edge], [{ ...brief, decision_ref }]);
    expect(completions).toEqual([{ brief_id: brief.id, source_ids: ['explicit'] }]);
    expect(resolve([{ ...decision, id: 'explicit' }], completions)).toMatchObject({ state: 'accepted', source_ids: ['explicit'] });
  });
  it.each([undefined, null, '', '   ', {}, { type: 'decision' }, { id: '' }, { id: '  ' }, { id: 42 }, 42, []])(
    'falls back to payload links for missing or malformed reference %j', decision_ref => {
      expect(completingContextReferences(task, [accept, edge], [{ ...brief, decision_ref }]))
        .toEqual([{ brief_id: brief.id, source_ids: ['d1dc1b99'] }]);
    });
  it('reads completing briefs using only real table columns and scopes by task and brief', async () => {
    const briefColumns = new Set(['id', 'task_id', 'reason', 'doc', 'content', 'decision_ref', 'status', 'iteration']);
    const filters: [string, unknown][] = [];
    const client = { from(table: string) {
      const validate = (column: string) => {
        if (table === 'briefs' && !briefColumns.has(column)) throw new Error(`column briefs.${column} does not exist`);
      };
      const query = {
        select(columns: string) { columns.split(',').forEach(validate); return query; },
        eq(column: string, value: unknown) { validate(column); if (table === 'briefs') filters.push([column, value]); return query; },
        order() { return query; },
        range: async () => ({ data: [accept, edge], error: null }),
        maybeSingle: async () => ({ data: { ...brief, decision_ref: { type: 'decision', id: 'explicit' } }, error: null }),
      };
      return query;
    } } as unknown as SupabaseClient;
    expect(await readContextCompletions(client, 'luma', task))
      .toEqual([{ brief_id: brief.id, source_ids: ['explicit'] }]);
    expect(filters).toEqual([['task_id', task.id], ['id', brief.id]]);
  });
});

it('resolves LDS-9 override design with a null madr while keeping the consumer human-only', () => {
  const identity = { ...task, title: 'Decide the authentication & identity approach', task_number: 9 };
  const design = { ...brief, id: 'identity-brief', doc: { payload: [{ write_kind: 'knowledge_entry_content', entry_id: 'dedb0bfa' }] } };
  const events: ContextEvent[] = [
    { ...accept, created_at: '2026-11-05T14:45:52Z', metadata: { command: 'accept', brief_id: 'clarify', provenance: 'human-in-browser' } },
    { ...accept, created_at: '2026-11-05T14:46:44.996Z', metadata: { command: 'accept', brief_id: design.id, provenance: 'agent-synthesized:override' } },
    { ...edge, created_at: '2026-11-05T14:46:50.682Z', old_value: 'Decomposed', new_value: 'Designed' },
    { ...edge, event_type: 'acceptance_event_consumed', created_at: '2026-11-05T14:46:50.682Z', old_value: 'Decomposed', new_value: 'Designed' },
    { ...edge, created_at: '2026-11-05T14:46:55.980Z' },
  ];
  const briefs = [design, { id: 'clarify', reason: 'clarification-draft', decision_ref: 'd8f13a99' }];
  const completions = completingContextReferences(identity, events, briefs);
  expect(completions).toEqual([]);
  expect(isContextCompletingAccept({ ...identity, reason: design.reason, provenance: 'agent-synthesized:override',
    completion: { gate: 'design', to_state: 'Verified' } })).toBe(false);
  const ids = lastAcceptedDesignReferences(events, briefs);
  const sources = [{ ...decision, id: 'dedb0bfa', madr: null, content: '**Claim:** Use hosted identity.\n\n**Claim source:** authored\n\nRationale' },
    { ...decision, id: 'd8f13a99', type: 'specification', source_activity: 'clarify' }];
  const resolveIdentity = (entries: ContextSource[]) => resolveContextBlock('luma', 'identity', 'Identity', [identity], entries, new Map(), 'LDS', completions, new Set(), ids);
  expect(resolveIdentity(sources)).toMatchObject({ state: 'accepted', source_ids: ['dedb0bfa'], summary: 'Use hosted identity.' });
  expect(resolveIdentity([...sources, { ...decision, id: 'companion' }])).toMatchObject({ state: 'accepted', source_ids: ['dedb0bfa'] });
  expect(lastAcceptedDesignReferences(events, [...briefs, { ...design, id: 'unaccepted' }])).toEqual(['dedb0bfa']);
});
it('uses only the last accepted design payload and leaves multiple named candidates competing', () => {
  const newer = { ...brief, id: 'newer', decision_ref: 'ignored', doc: { payload: [
    { write_kind: 'knowledge_entry_content', entry_id: 'one' }, { write_kind: 'rule_bundle', decision_id: 'two' } ] } };
  const ids = lastAcceptedDesignReferences([accept, { ...accept, created_at: '2026-11-03T00:00:00Z',
    metadata: { command: 'accept', brief_id: newer.id, provenance: 'agent-synthesized:override' } }], [brief, newer]);
  expect(ids).toEqual(['one', 'two']);
  expect(resolveContextBlock('luma', 'architecture', 'Architecture', [task],
    [{ ...decision, id: 'one' }, { ...decision, id: 'two' }], new Map(), 'LDS', [], new Set(), ids).diagnostics.join()).toContain('Competing');
});
