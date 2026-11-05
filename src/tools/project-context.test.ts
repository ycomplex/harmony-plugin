import { describe, expect, it } from 'vitest';
import { CONTEXT_CATEGORIES, resolveContextBlock, sourceSummary, type ContextSource, type ContextTask } from './project-context.js';
const task: ContextTask = { id: 'ticket', title: 'Decide the architecture', task_number: 3, workflow_state: 'Verified' };
const source = (patch: Partial<ContextSource> = {}): ContextSource => ({ id: 'decision', project_id: 'project', source_task_id: 'ticket', type: 'technical-design', source_activity: 'design-decide', madr: {}, status: 'Accepted', superseded_by: null, content: '**Claim:** Use a modular monolith.\n\n**Claim source:** authored\n\nRationale', ...patch });
const resolve = (sources: ContextSource[], tasks = [task]) => resolveContextBlock('project', 'architecture', 'Architecture', tasks, sources, new Map(), 'LDS');
describe('project context authority', () => {
  it('covers every canonical S2 category', () => expect(CONTEXT_CATEGORIES).toHaveLength(9));
  it('renders an authored Accepted claim with source and ticket identities', () => {
    expect(resolve([source()])).toMatchObject({ state: 'accepted', summary: 'Use a modular monolith.', source_ids: ['decision'], ticket: 'LDS-3' });
  });
  it('follows explicit supersession and rejects unreadable successors', () => {
    expect(resolve([source({ status: 'Superseded', superseded_by: 'new' }), source({ id: 'new', source_task_id: null })]).source_ids).toEqual(['new']);
    expect(resolve([source({ superseded_by: 'missing' })]).diagnostics.join()).toContain('Unreadable successor');
  });
  it('does not choose a competing decision by timestamp or include other projects', () => {
    expect(resolve([source(), source({ id: 'other' })]).state).toBe('unresolved');
    expect(resolve([source({ project_id: 'other-project' })]).state).toBe('unresolved');
  });
  it('rejects cycles and duplicate scaffold identities', () => {
    expect(resolve([source({ superseded_by: 'decision' })]).diagnostics.join()).toContain('cycle');
    expect(resolve([source()], [task, { ...task, id: 'duplicate' }]).state).toBe('unresolved');
  });
  it('keeps undecided separate from N/A and requires an explicit authored N/A', () => {
    expect(resolve([], [{ ...task, workflow_state: 'Proposed' }])).toMatchObject({ state: 'undecided', summary: null });
    expect(resolve([source({ content: '**Claim:** N/A for this project: no persistence.\n\n**Claim source:** authored\n\n' })]).summary).toContain('N/A for this project');
  });
  it('refuses derived claims and unbounded or arbitrary legacy prose', () => {
    expect(resolve([source({ content: 'A full rationale without a confirmed summary' })]).state).toBe('unresolved');
    expect(resolve([source({ content: '**Claim:** Proposed text.\n\n**Claim source:** derived\n\n' })]).state).toBe('unresolved');
    expect(sourceSummary(source({ madr: { project_context: { summary: 'x'.repeat(1201) } }, content: '' }), false)).toBeNull();
  });
  it('requires all three proposition dimensions and preserves their exact authored wording', () => {
    expect(sourceSummary(source(), true)).toBeNull();
    expect(sourceSummary(source({ madr: { project_context: { purpose: 'Make tokens.', personas: 'Designers.', features: 'Exports.' } } }), true))
      .toBe('Purpose: Make tokens. Personas: Designers. Features: Exports.');
  });
  it('resolves a linked source without requiring source_task_id', () => {
    expect(resolveContextBlock('project', 'architecture', 'Architecture', [task], [source({ source_task_id: null })], new Map([['ticket', ['decision']]]), 'LDS').state).toBe('accepted');
  });
});

