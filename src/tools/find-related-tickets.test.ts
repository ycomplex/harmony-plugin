import { describe, it, expect, vi } from 'vitest';
import { findRelatedTickets, findRelatedTicketsTool } from './find-related-tickets.js';
import type { SupabaseClient } from '@supabase/supabase-js';

const PROJECT_ID = 'proj-1';
const SUBJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// A tiny chainable Supabase mock. `.from(table)` returns a builder whose terminal
// (`.single`/`.maybeSingle`) or awaited result is taken from `tableResults[table]`,
// shifted FIFO so successive same-table reads can return different rows.
//
// `.rpc(name)` returns `rpc[name]`. Because `search_tasks` is now called TWICE per run
// (once with the FULL title+description query, then once with the TITLE-only query),
// an rpc entry may be an ARRAY of results, shifted FIFO per call — index 0 = the FULL
// framing, index 1 = the TITLE framing. A single (non-array) value is REUSED for every
// call of that name (so the title call sees the same list as the full call — the
// existing single-result tests still exercise both framings). A drained queue falls
// back to `{ data: null, error: null }` (contributes nothing).
type RpcResult = { data: any; error?: any } | (() => never);
function makeClient(opts: {
  tableResults: Record<string, Array<{ data: any; error?: any }>>;
  rpc: Record<string, RpcResult | RpcResult[]>;
}) {
  const rpc = vi.fn((name: string) => {
    let r = opts.rpc[name];
    if (Array.isArray(r)) {
      // FIFO queue: shift per call; once drained, contribute nothing.
      r = r.length ? r.shift()! : { data: null, error: null };
    }
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
            { id: 'cand-1', task_number: 100, title: 'Saved filter sharing', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
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
      workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' },
    }));
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        // The RPC returns rows in RANKED order (ORDER BY score DESC) — array index IS the rank.
        // cand-0 at rank 1 → highest RRF contribution, cand-7 at rank 8 → lowest.
        search_ticket_intents: { data: enriched.map((e, i) => ({ source_task_id: e.id, content: 'x', score: (8 - i) / 10 })), error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID, limit: 3 });
    expect(res.candidates).toHaveLength(3);                  // capped at limit
    // ranked-order input → RRF score DESC preserves rank: cand-0, cand-1, cand-2
    expect(res.candidates[0].id).toBe('cand-0');
    expect(res.candidates[0].visual_id).toBe('B-100');       // enriched: visual id
    expect(res.candidates[0].title).toBe('Cand 0');
    expect(res.candidates[0].score).toBeGreaterThan(res.candidates[1].score);
  });

  it('TC3 (B-563 outcome): ranks the OPEN genuine relative above a generic-vocab false-positive; excludes Cancelled + Verified (done)', async () => {
    // Models B-563's situation. Two route-surfaced "relatives": B-561 (now Verified → done
    // → EXCLUDED by B-581) and B-499 (Decomposed → OPEN → the genuine foldable relative,
    // KEPT). A generic-vocab false-positive (B-540, unmilestoned) is ranked LOW; a Cancelled
    // ticket (B-249) appears in the route results. The fold list returns only OPEN work, so
    // the only genuine relative left to rank against the false-positive is B-499.
    const enriched = [
      { id: 'b561', task_number: 561, title: 'Fix dead lexical/trigram arm', workflow_state: 'Verified', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'b499', task_number: 499, title: 'Conduct → split umbrella', workflow_state: 'Decomposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'b540', task_number: 540, title: 'Generic vocab overlap', workflow_state: 'Proposed', milestone_id: null, archived: false, projects: { key: 'B' } },
      { id: 'b249', task_number: 249, title: 'Cancelled relative', workflow_state: 'Cancelled', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        // Route 2 (intent) ranked order: relatives high, false-positive low, Cancelled present.
        search_ticket_intents: { data: [
          { source_task_id: 'b561', content: 'x', score: 0.03 },  // rank 1 (Verified — excluded)
          { source_task_id: 'b499', content: 'x', score: 0.02 },  // rank 2 (Decomposed — kept)
          { source_task_id: 'b249', content: 'x', score: 0.015 }, // rank 3 (Cancelled — excluded)
          { source_task_id: 'b540', content: 'x', score: 0.005 }, // rank 4 (generic false-pos)
        ], error: null },
        // Route 1 (lexical) reinforces both relatives (b499 must rank high enough to be in top-N).
        search_tasks: { data: [
          { task_id: 'b561', similarity: 0.9 }, // rank 1
          { task_id: 'b499', similarity: 0.7 }, // rank 2
        ], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    const ids = res.candidates.map((c) => c.id);
    // Verified relative excluded — done, not foldable (B-581 reversed B-574's keep-terminal)...
    expect(ids).not.toContain('b561');
    // ...the OPEN genuine relative is kept...
    expect(ids).toContain('b499');
    // ...Cancelled excluded...
    expect(ids).not.toContain('b249');
    // ...and the generic-vocab false-positive ranks BELOW the kept OPEN relative.
    expect(ids.indexOf('b540')).toBeGreaterThan(ids.indexOf('b499'));
  });

  it('TC3b (RRF fusion): a both-routes hit outranks an equal-rank single-route hit; no Math.max dominance', async () => {
    // 'both' is surfaced at rank 1 by route 2 AND by both route-1 framings (full + title);
    // 'one' only by route 2 at rank 2. RRF (K=10): both outranks one purely from
    // cross-route reinforcement. Separately, a high-`similarity` route-1-only task
    // ('lex-hi') is surfaced at rank 2 lexically, so its huge raw similarity (0.99) does
    // NOT let it dominate (no Math.max behavior). The single search_tasks value is reused
    // for BOTH framings, so route-1 contributes TWICE here (full + title).
    const enriched = [
      { id: 'both', task_number: 1, title: 'Both routes #1', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'one', task_number: 2, title: 'Route-2 only #1', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'lex-hi', task_number: 3, title: 'Route-1 only, huge similarity', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'both', content: 'x', score: 0.03 }, // rank 1
          { source_task_id: 'one', content: 'x', score: 0.02 },  // rank 2 overall
        ], error: null },
        // single value → reused for the full AND title framings (route 1 fires twice).
        search_tasks: { data: [
          { task_id: 'both', similarity: 0.5 },   // rank 1
          { task_id: 'lex-hi', similarity: 0.99 },  // rank 2 — huge raw value, but only rank 2
        ], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    const ids = res.candidates.map((c) => c.id);
    // both-routes hit outranks the single-route hits.
    expect(ids[0]).toBe('both');
    expect(res.candidates.find((c) => c.id === 'both')!.routes).toEqual(['intent', 'lexical']);
    // 'both': intent rank1 + lexical(full) rank1 + lexical(title) rank1 = 3 * 1/(10+1).
    expect(res.candidates.find((c) => c.id === 'both')!.score).toBeCloseTo(3 * (1 / 11), 10);
    // 'one': route 2 only, rank 2 = 1/(10+2).
    expect(res.candidates.find((c) => c.id === 'one')!.score).toBeCloseTo(1 / 12, 10);
    // the huge-similarity route-1-only task does NOT dominate (no Math.max): it sits below 'both'.
    expect(ids.indexOf('lex-hi')).toBeGreaterThan(ids.indexOf('both'));
    const lexHi = res.candidates.find((c) => c.id === 'lex-hi')!;
    // 'lex-hi': lexical(full) rank2 + lexical(title) rank2 = 2 * 1/(10+2) — NOT 0.99 (no max).
    expect(lexHi.score).toBeCloseTo(2 * (1 / 12), 10);
  });

  it('TC3e (multi-query fusion): a TITLE-only hit surfaces (recall); a multi-list hit outranks a single-list hit; no Math.max dominance', async () => {
    // THREE distinct ranked lists — route-1 FULL framing, route-1 TITLE framing, route-2
    // intent — fused by RRF (K=10). This is the whole point of the multi-query change
    // (single-query buried B-563's sibling B-551 at #14). The FIFO array gives the full
    // and title search_tasks calls DIFFERENT results.
    //   route-1 FULL  : [multi@1, lexhi@2]        (lexhi has huge raw similarity 0.99)
    //   route-1 TITLE : [titleonly@1, multi@2]    (titleonly appears in NO other list)
    //   route-2 intent: [multi@1, soloIntent@2]
    const enriched = [
      { id: 'multi', task_number: 1, title: 'In every list', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'titleonly', task_number: 2, title: 'Only the title framing finds me', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'soloIntent', task_number: 3, title: 'Only intent finds me', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'lexhi', task_number: 4, title: 'Only full framing, huge similarity', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'multi', content: 'x', score: 0.03 },      // rank 1
          { source_task_id: 'soloIntent', content: 'x', score: 0.02 }, // rank 2
        ], error: null },
        // FIFO: first call = FULL framing, second call = TITLE framing (DIFFERENT lists).
        search_tasks: [
          { data: [
            { task_id: 'multi', similarity: 0.5 },   // full rank 1
            { task_id: 'lexhi', similarity: 0.99 },  // full rank 2 — huge raw value, only this list
          ], error: null },
          { data: [
            { task_id: 'titleonly', similarity: 0.6 }, // title rank 1 — in NO other list (recall!)
            { task_id: 'multi', similarity: 0.4 },     // title rank 2
          ], error: null },
        ],
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    const ids = res.candidates.map((c) => c.id);

    // (a) RECALL: the title-only hit surfaces at all — the single-query framing missed it.
    expect(ids).toContain('titleonly');

    // (b) a multi-list hit outranks a single-list hit at the same per-list rank: 'multi'
    //     (intent r1 + full r1 + title r2 = 2/11 + 1/12) beats 'titleonly' (title r1 = 1/11).
    const score = (id: string) => res.candidates.find((c) => c.id === id)!.score;
    expect(score('multi')).toBeCloseTo(2 * (1 / 11) + 1 / 12, 10);
    expect(score('titleonly')).toBeCloseTo(1 / 11, 10);
    expect(score('multi')).toBeGreaterThan(score('titleonly'));
    expect(ids[0]).toBe('multi');
    expect(res.candidates.find((c) => c.id === 'multi')!.routes).toEqual(['intent', 'lexical']);

    // (c) no Math.max: the single-list rank-2 hit with a 0.99 raw similarity does NOT
    //     dominate — its RRF score is just 1/(10+2), well below 'multi'.
    expect(score('lexhi')).toBeCloseTo(1 / 12, 10);
    expect(ids.indexOf('lexhi')).toBeGreaterThan(ids.indexOf('multi'));
  });

  it('TC3c (no reorder): an unmilestoned LOW-relevance candidate ranks BELOW a milestoned HIGH-relevance candidate', async () => {
    // The inverse of the deleted "unmilestoned-first" test: relevance order is authoritative,
    // the unmilestoned flag is carried for badging only — never reordered.
    const enriched = [
      { id: 'milestoned-hi', task_number: 1, title: 'Milestoned high relevance', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'unmilestoned-lo', task_number: 2, title: 'Unmilestoned low relevance', workflow_state: 'Proposed', milestone_id: null, archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'milestoned-hi', content: 'x', score: 0.9 },   // rank 1 (high relevance)
          { source_task_id: 'unmilestoned-lo', content: 'x', score: 0.1 }, // rank 2 (low relevance)
        ], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    // milestoned high-relevance ranks FIRST; unmilestoned low-relevance is NOT elevated.
    expect(res.candidates[0].id).toBe('milestoned-hi');
    expect(res.candidates[1].id).toBe('unmilestoned-lo');
    // the unmilestoned flag is still carried (for the renderer to badge), just not reordered.
    expect(res.candidates.find((c) => c.id === 'unmilestoned-lo')!.unmilestoned).toBe(true);
    expect(res.candidates.find((c) => c.id === 'milestoned-hi')!.unmilestoned).toBe(false);
  });

  it('TC3d (terminal+done exclusion): drops Cancelled + Parked + Verified + Deployed; keeps OPEN candidates', async () => {
    // B-581: every NON-FOLDABLE state is excluded — terminal-dead (Cancelled / Parked)
    // AND done (Verified / Deployed). Only OPEN / foldable candidates survive. An OPEN
    // candidate of comparable relevance ('open') proves the filter drops by state, not by
    // relevance.
    const enriched = [
      { id: 'verified', task_number: 10, title: 'Already delivered', workflow_state: 'Verified', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'deployed', task_number: 11, title: 'Shipped', workflow_state: 'Deployed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'cancelled', task_number: 12, title: 'Cancelled', workflow_state: 'Cancelled', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'parked', task_number: 13, title: 'Parked', workflow_state: 'Parked', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
      { id: 'open', task_number: 14, title: 'Open foldable relative', workflow_state: 'Decomposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
    ];
    const client = makeClient({
      tableResults: {
        tasks: [...subjectRows(), { data: enriched }],
        projects: projectRows(),
        knowledge_decisions: intentEmbedRow(),
      },
      rpc: {
        search_ticket_intents: { data: [
          { source_task_id: 'verified', content: 'x', score: 0.4 },
          { source_task_id: 'deployed', content: 'x', score: 0.35 },
          { source_task_id: 'open', content: 'x', score: 0.3 },     // OPEN, comparable relevance
          { source_task_id: 'cancelled', content: 'x', score: 0.2 },
          { source_task_id: 'parked', content: 'x', score: 0.1 },
        ], error: null },
        search_tasks: { data: [], error: null },
      },
    });
    const res = await findRelatedTickets(client, PROJECT_ID, { task_id: SUBJECT_ID });
    const ids = res.candidates.map((c) => c.id);
    expect(ids).not.toContain('verified');  // dropped — done (B-581)
    expect(ids).not.toContain('deployed');  // dropped — done (B-581)
    expect(ids).not.toContain('cancelled'); // dropped — terminal dead
    expect(ids).not.toContain('parked');    // dropped — terminal dead
    expect(ids).toContain('open');          // OPEN candidate of comparable relevance is kept
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
      { id: 'lex-1', task_number: 50, title: 'Lexical-only hit', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
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
          { id: 'live', task_number: 10, title: 'Live', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
          { id: 'gone', task_number: 11, title: 'Archived', workflow_state: 'Proposed', milestone_id: 'm1', archived: true, projects: { key: 'B' } },
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
          { id: 'both', task_number: 20, title: 'Both routes', workflow_state: 'Proposed', milestone_id: 'm1', archived: false, projects: { key: 'B' } },
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
    // RRF (K=10): surfaced #1 by route 2 AND by both route-1 framings (full + title — the
    // single search_tasks value is reused for both calls) → SUM of three 1/(K+rank)
    // contributions = 3 * (1/11), NOT a Math.max of the raw scores (0.4 vs 0.8).
    expect(res.candidates[0].score).toBeCloseTo(3 * (1 / 11), 10);
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
