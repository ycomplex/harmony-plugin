import { describe, it, expect, vi } from 'vitest';
import { findRelatedTickets, findRelatedTicketsTool } from './find-related-tickets.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_ID = 'proj-1';
const SUBJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// A tiny chainable Supabase mock. `.from(table)` returns a builder whose terminal
// (`.single`/`.maybeSingle`) or awaited result is taken from `tableResults[table]`,
// shifted FIFO so successive same-table reads can return different rows. `.rpc(name)`
// returns `rpcResults[name]`.
function makeClient(opts: {
  tableResults: Record<string, Array<{ data: any; error?: any }>>;
  rpc: Record<string, { data: any; error?: any } | (() => never)>;
}) {
  const rpc = vi.fn((name: string) => {
    const r = opts.rpc[name];
    if (typeof r === 'function') return r();      // throw path
    return Promise.resolve(r ?? { data: null, error: null });
  });

  function builderFor(table: string) {
    const queue = opts.tableResults[table] ?? [];
    const next = () => queue.shift() ?? { data: null, error: null };
    const builder: any = {};
    const passthrough = () => builder;
    for (const m of ['select', 'eq', 'in', 'not', 'limit', 'order']) builder[m] = passthrough;
    builder.single = () => Promise.resolve(next());
    builder.maybeSingle = () => Promise.resolve(next());
    // allow `await builder` (e.g. the .in() enrich query) to resolve to next()
    builder.then = (resolve: any) => resolve(next());
    return builder;
  }

  return {
    from: vi.fn((table: string) => builderFor(table)),
    rpc,
  } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
}

function subjectRows() {
  return [
    { data: { id: SUBJECT_ID, title: 'Add saved filters', description: 'persist per-user filters' } }, // subject load
  ];
}
function projectRows() {
  return [{ data: { workspace_id: 'ws-1' } }]; // getWorkspaceId
}
function intentEmbedRow() {
  return [{ data: { embedding: null } }]; // resolveIntentEmbedding → null (trigram-only)
}