// Exercise the real shared read handler with a paged, read-only database port.
import { vi } from 'vitest';
import { readProjectContext } from './project-context.js';
import type { SupabaseClient } from '@supabase/supabase-js';
it('reads only this project, pages past the API limit, and propagates read failures', async () => {
  const calls: { table: string; filters: unknown[][] }[] = [];
  const rows = Array.from({ length: 501 }, (_, i) => source({ id: `source-${String(i).padStart(4, '0')}`, source_task_id: 'unrelated' }));
  rows[500] = source({ id: 'last-page' });
  const from = vi.fn((table: string) => {
    let start = 0, end = 499;
    const call = { table, filters: [] as unknown[][] }; calls.push(call);
    const query = {
      select: () => query, eq: (...args: unknown[]) => { call.filters.push(args); return query; },
      is: (...args: unknown[]) => { call.filters.push(args); return query; }, order: () => query,
      range: (a: number, b: number) => { start = a; end = b; return query; },
      single: async () => ({ data: { id: 'project', name: 'Example', key: 'EX' }, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve(done({ error: null, data:
        table === 'tasks' ? [task] : table === 'knowledge_decisions' ? rows.slice(start, end + 1) : [] })),
    };
    return query;
  });
  const result = await readProjectContext({ from } as unknown as SupabaseClient, 'project');
  expect(result.blocks.find(b => b.key === 'architecture')).toMatchObject({ state: 'accepted', source_ids: ['last-page'] });
  expect(calls.filter(c => ['tasks', 'knowledge_decisions'].includes(c.table)).every(c => c.filters.some(f => f[0] === 'project_id' && f[1] === 'project'))).toBe(true);
  expect(calls.filter(c => c.table === 'knowledge_decisions')).toHaveLength(2);
  const broken = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null, error: new Error('denied') }) }) }) }) };
  await expect(readProjectContext(broken as unknown as SupabaseClient, 'project')).rejects.toThrow('denied');
});
it('preserves ratified proposition context lines without deriving missing dimensions', () => {
  const content = '- Project context purpose: Ship tokens.\n- Project context personas: Designers.\n- Project context features: Export.';
  expect(sourceSummary(source({ content }), true)).toBe('Purpose: Ship tokens. Personas: Designers. Features: Export.');
  expect(sourceSummary(source({ content: content + '\n- Project context purpose: Competing.' }), true)).toBeNull();
});
it('does not read sources or manufacture missing diagnostics when no live scaffold exists', async () => {
  const tables: string[] = [];
  const client = { from: (table: string) => {
    tables.push(table);
    const q = { select: () => q, eq: () => q, is: () => q, order: () => q, range: () => q,
      single: async () => ({ data: { id: 'project', name: 'Harmony', key: 'B' }, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve(done({ data: [], error: null })),
    }; return q;
  } } as unknown as SupabaseClient;
  expect(await readProjectContext(client, 'project')).toMatchObject({ applicability: 'not_applicable', blocks: [], diagnostics: [] });
  expect(tables).toEqual(['projects', 'tasks']);
});
it('excludes cited bundle members independent of entry type or missing legacy tags', () => {
  expect(resolveContextBlock('project', 'architecture', 'Architecture', [task],
    [source(), source({ id: 'architecture-rule', type: 'architecture' })], new Map(), 'LDS', [], new Set(['architecture-rule'])))
    .toMatchObject({ state: 'accepted', source_ids: ['decision'] });
});
it('retains all deliverable labels while the scaffold join filters inception membership', async () => {
  const selects: string[] = [];
  const client = { from: (table: string) => {
    const q = { select: (value: string) => { if (table === 'tasks') selects.push(value); return q; }, eq: () => q, is: () => q, order: () => q, range: () => q,
      single: async () => ({ data: { id: 'project', name: 'Example', key: 'EX' }, error: null }),
      maybeSingle: async () => ({ data: { id: 'brief', reason: 'design-decision-draft', decision_ref: 'decision', doc: { frame: { completion: { gate: 'design', to_state: 'Verified' } } } }, error: null }),
      then: (done: (value: unknown) => unknown) => Promise.resolve(done({ error: null, data:
        table === 'tasks' ? [{ ...task, task_labels: [{ labels: { name: 'inception-scaffold' } }], all_labels: [{ labels: { name: 'inception-scaffold' } }, { labels: { name: 'decision-only' } }] }] :
        table === 'activity_events' ? [{ event_type: 'brief_resolved', created_at: '2026-11-02T17:38:20Z', metadata: { command: 'accept', brief_id: 'brief', provenance: 'human-in-browser' } }] :
        table === 'knowledge_decisions' ? [source(), source({ id: 'other' })] : [] })),
    }; return q;
  } } as unknown as SupabaseClient;
  const result = await readProjectContext(client, 'project');
  expect(selects[0]).toContain('all_labels:task_labels');
  expect(result.blocks.find(b => b.key === 'architecture')).toMatchObject({ state: 'accepted', source_ids: ['decision'] });
  expect(result.applicability).toBe('applicable');
  expect(result.diagnostics).toContain('What this project is: Scaffold ticket not found.');
});