describe('findRelatedTickets', () => {
  it('TC1: self-excludes the subject ticket', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [
          ...subjectRows(),
          // enrich query (.in) — note: subject is in the RPC results but must be dropped
          { data: [
            { id: 'cand-1', task_number: 100, title: 'Saved filter sharing', workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
          ] },
        ],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: SUBJECT_ID, content: 'self', score: 0.99 },  // self — must be excluded
          { source_task_id: 'cand-1', content: 'x', score: 0.5 },
        ], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.subject_task_id).toBe(SUBJECT_ID);
    expect(res.candidates.map((c) => c.id)).not.toContain(SUBJECT_ID);
    expect(res.candidates.map((c) => c.id)).toEqual(['cand-1']);
  });

  it('TC2: enriches + ranks; caps at limit', async () => {
    const enriched = Array.from({ length: 8 }, (_, i) => ({
      id: `cand-${i}`, task_number: 100 + i, title: `Cand ${i}`,
      workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' },
    }));
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: enriched.map((e, i) => ({ source_task_id: e.id, content: 'x', score: i / 10 })), error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID, limit: 3 });
    expect(res.candidates).toHaveLength(3);                  // capped at limit
    // all milestoned (same flag), so sort is by score DESC: cand-7, cand-6, cand-5
    expect(res.candidates[0].id).toBe('cand-7');
    expect(res.candidates[0].visual_id).toBe('B-107');       // enriched: visual id
    expect(res.candidates[0].title).toBe('Cand 7');
    expect(res.candidates[0].score).toBeGreaterThan(res.candidates[1].score);
  });

  it('TC3: sorts unmilestoned-first (flag not filter — milestoned still present)', async () => {
    const enriched = [
      { id: 'milestoned-hi', task_number: 1, title: 'Milestoned high score', workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'unmilestoned-lo', task_number: 2, title: 'Unmilestoned low score', workflow_state: 'Idea', milestone_id: null, archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'milestoned-hi', content: 'x', score: 0.9 },   // higher score
          { source_task_id: 'unmilestoned-lo', content: 'x', score: 0.1 }, // lower score
        ], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    // unmilestoned sorts FIRST despite its lower score (elevation flag)...
    expect(res.candidates[0].id).toBe('unmilestoned-lo');
    expect(res.candidates[0].unmilestoned).toBe(true);
    // ...and the milestoned one is STILL PRESENT (flag, not filter)
    expect(res.candidates.map((c) => c.id)).toContain('milestoned-hi');
    expect(res.candidates.find((c) => c.id === 'milestoned-hi')!.unmilestoned).toBe(false);
  });

  it('TC4: empty result → explicit empty "none found" shape', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows()],   // no enrich call happens (byTask empty)
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.candidates).toEqual([]);
    expect(res.degraded).toBe(false);
    expect(res.subject_task_id).toBe(SUBJECT_ID);
  });

  it('TC5 [AC6]: route 2 unavailable → graceful degrade (no throw), degraded:true', async () => {
    const enriched = [
      { id: 'lex-1', task_number: 50, title: 'Lexical-only hit', workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        // route 2 THROWS — must be swallowed, not propagated out of the gate
        search_ticket_intents: () => { throw new Error('route 2 down (522)'); },
        search_tasks: { data: [{ task_id: 'lex-1', similarity: 0.7 }], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.degraded).toBe(true);                 // marked degraded
    expect(res.candidates.map((c) => c.id)).toEqual(['lex-1']);  // route-1 results survive
    expect(res.candidates[0].routes).toEqual(['lexical']);
  });

  it('also degrades when route 2 returns an RPC error (not a throw)', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: [
          { id: 'lex-2', task_number: 51, title: 'Lex', workflow_state: null, milestone_id: 'm1', archived: false, projects: { key: 'B' } },
        ] }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: null, error: { message: 'function does not exist' } },
        search_tasks: { data: [{ task_id: 'lex-2', similarity: 0.6 }], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.degraded).toBe(true);
    expect(res.candidates.map((c) => c.id)).toEqual(['lex-2']);
  });

  it('drops archived candidates returned by retrieval', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: [
          { id: 'live', task_number: 10, title: 'Live', workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
          { id: 'gone', task_number: 11, title: 'Archived', workflow_state: 'Idea', milestone_id: 'm1', archived: true, projects: { key: 'B' } },
        ] }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'live', content: 'x', score: 0.5 },
          { source_task_id: 'gone', content: 'x', score: 0.9 },
        ], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.candidates.map((c) => c.id)).toEqual(['live']);  // archived 'gone' dropped
  });

  it('unions route 1 + route 2 and records both routes for a shared hit', async () => {
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: [
          { id: 'both', task_number: 20, title: 'Both routes', workflow_state: 'Idea', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
        ] }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [{ source_task_id: 'both', content: 'x', score: 0.4 }], error: null },
        search_tasks: { data: [{ task_id: 'both', similarity: 0.8 }], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0].routes).toEqual(['intent', 'lexical']);
    expect(res.candidates[0].score).toBe(0.8);  // max across routes
  });

  it('throws when task_id is missing/blank', async () => {
    const client = makeClient({ tableResults: {}, rpc: {} });
    await expect(findRelatedTickets(client, PROJECT_ID, { task_id: '  ' })).rejects.toThrow('task_id is required');
  });
});

describe('find_related_tickets tool schema', () => {
  it('requires task_id and exposes limit', () => {
    expect(findRelatedTicketsTool.name).toBe('find_related_tickets');
    expect(findRelatedTicketsTool.inputSchema.required).toContain('task_id');
    const props = findRelatedTicketsTool.inputSchema.properties as Record<string, unknown>;
    expect(props.task_id).toBeDefined();
    expect(props.limit).toBeDefined();
  });
});
