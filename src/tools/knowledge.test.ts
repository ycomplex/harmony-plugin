import { describe, it, expect, vi } from 'vitest';
import {
  queryKnowledge,
  searchTicketIntents,
  searchTicketIntentsTool,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  supersedeKnowledgeEntry,
  resolveOrCreateEntity,
  queryEntities,
  createEntity,
  createEntityTool,
  updateEntity,
  updateEntityTool,
  reconcileEntity,
  reconcileEntityTool,
  recordDecision,
  recordDecisionTool,
  supersedeDecision,
  supersedeDecisionTool,
  assertFact,
  invalidateFact,
  queryFacts,
} from './knowledge.js';

const PROJECT_ID = 'proj-abc-123';
const WORKSPACE_ID = 'ws-xyz-456';
const USER_ID = 'user-abc-123';

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleWorkspaceRow = { workspace_id: WORKSPACE_ID };

const sampleSummaries = [
  {
    id: 'ke-1',
    title: 'Use TypeScript strict mode',
    type: 'convention',
    status: 'Accepted',
    domain: ['engineering'],
    tags: ['typescript'],
    project_id: PROJECT_ID,
    updated_at: '2026-03-10T00:00:00Z',
  },
  {
    id: 'ke-2',
    title: 'PostgreSQL for all persistence',
    type: 'architecture',
    status: 'Accepted',
    domain: ['data'],
    tags: ['database'],
    project_id: PROJECT_ID,
    updated_at: '2026-03-12T00:00:00Z',
  },
];

const sampleFullEntry = {
  id: 'ke-1',
  workspace_id: WORKSPACE_ID,
  project_id: PROJECT_ID,
  title: 'Use TypeScript strict mode',
  content: 'We use TypeScript strict mode across all projects.',
  type: 'convention',
  status: 'Accepted',
  superseded_by: null,
  tags: ['typescript'],
  source_task_id: null,
  created_by: USER_ID,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-10T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Helper: build a client that first resolves getWorkspaceId, then a query
// ---------------------------------------------------------------------------

/**
 * Builds a mock where:
 *   - first .from('projects')... .single() → workspace row
 *   - second .from('workspace_knowledge')... → resolved by secondChain
 */
function buildWorkspaceAndQueryClient(secondResponse: { data: any; error?: any }) {
  let fromCallCount = 0;

  const wsChain: any = {};
  wsChain.select = vi.fn().mockReturnValue(wsChain);
  wsChain.eq = vi.fn().mockReturnValue(wsChain);
  wsChain.single = vi.fn().mockResolvedValue({ data: sampleWorkspaceRow, error: null });

  const secondChain: any = {};
  secondChain.select = vi.fn().mockReturnValue(secondChain);
  secondChain.insert = vi.fn().mockReturnValue(secondChain);
  secondChain.update = vi.fn().mockReturnValue(secondChain);
  secondChain.eq = vi.fn().mockReturnValue(secondChain);
  secondChain.contains = vi.fn().mockReturnValue(secondChain);
  secondChain.overlaps = vi.fn().mockReturnValue(secondChain);
  secondChain.lte = vi.fn().mockReturnValue(secondChain);
  secondChain.or = vi.fn().mockReturnValue(secondChain);
  secondChain.order = vi.fn().mockReturnValue(secondChain);
  secondChain.range = vi
    .fn()
    .mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null });
  secondChain.single = vi
    .fn()
    .mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null });
  secondChain.maybeSingle = vi.fn().mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null });
  secondChain.ilike = vi.fn().mockReturnValue(secondChain);
  secondChain.is = vi.fn().mockReturnValue(secondChain);
  secondChain.gte = vi.fn().mockReturnValue(secondChain);
  secondChain.not = vi.fn().mockReturnValue(secondChain);

  const client: any = {
    from: vi.fn().mockImplementation(() => {
      fromCallCount++;
      return fromCallCount === 1 ? wsChain : secondChain;
    }),
    // B-995: the governed knowledge writes now issue a client.rpc(...) call instead of (or as well
    // as) a `.from().insert()/.update()` chain — mirror the same canned {data, error} response so
    // existing single-response test setups keep working whichever surface the handler under test
    // now uses.
    rpc: vi.fn().mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null }),
  };

  return { client, wsChain, secondChain };
}

/**
 * Mock that routes client.from(table) by NAME (not call-order), and mocks
 * functions.invoke for embedText. viewResult/baseResult may be a single
 * {data,error} or an ARRAY consumed in sequence by successive .single() calls
 * (for multi-step flows like supersedeKnowledgeEntry). Note the embedding write
 * in embedDecisionById never calls .single(), so it never consumes the base
 * queue. embedding:null makes the edge fn return an error (embedText → null),
 * exercising the best-effort path.
 */
function buildEmbedAwareClient(opts: {
  viewResult?: { data: any; error?: any } | Array<{ data: any; error?: any }>;
  baseResult?: { data: any; error?: any } | Array<{ data: any; error?: any }>;
  embedding?: number[] | null;
  // B-995: the RPC-backed writes (updateKnowledgeEntry, supersedeKnowledgeEntry) issue exactly ONE
  // client.rpc(...) call for their governed write — this is that call's canned response. The
  // embedding follow-up write (embedDecisionById) still targets the base chain directly, unchanged.
  rpcResult?: { data: any; error?: any };
}) {
  const wsChain: any = {};
  wsChain.select = vi.fn().mockReturnValue(wsChain);
  wsChain.eq = vi.fn().mockReturnValue(wsChain);
  wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });

  function queuedChain(result?: { data: any; error?: any } | Array<{ data: any; error?: any }>) {
    const queue = result === undefined ? [{ data: null }] : Array.isArray(result) ? [...result] : [result];
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockImplementation(() => {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return Promise.resolve({ data: next.data, error: next.error ?? null });
    });
    return chain;
  }

  const viewChain = queuedChain(opts.viewResult);
  const baseChain = queuedChain(opts.baseResult);
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcResult ? { data: opts.rpcResult.data, error: opts.rpcResult.error ?? null } : { data: null, error: null },
  );

  const client: any = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'projects') return wsChain;
      if (table === 'knowledge_decisions') return baseChain;
      return viewChain; // workspace_knowledge
    }),
    rpc,
    functions: {
      invoke: vi.fn().mockResolvedValue(
        opts.embedding === null
          ? { data: null, error: { message: 'down' } }
          : { data: { embedding: opts.embedding ?? [0.1, 0.2] }, error: null },
      ),
    },
  };
  return { client, wsChain, viewChain, baseChain };
}

// ---------------------------------------------------------------------------
// queryKnowledge
// ---------------------------------------------------------------------------

describe('queryKnowledge', () => {
  it('applies default filters (status=accepted, no type/tags) and scopes to token project', async () => {
    const { client, wsChain, secondChain } = buildWorkspaceAndQueryClient({
      data: sampleSummaries,
    });

    const result = await queryKnowledge(client, PROJECT_ID, {});

    // workspace lookup
    expect(client.from).toHaveBeenNthCalledWith(1, 'projects');
    expect(wsChain.select).toHaveBeenCalledWith('workspace_id');
    expect(wsChain.eq).toHaveBeenCalledWith('id', PROJECT_ID);

    // knowledge query — must filter on both workspace_id AND project_id
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('status', 'Accepted');
    expect(secondChain.order).toHaveBeenCalledWith('type', { ascending: true });
    expect(result).toEqual(sampleSummaries);
  });

  it('applies type filter when provided', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [sampleSummaries[1]] });
    await queryKnowledge(client, PROJECT_ID, { type: 'architecture' });
    expect(secondChain.eq).toHaveBeenCalledWith('type', 'architecture');
  });

  it('applies explicit status filter overriding default', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { status: 'draft' });
    expect(secondChain.eq).toHaveBeenCalledWith('status', 'draft');
  });

  it('skips status filter when include_superseded=true and no status', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { include_superseded: true });
    const eqCalls = secondChain.eq.mock.calls.map((c: any[]) => c[0]);
    expect(eqCalls).not.toContain('status');
  });

  it('applies tags filter via .contains()', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { tags: ['typescript'] });
    expect(secondChain.contains).toHaveBeenCalledWith('tags', ['typescript']);
  });

  it('never ORs project_id with null (no workspace-wide leak)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, {});
    // .or() should not have been called with any project_id.is.null pattern
    for (const call of secondChain.or.mock.calls) {
      expect(call[0]).not.toContain('project_id.is.null');
    }
  });

  it('uses the RRF rpc path when a search query is given (semantic)', async () => {
    const wsChain: any = {};
    wsChain.select = vi.fn().mockReturnValue(wsChain);
    wsChain.eq = vi.fn().mockReturnValue(wsChain);
    wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const client: any = {
      from: vi.fn().mockReturnValue(wsChain),
      functions: { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.1, 0.2] }, error: null }) },
      rpc: vi.fn().mockResolvedValue({
        data: [{ id: 'd1', title: 'auth', type: 'architecture', status: 'Accepted', domain: ['engineering'], tags: [], project_id: PROJECT_ID, updated_at: '2026-05-29T00:00:00Z' }],
        error: null,
      }),
    };
    const result = await queryKnowledge(client, PROJECT_ID, { search: 'session security', domain: ['engineering'] });
    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'session security' } });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_search_rrf', expect.objectContaining({
      _workspace_id: WORKSPACE_ID, _project_id: PROJECT_ID, _query_embedding: '[0.1,0.2]',
      _query_text: 'session security', _domain: ['engineering'],
      _match_limit: 50,
    }));
    const rpcArg = client.rpc.mock.calls[0][1];
    expect(rpcArg).not.toHaveProperty('_k');
    expect(result[0]).toMatchObject({ id: 'd1', title: 'auth', type: 'architecture', status: 'Accepted', domain: ['engineering'] });
  });

  it('rejects search combined with un-honorable filters (no silent drop)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: [] });
    await expect(
      queryKnowledge(client, PROJECT_ID, { search: 'auth', include_superseded: true }),
    ).rejects.toThrow(/cannot be combined with/);
    await expect(
      queryKnowledge(client, PROJECT_ID, { search: 'auth', type: 'architecture' }),
    ).rejects.toThrow(/type/);
  });

  it('allows search combined with domain + limit', async () => {
    const wsChain: any = {};
    wsChain.select = vi.fn().mockReturnValue(wsChain);
    wsChain.eq = vi.fn().mockReturnValue(wsChain);
    wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const client: any = {
      from: vi.fn().mockReturnValue(wsChain),
      functions: { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.1, 0.2] }, error: null }) },
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    await queryKnowledge(client, PROJECT_ID, { search: 'auth', domain: ['engineering'], limit: 5 });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_search_rrf', expect.objectContaining({ _match_limit: 5, _domain: ['engineering'] }));
  });

  it('passes _query_embedding null when embedding fails (trigram-only degrade)', async () => {
    const wsChain: any = {};
    wsChain.select = vi.fn().mockReturnValue(wsChain);
    wsChain.eq = vi.fn().mockReturnValue(wsChain);
    wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const client: any = {
      from: vi.fn().mockReturnValue(wsChain),
      functions: { invoke: vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } }) },
      rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    await queryKnowledge(client, PROJECT_ID, { search: 'auth' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_search_rrf', expect.objectContaining({ _query_embedding: null, _query_text: 'auth', _domain: null }));
  });

  it('passes limit and offset to .range()', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { limit: 10, offset: 20 });
    expect(secondChain.range).toHaveBeenCalledWith(20, 29);
  });

  it('uses default limit=50 offset=0', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, {});
    expect(secondChain.range).toHaveBeenCalledWith(0, 49);
  });

  it('throws when workspace lookup fails', async () => {
    const wsChain: any = {};
    wsChain.select = vi.fn().mockReturnValue(wsChain);
    wsChain.eq = vi.fn().mockReturnValue(wsChain);
    wsChain.single = vi.fn().mockResolvedValue({ data: null, error: { message: 'not found' } });
    const client: any = { from: vi.fn().mockReturnValue(wsChain) };

    await expect(queryKnowledge(client, PROJECT_ID, {})).rejects.toThrow(
      'Could not resolve workspace: not found',
    );
  });

  it('queries knowledge_decisions and filters by domain via .overlaps()', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { domain: ['data'] });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.overlaps).toHaveBeenCalledWith('domain', ['data']);
  });

  it('defaults status to Accepted (v1 vocab)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, {});
    expect(secondChain.eq).toHaveBeenCalledWith('status', 'Accepted');
  });

  it('applies as_of temporal filter (valid_from <= as_of)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { as_of: '2026-01-01T00:00:00Z' });
    expect(secondChain.lte).toHaveBeenCalledWith('valid_from', '2026-01-01T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// searchTicketIntents (B-551 Phase 2 — intent-only retrieval surface)
// ---------------------------------------------------------------------------

// Build a client whose .from('projects') resolves the workspace, a functions.invoke for
// embedText, and an .rpc() stub for search_ticket_intents.
function buildIntentSearchClient(opts: {
  rpcData?: any;
  rpcError?: any;
  embedding?: number[] | null;
}) {
  const wsChain: any = {};
  wsChain.select = vi.fn().mockReturnValue(wsChain);
  wsChain.eq = vi.fn().mockReturnValue(wsChain);
  wsChain.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
  const client: any = {
    from: vi.fn().mockReturnValue(wsChain),
    functions: {
      invoke: vi.fn().mockResolvedValue(
        opts.embedding === null
          ? { data: null, error: { message: 'down' } }
          : { data: { embedding: opts.embedding ?? [0.1, 0.2] }, error: null },
      ),
    },
    rpc: vi.fn().mockResolvedValue({ data: opts.rpcData ?? [], error: opts.rpcError ?? null }),
  };
  return { client, wsChain };
}

describe('searchTicketIntents', () => {
  const sampleIntentRows = [
    { id: 'kd-intent-1', source_task_id: 'task-aaa', content: 'Add dark mode toggle\n\nUsers want a dark theme', score: 0.0333 },
    { id: 'kd-intent-2', source_task_id: 'task-bbb', content: 'Theme switcher in settings\n\nLight/dark', score: 0.0163 },
  ];

  it('calls the search_ticket_intents RPC and maps source_task_id + content + score', async () => {
    const { client } = buildIntentSearchClient({ rpcData: sampleIntentRows });
    const result = await searchTicketIntents(client, PROJECT_ID, { query: 'dark theme' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'dark theme' } });
    expect(client.rpc).toHaveBeenCalledWith('search_ticket_intents', expect.objectContaining({
      _workspace_id: WORKSPACE_ID,
      _project_id: PROJECT_ID,
      _query_embedding: '[0.1,0.2]',
      _query_text: 'dark theme',
      _match_limit: 50,
    }));
    expect(result).toEqual([
      { id: 'kd-intent-1', source_task_id: 'task-aaa', content: 'Add dark mode toggle\n\nUsers want a dark theme', score: 0.0333 },
      { id: 'kd-intent-2', source_task_id: 'task-bbb', content: 'Theme switcher in settings\n\nLight/dark', score: 0.0163 },
    ]);
  });

  it('passes the caller limit through as _match_limit', async () => {
    const { client } = buildIntentSearchClient({ rpcData: [] });
    await searchTicketIntents(client, PROJECT_ID, { query: 'export', limit: 5 });
    expect(client.rpc).toHaveBeenCalledWith('search_ticket_intents', expect.objectContaining({ _match_limit: 5 }));
  });

  it('degrades to trigram-only (null embedding) when the embed fn is down', async () => {
    const { client } = buildIntentSearchClient({ rpcData: [], embedding: null });
    await searchTicketIntents(client, PROJECT_ID, { query: 'webhook retry' });
    expect(client.rpc).toHaveBeenCalledWith('search_ticket_intents', expect.objectContaining({
      _query_embedding: null,
      _query_text: 'webhook retry',
    }));
  });

  it('does NOT pass a status / type / domain arg (intent-only, status-agnostic by design)', async () => {
    const { client } = buildIntentSearchClient({ rpcData: [] });
    await searchTicketIntents(client, PROJECT_ID, { query: 'anything' });
    const rpcArg = client.rpc.mock.calls[0][1];
    expect(rpcArg).not.toHaveProperty('_domain');
    expect(rpcArg).not.toHaveProperty('_status');
    expect(rpcArg).not.toHaveProperty('_type');
  });

  it('requires a non-empty query', async () => {
    const { client } = buildIntentSearchClient({ rpcData: [] });
    await expect(searchTicketIntents(client, PROJECT_ID, { query: '   ' })).rejects.toThrow('query is required');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('surfaces an RPC error', async () => {
    const { client } = buildIntentSearchClient({ rpcData: null, rpcError: { message: 'boom' } });
    await expect(searchTicketIntents(client, PROJECT_ID, { query: 'dark' })).rejects.toThrow('boom');
  });

  it('returns [] when the RPC yields no matches', async () => {
    const { client } = buildIntentSearchClient({ rpcData: [] });
    const result = await searchTicketIntents(client, PROJECT_ID, { query: 'nothing matches' });
    expect(result).toEqual([]);
  });

  it('exposes a tool definition with query required and a limit param', () => {
    expect(searchTicketIntentsTool.name).toBe('search_ticket_intents');
    expect(searchTicketIntentsTool.inputSchema.required).toEqual(['query']);
    expect(searchTicketIntentsTool.inputSchema.properties).toHaveProperty('query');
    expect(searchTicketIntentsTool.inputSchema.properties).toHaveProperty('limit');
  });
});

// ---------------------------------------------------------------------------
// getKnowledgeEntry
// ---------------------------------------------------------------------------

describe('getKnowledgeEntry', () => {
  it('retrieves entry by entry_id scoped to token project', async () => {
    const { client, wsChain, secondChain } = buildWorkspaceAndQueryClient({
      data: sampleFullEntry,
    });

    const result = await getKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1' });

    expect(client.from).toHaveBeenNthCalledWith(1, 'projects');
    expect(wsChain.eq).toHaveBeenCalledWith('id', PROJECT_ID);
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('id', 'ke-1');
    expect(result).toEqual(sampleFullEntry);
  });

  it('reads the base table, so next-gen-typed entries are retrievable (B-418)', async () => {
    // The workspace_knowledge compat view filters to the legacy four types, so a
    // technical-design row is invisible there → .single() "Cannot coerce" error.
    const nextGenEntry = { ...sampleFullEntry, id: 'ke-ng', type: 'technical-design' };
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: nextGenEntry });

    const result = await getKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-ng' });

    expect(client.from).not.toHaveBeenCalledWith('workspace_knowledge');
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.eq).toHaveBeenCalledWith('id', 'ke-ng');
    expect(result).toEqual(nextGenEntry);
  });

  it('retrieves entry by title scoped to token project', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: sampleFullEntry });
    await getKnowledgeEntry(client, PROJECT_ID, { title: 'Use TypeScript strict mode' });
    expect(secondChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('title', 'Use TypeScript strict mode');
  });

  it('prefers entry_id over title when both provided', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: sampleFullEntry });
    await getKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', title: 'anything' });
    const eqCalls = secondChain.eq.mock.calls.map((c: any[]) => c[1]);
    expect(eqCalls).toContain('ke-1');
    expect(eqCalls).not.toContain('anything');
  });

  it('throws when neither entry_id nor title provided', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(getKnowledgeEntry(client, PROJECT_ID, {})).rejects.toThrow(
      'Either entry_id or title must be provided',
    );
  });

  it('throws on Supabase error (e.g. sibling-project entry returns no rows)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null, error: { message: 'Not found' } });
    await expect(getKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-999' })).rejects.toThrow(
      'Not found',
    );
  });
});

// ---------------------------------------------------------------------------
// createKnowledgeEntry
// ---------------------------------------------------------------------------

describe('createKnowledgeEntry', () => {
  const newEntry = {
    id: 'ke-new',
    workspace_id: WORKSPACE_ID,
    project_id: PROJECT_ID,
    title: 'New Convention',
    content: 'Always use const for variables.',
    type: 'convention',
    status: 'draft',
    superseded_by: null,
    tags: [],
    source_task_id: null,
    created_by: USER_ID,
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-01T00:00:00Z',
  };

  it('stamps project_id from the token even when arg is omitted', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: newEntry });

    const result = await createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      title: 'New Convention',
      content: 'Always use const for variables.',
      type: 'convention',
    });

    expect(client.from).toHaveBeenNthCalledWith(2, 'workspace_knowledge');
    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        workspace_id: WORKSPACE_ID,
        project_id: PROJECT_ID,
        title: 'New Convention',
        content: 'Always use const for variables.',
        type: 'convention',
        status: 'draft',
        created_by: USER_ID,
      }),
    );
    expect(result).toEqual(newEntry);
  });

  it('passes specification as a valid type through to insert', async () => {
    const specEntry = { ...newEntry, type: 'specification' };
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: specEntry });

    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      title: 'Spec doc',
      content: 'Design for feature X',
      type: 'specification',
    });

    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'specification',
        project_id: PROJECT_ID,
      }),
    );
  });

  it('accepts optional fields: status, tags, source_task_id', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: newEntry });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      title: 'New Convention',
      content: 'content',
      type: 'convention',
      status: 'accepted',
      tags: ['tag1'],
      source_task_id: 'task-1',
    });

    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: PROJECT_ID,
        status: 'accepted',
        tags: ['tag1'],
        source_task_id: 'task-1',
      }),
    );
  });

  it('trims whitespace from title', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: newEntry });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      title: '  New Convention  ',
      content: 'content',
      type: 'convention',
    });
    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New Convention' }),
    );
  });

  it('throws when title is empty', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
        title: '   ',
        content: 'x',
        type: 'convention',
      }),
    ).rejects.toThrow('title is required');
  });

  it('throws friendly message on duplicate title', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: null,
      error: { code: '23505', message: 'unique violation' },
    });
    await expect(
      createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
        title: 'Existing',
        content: 'x',
        type: 'convention',
      }),
    ).rejects.toThrow('A knowledge entry titled "Existing" already exists in this project');
  });

  it('throws on other Supabase errors', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: null,
      error: { message: 'DB failure' },
    });
    await expect(
      createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
        title: 'Test',
        content: 'x',
        type: 'convention',
      }),
    ).rejects.toThrow('DB failure');
  });

  it('embeds on insert via the base table (sibling of B-401)', async () => {
    const created = { ...sampleFullEntry, id: 'ke-new', title: 'Brand new', content: 'body' };
    const { client, baseChain } = buildEmbedAwareClient({ viewResult: { data: created } });

    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'Brand new', content: 'body', type: 'convention' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'Brand new\nbody' } });
    expect(client.from).toHaveBeenCalledWith('knowledge_decisions');
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
    expect(baseChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(baseChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-new');
  });

  it('returns the created entry even when embedding fails (best-effort)', async () => {
    const created = { ...sampleFullEntry, id: 'ke-new' };
    const { client, baseChain } = buildEmbedAwareClient({
      viewResult: { data: created },
      baseResult: { data: created },   // authoritative re-read now hits the base table
      embedding: null,
    });

    const result = await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });

    expect(result).toEqual(created);
    expect(baseChain.update).not.toHaveBeenCalled(); // null embedding → no base write
  });

  it('normalizes v1-capitalized status to legacy vocab on insert (B-415 sibling)', async () => {
    const created = { ...sampleFullEntry, id: 'ke-new', status: 'accepted' };
    const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: created } });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention', status: 'Accepted' });
    expect(viewChain.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
  });

  it('maps v1 Asserted to legacy draft on insert', async () => {
    const created = { ...sampleFullEntry, id: 'ke-new', status: 'draft' };
    const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: created } });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention', status: 'Asserted' });
    expect(viewChain.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('rejects an unrecognized status on create', async () => {
    const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: sampleFullEntry } });
    await expect(
      createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention', status: 'bogus' }),
    ).rejects.toThrow(/Unsupported status/);
    expect(viewChain.insert).not.toHaveBeenCalled();
  });

  it('defaults to draft when no status is given (unchanged)', async () => {
    const created = { ...sampleFullEntry, id: 'ke-new' };
    const { client, viewChain } = buildEmbedAwareClient({ viewResult: { data: created } });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });
    expect(viewChain.insert).toHaveBeenCalledWith(expect.objectContaining({ status: 'draft' }));
  });

  it('create returns the authoritative persisted row (re-read from the base table)', async () => {
    const echoed    = { ...sampleFullEntry, id: 'ke-new', status: 'accepted' };                           // view insert echo
    const persisted = { ...sampleFullEntry, id: 'ke-new', status: 'Accepted', title: 'persisted title' }; // base re-read
    const { client } = buildEmbedAwareClient({ viewResult: { data: echoed }, baseResult: { data: persisted } });
    const result = await createKnowledgeEntry(client, PROJECT_ID, USER_ID, { title: 'x', content: 'y', type: 'convention' });
    expect(result.title).toBe('persisted title');
    expect(result.status).toBe('Accepted');   // base-table (v1) vocab, not the view echo
  });
});

// ---------------------------------------------------------------------------
// updateKnowledgeEntry
// ---------------------------------------------------------------------------

describe('updateKnowledgeEntry', () => {
  const updatedEntry = {
    ...sampleFullEntry,
    title: 'Updated Title',
    updated_at: '2026-04-01T00:00:00Z',
  };

  it('updates by entry_id and scopes to token project (via knowledge_update_knowledge_entry RPC)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    const result = await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1',
      new_title: 'Updated Title',
    });

    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_project_id: PROJECT_ID, p_entry_id: 'ke-1', p_new_title: 'Updated Title',
    }));
    expect(result).toEqual(updatedEntry);
  });

  it('updates a next-gen-typed entry (B-418 — the RPC hits the base table for every type, not just the legacy four)', async () => {
    const nextGen = { ...sampleFullEntry, id: 'ke-ng', type: 'technical-design', tags: ['layer3-nextgen'] };
    const { client } = buildEmbedAwareClient({ rpcResult: { data: nextGen } });

    const result = await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-ng', tags: ['layer3-nextgen'] });

    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_entry_id: 'ke-ng', p_tags: ['layer3-nextgen'],
    }));
    expect(result).toEqual(nextGen);
  });

  it('updates by title scoped to token project', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      title: 'Use TypeScript strict mode',
      content: 'new content',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_project_id: PROJECT_ID, p_title: 'Use TypeScript strict mode', p_content: 'new content',
    }));
  });

  it('can update content, type, status, and tags (status normalized to base vocab)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1',
      content: 'new content',
      type: 'business',
      status: 'accepted',
      tags: ['new-tag'],
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_content: 'new content',
      p_type: 'business',
      p_status: 'Accepted',   // base table speaks v1 vocab; legacy lowercase is normalized up
      p_tags: ['new-tag'],
    }));
  });

  it('throws when neither entry_id nor title provided', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { content: 'x' }),
    ).rejects.toThrow('Either entry_id or title must be provided');
  });

  it('throws when no update fields provided', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1' }),
    ).rejects.toThrow('At least one field to update must be provided');
  });

  it('throws friendly message on duplicate title', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: null,
      error: { code: '23505', message: 'unique violation' },
    });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'Taken' }),
    ).rejects.toThrow('A knowledge entry titled "Taken" already exists in this project');
  });

  it('throws on other Supabase errors', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: null,
      error: { message: 'DB failure' },
    });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', content: 'x' }),
    ).rejects.toThrow('DB failure');
  });

  it('re-embeds via the base table when content changes (B-401)', async () => {
    const updated = { ...sampleFullEntry, status: 'Accepted', content: 'NEW why-rich content' };
    const { client, baseChain } = buildEmbedAwareClient({ rpcResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', content: 'NEW why-rich content', status: 'accepted' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `${updated.title}\nNEW why-rich content` } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-1');
  });

  it('re-embeds when the title changes', async () => {
    // content is unchanged — the re-embed must still fire because the title changed
    const updated = { ...sampleFullEntry, title: 'Renamed title' };
    const { client, baseChain } = buildEmbedAwareClient({ rpcResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'Renamed title' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `Renamed title\n${sampleFullEntry.content}` } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
  });

  it('does NOT re-embed when only status changes (no wasted embed call)', async () => {
    const updated = { ...sampleFullEntry, status: 'Accepted' };
    const { client, baseChain } = buildEmbedAwareClient({ rpcResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'accepted' });

    expect(client.functions.invoke).not.toHaveBeenCalled();            // no embed
    expect(baseChain.update).not.toHaveBeenCalled();                   // no embedding write at all
  });

  it('normalizes legacy lowercase status to the v1 vocab the base table expects (B-418)', async () => {
    const updated = { ...sampleFullEntry, status: 'Asserted' };
    const { client } = buildEmbedAwareClient({ rpcResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'draft' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({ p_status: 'Asserted' }));
  });

  it('passes v1-capitalized status through unchanged', async () => {
    const updated = { ...sampleFullEntry, status: 'Superseded' };
    const { client } = buildEmbedAwareClient({ rpcResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Superseded' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({ p_status: 'Superseded' }));
  });

  it('allows Archived now that the write hits the base table (view limitation gone)', async () => {
    const updated = { ...sampleFullEntry, status: 'Archived' };
    const { client } = buildEmbedAwareClient({ rpcResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Archived' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({ p_status: 'Archived' }));
  });

  it('rejects an unrecognized status instead of silently dropping it', async () => {
    const { client } = buildEmbedAwareClient({ rpcResult: { data: sampleFullEntry } });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'bogus' }),
    ).rejects.toThrow(/Unsupported status/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('returns the row from the RPC directly (RETURNING is authoritative — no re-read)', async () => {
    const persisted = { ...sampleFullEntry, id: 'ke-1', status: 'Accepted', updated_at: '2026-06-08T12:00:00Z' };
    const { client, baseChain, viewChain } = buildEmbedAwareClient({ rpcResult: { data: persisted } });
    const result = await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Accepted' });
    expect(result).toEqual(persisted);
    expect(viewChain.single).not.toHaveBeenCalled();          // view never touched
    expect(baseChain.single).not.toHaveBeenCalled();          // base table touched only for the RPC's own write, not via .single()
    expect(client.rpc).toHaveBeenCalledTimes(1);              // exactly the one governed RPC call
  });

  // B-468 (+B-494): the decision-axis columns recordDecision writes but the update path
  // historically omitted — domain / madr / realization / review_by — are now editable.
  it('updates domain only (no throw from hasUpdates; passed through to the RPC)', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: { ...updatedEntry, domain: ['engineering', 'data'] },
    });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', domain: ['engineering', 'data'] });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_domain: ['engineering', 'data'],
    }));
  });

  it('updates madr only as a full-object replace (not a key-merge)', async () => {
    const madr = { context: 'new ctx', decision_outcome: 'do X' };
    const { client } = buildWorkspaceAndQueryClient({ data: { ...updatedEntry, madr } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', madr });
    // the WHOLE madr object is set — exact-match, no merged-in extra keys
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({ p_madr: madr }));
  });

  it('updates realization + review_by together', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: { ...updatedEntry, realization: 'live', review_by: '2026-09-01T00:00:00Z' },
    });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1', realization: 'live', review_by: '2026-09-01T00:00:00Z',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_realization: 'live', p_review_by: '2026-09-01T00:00:00Z',
    }));
  });

  it('hasUpdates accepts each new field alone (a domain/madr/realization/review_by-only call does not throw)', async () => {
    for (const args of [
      { entry_id: 'ke-1', domain: ['engineering'] },
      { entry_id: 'ke-1', madr: { context: 'c' } },
      { entry_id: 'ke-1', realization: 'agreed' },
      { entry_id: 'ke-1', review_by: '2026-09-01T00:00:00Z' },
    ]) {
      const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
      await expect(updateKnowledgeEntry(client, PROJECT_ID, args)).resolves.toBeDefined();
    }
  });

  it('does NOT re-embed when only the new decision-axis fields change (B-504 freshness-guard safety)', async () => {
    // Editing madr/domain/realization/review_by leaves title+content (the embedded text)
    // untouched, so the re-embed must NOT fire — the DB freshness-guard trigger keys only
    // on title/content, so the embedding is never nulled by these edits.
    const updated = { ...sampleFullEntry, domain: ['engineering'], realization: 'live' };
    const { client, baseChain } = buildEmbedAwareClient({ rpcResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1', domain: ['engineering'], madr: { context: 'c' }, realization: 'live', review_by: '2026-09-01T00:00:00Z',
    });
    expect(client.functions.invoke).not.toHaveBeenCalled();        // no embed-knowledge call
    expect(baseChain.update).not.toHaveBeenCalled();                // no embedding write at all
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'x', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });

  it('defaults p_provenance to null when omitted', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'x' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_knowledge_entry', expect.objectContaining({ p_provenance: null }));
  });
});

// ---------------------------------------------------------------------------
// supersedeKnowledgeEntry
// ---------------------------------------------------------------------------

describe('supersedeKnowledgeEntry', () => {
  const replacementEntry = {
    ...sampleFullEntry,
    id: 'ke-new',
    title: 'Use TypeScript strict mode v2',
    status: 'Accepted',
    project_id: PROJECT_ID,
  };
  const supersededEntry = {
    ...sampleFullEntry,
    status: 'Superseded',
    superseded_by: 'ke-new',
  };

  // B-995: the whole supersede (replacement insert + mark-superseded update) is now ONE
  // knowledge_supersede_knowledge_entry RPC call returning {superseded, replacement} directly — the
  // old getKnowledgeEntry-fetch / createKnowledgeEntry-insert-via-view / base-table-update three-step
  // flow collapses into a single client.rpc(...) response. The replacement's embedding stays a
  // separate follow-up write (embedDecisionById, unchanged), so baseChain is still exercised for that.
  function buildSupersedeClient() {
    const { client, baseChain } = buildEmbedAwareClient({
      rpcResult: { data: { superseded: supersededEntry, replacement: replacementEntry } },
    });
    return { client, baseChain };
  }

  it('supersedes old entry and creates replacement scoped to token project', async () => {
    const { client } = buildSupersedeClient();

    const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-1',
      new_title: 'Use TypeScript strict mode v2',
      new_content: 'Updated content for strict mode.',
    });

    expect(result.superseded.status).toBe('Superseded');
    expect(result.superseded.superseded_by).toBe('ke-new');
    expect(result.replacement.id).toBe('ke-new');
    expect(result.replacement.status).toBe('Accepted');
    expect(result.replacement.project_id).toBe(PROJECT_ID);

    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_knowledge_entry', expect.objectContaining({
      p_project_id: PROJECT_ID,
      p_entry_id: 'ke-1',
      p_new_title: 'Use TypeScript strict mode v2',
      p_new_content: 'Updated content for strict mode.',
    }));
  });

  it('replacement carries the token project_id — guaranteed by the RPC itself, not a caller-supplied value', async () => {
    // The RPC always stamps the replacement's project_id from p_project_id (never from whatever the
    // existing entry happens to carry), so this is now a structural guarantee rather than something
    // that needs a "legacy entry missing project_id" simulation to exercise.
    const { client } = buildSupersedeClient();
    const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-1',
      new_title: 'Use TypeScript strict mode v2',
      new_content: 'Updated content.',
    });
    expect(result.replacement.project_id).toBe(PROJECT_ID);
  });

  it('throws when neither entry_id nor title provided to identify old entry', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
        new_title: 'New',
        new_content: 'content',
      }),
    ).rejects.toThrow('Either entry_id or title must be provided');
  });

  it('embeds the replacement entry as a best-effort follow-up write (B-401) — the RPC has no p_embedding param', async () => {
    const replacement = { ...sampleFullEntry, id: 'ke-repl', title: 'New ruling', content: 'updated body' };
    const supersededRow = { ...sampleFullEntry, id: 'ke-old', status: 'Superseded', superseded_by: 'ke-repl' };
    const { client, baseChain } = buildEmbedAwareClient({
      rpcResult: { data: { superseded: supersededRow, replacement } },
    });

    const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-old', new_title: 'New ruling', new_content: 'updated body',
    });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'New ruling\nupdated body' } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-repl');
    expect(result.replacement.id).toBe('ke-repl');
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const { client } = buildSupersedeClient();
    await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-1', new_title: 'v2', new_content: 'c', provenance: 'agent-synthesized:unattended',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_knowledge_entry', expect.objectContaining({
      p_provenance: 'agent-synthesized:unattended', p_leg: null,
    }));
  });
});

// ---------------------------------------------------------------------------
// resolveOrCreateEntity
// ---------------------------------------------------------------------------

describe('resolveOrCreateEntity', () => {
  it('returns an existing entity id without inserting', async () => {
    const chain: any = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'ent-1' }, error: null });
    chain.insert = vi.fn().mockReturnValue(chain);
    const client: any = { from: vi.fn().mockReturnValue(chain) };

    const id = await resolveOrCreateEntity(client, WORKSPACE_ID, PROJECT_ID, 'auth', 'component');
    expect(id).toBe('ent-1');
    expect(chain.insert).not.toHaveBeenCalled();
  });

  it('inserts and returns a new entity id when none exists', async () => {
    let call = 0;
    const lookup: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    lookup.select.mockReturnValue(lookup); lookup.eq.mockReturnValue(lookup);
    lookup.maybeSingle.mockResolvedValue({ data: null, error: null });
    // B-977: resolveOrCreateEntity now ALSO runs findCrossKindCollision (select/eq/eq/neq/limit/
    // maybeSingle) between the same-kind lookup miss and the insert — no collision here.
    const collision: any = { select: vi.fn(), eq: vi.fn(), neq: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn() };
    collision.select.mockReturnValue(collision); collision.eq.mockReturnValue(collision);
    collision.neq.mockReturnValue(collision); collision.limit.mockReturnValue(collision);
    collision.maybeSingle.mockResolvedValue({ data: null, error: null });
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'ent-new' }, error: null });
    const chains = [lookup, collision, ins];
    const client: any = { from: vi.fn().mockImplementation(() => chains[Math.min(call++, chains.length - 1)]) };

    const id = await resolveOrCreateEntity(client, WORKSPACE_ID, PROJECT_ID, 'OIDC', 'concept');
    expect(id).toBe('ent-new');
    expect(ins.insert).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: WORKSPACE_ID, kind: 'concept', name: 'OIDC' }),
    );
  });

  it('B-977: logs a warning (never throws, never blocks the insert) on a same-name-different-kind collision', async () => {
    let call = 0;
    const lookup: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    lookup.select.mockReturnValue(lookup); lookup.eq.mockReturnValue(lookup);
    lookup.maybeSingle.mockResolvedValue({ data: null, error: null });
    const collision: any = { select: vi.fn(), eq: vi.fn(), neq: vi.fn(), limit: vi.fn(), maybeSingle: vi.fn() };
    collision.select.mockReturnValue(collision); collision.eq.mockReturnValue(collision);
    collision.neq.mockReturnValue(collision); collision.limit.mockReturnValue(collision);
    collision.maybeSingle.mockResolvedValue({ data: { id: 'ent-existing', kind: 'concept' }, error: null });
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'ent-new' }, error: null });
    const chains = [lookup, collision, ins];
    const client: any = { from: vi.fn().mockImplementation(() => chains[Math.min(call++, chains.length - 1)]) };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const id = await resolveOrCreateEntity(client, WORKSPACE_ID, PROJECT_ID, 'Cloud library management', 'feature');
    expect(id).toBe('ent-new');   // never blocked — the create proceeds
    expect(ins.insert).toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Cloud library management'));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ent-existing'));
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// queryEntities
// ---------------------------------------------------------------------------

describe('queryEntities', () => {
  it('filters by kind and name and scopes to workspace', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [{ id: 'ent-1', name: 'auth' }] });
    secondChain.ilike = vi.fn().mockReturnValue(secondChain);
    // queryEntities terminates on .order() (no .range), so .order must resolve here
    secondChain.order = vi.fn().mockResolvedValue({ data: [{ id: 'ent-1', name: 'auth' }], error: null });
    await queryEntities(client, PROJECT_ID, { kind: 'component', name: 'auth' });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_entities');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('kind', 'component');
    expect(secondChain.ilike).toHaveBeenCalledWith('name', '%auth%');
  });
});

// ---------------------------------------------------------------------------
// createEntity / updateEntity / reconcileEntity  (B-397 / folded B-399)
// ---------------------------------------------------------------------------

/**
 * A graph-shaped mock: from(table) returns a SHARED chain per table (so spies accumulate across the
 * multiple calls a reconcile makes), every filter method returns the chain, and each terminal —
 * .single(), .maybeSingle(), or awaiting the chain itself (thenable, mirroring PostgrestFilterBuilder)
 * — consumes the next {data,error} from that table's queue (the last entry repeats). from('projects')
 * always resolves the workspace id. `chains[table]` is exposed so tests can assert the exact args.
 */
function buildGraphClient(
  tables: Record<string, Array<{ data: any; error?: any }>>,
  // B-995: createEntity/updateEntity/reconcileEntity's terminal governed write is now a
  // client.rpc(name, args) call rather than a `.from()` chain — keyed by rpc function name, FIFO per
  // call (mirrors `tables`' own take()), a single (non-array) value is reused for every call.
  rpcResults?: Record<string, Array<{ data: any; error?: any }> | { data: any; error?: any }>,
) {
  const used: Record<string, number> = {};
  const norm = (r: { data: any; error?: any }) => ({ data: r?.data ?? null, error: r?.error ?? null });
  const take = (table: string) => {
    const q = tables[table] ?? [{ data: null }];
    const i = used[table] ?? 0;
    used[table] = i + 1;
    return norm(q[Math.min(i, q.length - 1)]);
  };
  const chains: Record<string, any> = {};
  const makeChain = (table: string) => {
    const c: any = {};
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'neq', 'limit', 'contains', 'ilike', 'is', 'in', 'order', 'range', 'overlaps', 'lte', 'or', 'gte', 'not']) {
      c[m] = vi.fn().mockReturnValue(c);
    }
    c.single = vi.fn().mockImplementation(() => Promise.resolve(take(table)));
    c.maybeSingle = vi.fn().mockImplementation(() => Promise.resolve(take(table)));
    c.then = (resolve: any) => resolve(take(table)); // await chain → consume queue (thenable)
    return c;
  };
  const rpcUsed: Record<string, number> = {};
  const rpc = vi.fn().mockImplementation((name: string) => {
    const cfg = rpcResults?.[name];
    if (!cfg) return Promise.resolve({ data: null, error: null });
    const arr = Array.isArray(cfg) ? cfg : [cfg];
    const i = rpcUsed[name] ?? 0;
    rpcUsed[name] = i + 1;
    return Promise.resolve(norm(arr[Math.min(i, arr.length - 1)]));
  });
  const client: any = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'projects') {
        const ws: any = {};
        ws.select = vi.fn().mockReturnValue(ws);
        ws.eq = vi.fn().mockReturnValue(ws);
        ws.single = vi.fn().mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
        return ws;
      }
      if (!chains[table]) chains[table] = makeChain(table);
      return chains[table];
    }),
    rpc,
  };
  return { client, chains };
}

const sampleEntity = {
  id: 'ent-1', workspace_id: WORKSPACE_ID, project_id: PROJECT_ID,
  kind: 'persona', name: 'Busy PM', description: 'A time-poor product manager', metadata: null,
  created_at: '2026-07-06T00:00:00Z',
};

describe('createEntity', () => {
  it('inserts a new typed node (kind + name + thin description) when none exists', async () => {
    const created = { ...sampleEntity };
    const { client, chains } = buildGraphClient(
      // lookup miss (same-kind), then the B-977 collision check miss (no other-kind match)
      { knowledge_entities: [{ data: null }, { data: null }] },
      { knowledge_create_entity: { data: created } },
    );
    const result = await createEntity(client, PROJECT_ID, {
      kind: 'persona', name: 'Busy PM', description: 'A time-poor product manager',
    });
    expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();   // the write now goes through the RPC
    expect(client.rpc).toHaveBeenCalledWith('knowledge_create_entity', expect.objectContaining({
      p_project_id: PROJECT_ID, p_kind: 'persona', p_name: 'Busy PM',
      p_description: 'A time-poor product manager',
    }));
    expect(result).toEqual(created);
  });

  it('is idempotent: re-authoring the same node with no new fields is a no-op (create-or-skip, A10)', async () => {
    const { client, chains } = buildGraphClient({ knowledge_entities: [{ data: sampleEntity }] });
    const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Busy PM' });
    expect(result).toEqual(sampleEntity);
    expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();   // no duplicate row
    expect(chains.knowledge_entities.update).not.toHaveBeenCalled();   // no needless write
    expect(client.rpc).not.toHaveBeenCalled();                         // matched on the TS-side lookup; RPC never reached
  });

  it('upserts the description onto an existing node when one is supplied', async () => {
    const updated = { ...sampleEntity, description: 'refreshed' };
    const { client, chains } = buildGraphClient({
      knowledge_entities: [{ data: sampleEntity }, { data: updated }],  // lookup hit, then update
    });
    const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Busy PM', description: 'refreshed' });
    expect(chains.knowledge_entities.update).toHaveBeenCalledWith({ description: 'refreshed' });
    expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();   // the upsert-on-existing branch stays a plain update, not the RPC
    expect(result).toEqual(updated);
  });

  it('throws when kind or name is missing', async () => {
    const { client } = buildGraphClient({});
    await expect(createEntity(client, PROJECT_ID, { kind: '', name: 'x' })).rejects.toThrow('kind is required');
    await expect(createEntity(client, PROJECT_ID, { kind: 'persona', name: '  ' })).rejects.toThrow('name is required');
  });

  it('seeds a persona node that is then queryable by kind=persona (AC4)', async () => {
    const created = { ...sampleEntity };
    const { client } = buildGraphClient(
      { knowledge_entities: [{ data: null }, { data: null }] },
      { knowledge_create_entity: { data: created } },
    );
    const seeded = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Busy PM', description: 'A time-poor product manager' });
    expect(seeded.kind).toBe('persona');
    // A queryEntities kind=persona over the same graph returns the seeded node (not []).
    const { client: qClient, secondChain } = buildWorkspaceAndQueryClient({ data: [created] });
    secondChain.order = vi.fn().mockResolvedValue({ data: [created], error: null });
    const rows = await queryEntities(qClient, PROJECT_ID, { kind: 'persona' });
    expect(rows).toEqual([created]);
  });

  // B-977 (AC3): same-name-different-kind is a WARNING, never a block, and never a silent duplicate.
  it('B-977: surfaces a non-blocking collision_warning when the name exists under a DIFFERENT kind', async () => {
    const created = { ...sampleEntity, kind: 'feature', name: 'Cloud library management' };
    const { client } = buildGraphClient(
      {
        knowledge_entities: [
          { data: null },                                             // same-kind ('feature') lookup: miss
          { data: { id: 'ent-old-concept', kind: 'concept' } },       // B-977 collision check: a DIFFERENT-kind match
        ],
      },
      { knowledge_create_entity: { data: created } },
    );
    const result = await createEntity(client, PROJECT_ID, { kind: 'feature', name: 'Cloud library management' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_create_entity', expect.objectContaining({
      p_kind: 'feature', p_name: 'Cloud library management',
    }));   // never blocked — create proceeds
    expect(result.id).toBe(created.id);
    expect((result as any).collision_warning).toEqual({
      entity_id: 'ent-old-concept',
      kind: 'concept',
      message: expect.stringContaining('reconcile_entity'),
    });
  });

  it('B-977: same-KIND match (the ordinary create-or-skip path) carries no collision_warning', async () => {
    const { client } = buildGraphClient({ knowledge_entities: [{ data: sampleEntity }] });
    const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Busy PM' });
    expect((result as any).collision_warning).toBeUndefined();
  });

  describe('B-993: HTML entity normalization + repair-at-touch', () => {
    it('(normalized-exists) resolves directly to a row already under the normalized name, no insert/update', async () => {
      const existing = { ...sampleEntity, name: 'Save & Continue' };
      const { client, chains } = buildGraphClient({ knowledge_entities: [{ data: existing }] });
      const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Save &amp; Continue' });
      expect(chains.knowledge_entities.eq).toHaveBeenCalledWith('name', 'Save & Continue');
      expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();
      expect(chains.knowledge_entities.update).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();
      expect(result).toEqual(existing);
    });

    it('(raw-legacy-exists) renames a legacy mangled-name row in place instead of minting a duplicate', async () => {
      const legacy = { ...sampleEntity, id: 'ent-legacy', name: 'Save &amp; Continue' };
      const renamed = { ...legacy, name: 'Save & Continue' };
      const { client, chains } = buildGraphClient({
        // normalized-name lookup: miss, raw/legacy-name lookup: hit, rename update: echo
        knowledge_entities: [{ data: null }, { data: legacy }, { data: renamed }],
      });
      const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Save &amp; Continue' });
      expect(chains.knowledge_entities.update).toHaveBeenCalledWith({ name: 'Save & Continue' });
      expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();
      expect(client.rpc).not.toHaveBeenCalled();   // the rename-in-place branch stays a plain update, not the RPC
      expect(result).toEqual(renamed);
    });

    it('(neither-exists) inserts a new row under the normalized name when no row matches either name', async () => {
      const created = { ...sampleEntity, id: 'ent-new', name: 'Save & Continue' };
      const { client } = buildGraphClient(
        // normalized-name lookup: miss, raw/legacy-name lookup: miss, B-977 collision check: miss
        { knowledge_entities: [{ data: null }, { data: null }, { data: null }] },
        { knowledge_create_entity: { data: created } },
      );
      const result = await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Save &amp; Continue' });
      expect(client.rpc).toHaveBeenCalledWith('knowledge_create_entity', expect.objectContaining({
        p_name: 'Save & Continue',
      }));
      expect(result).toEqual(created);
    });

    it('(description normalization) decodes a mangled entity in description on insert', async () => {
      const created = { ...sampleEntity, id: 'ent-new', name: 'Busy PM', description: 'Say "hi" & wave' };
      const { client } = buildGraphClient(
        // name has no entities to normalize, so no legacy lookup: same-kind miss, collision miss
        { knowledge_entities: [{ data: null }, { data: null }] },
        { knowledge_create_entity: { data: created } },
      );
      const result = await createEntity(client, PROJECT_ID, {
        kind: 'persona', name: 'Busy PM', description: 'Say &quot;hi&quot; &amp; wave',
      });
      expect(client.rpc).toHaveBeenCalledWith('knowledge_create_entity', expect.objectContaining({
        p_description: 'Say "hi" & wave',
      }));
      expect(result).toEqual(created);
    });

    it('(description normalization) decodes a mangled entity in description on the existing-row patch', async () => {
      const updated = { ...sampleEntity, description: 'Say "hi" & wave' };
      const { client, chains } = buildGraphClient({ knowledge_entities: [{ data: sampleEntity }, { data: updated }] });
      const result = await createEntity(client, PROJECT_ID, {
        kind: 'persona', name: 'Busy PM', description: 'Say &quot;hi&quot; &amp; wave',
      });
      expect(chains.knowledge_entities.update).toHaveBeenCalledWith({ description: 'Say "hi" & wave' });
      expect(result).toEqual(updated);
    });
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const created = { ...sampleEntity };
    const { client } = buildGraphClient(
      { knowledge_entities: [{ data: null }, { data: null }] },
      { knowledge_create_entity: { data: created } },
    );
    await createEntity(client, PROJECT_ID, { kind: 'persona', name: 'Busy PM', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_create_entity', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });
});

describe('updateEntity', () => {
  it('updates description by entity_id', async () => {
    const updated = { ...sampleEntity, description: 'new desc' };
    const { client, chains } = buildGraphClient({}, { knowledge_update_entity: { data: updated } });
    const result = await updateEntity(client, PROJECT_ID, { entity_id: 'ent-1', description: 'new desc' });
    expect(chains.knowledge_entities).toBeUndefined();   // no `.from('knowledge_entities')` chain touched at all
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_entity', expect.objectContaining({
      p_entity_id: 'ent-1', p_description: 'new desc',
    }));
    expect(result).toEqual(updated);
  });

  it('identifies the entity by (kind, name) when entity_id is omitted', async () => {
    const updated = { ...sampleEntity, kind: 'feature', name: 'Checkout' };
    const { client } = buildGraphClient({}, { knowledge_update_entity: { data: updated } });
    await updateEntity(client, PROJECT_ID, { kind: 'feature', name: 'Checkout', description: 'd' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_entity', expect.objectContaining({
      p_entity_id: null, p_kind: 'feature', p_name: 'Checkout',
    }));
  });

  it('throws when no identifier is provided', async () => {
    const { client } = buildGraphClient({});
    await expect(updateEntity(client, PROJECT_ID, { description: 'x' })).rejects.toThrow(/entity_id, or both kind and name/);
  });

  it('throws when no update field is provided', async () => {
    const { client } = buildGraphClient({});
    await expect(updateEntity(client, PROJECT_ID, { entity_id: 'ent-1' })).rejects.toThrow(/At least one of new_kind, description, or metadata/);
  });

  it('rejects a kind change that collides with a friendly pointer to reconcile_entity', async () => {
    const { client } = buildGraphClient(
      {},
      { knowledge_update_entity: { data: null, error: { code: '23505', message: 'unique violation' } } },
    );
    await expect(
      updateEntity(client, PROJECT_ID, { kind: 'concept', name: 'Checkout', new_kind: 'feature' }),
    ).rejects.toThrow(/reconcile_entity to MERGE/);
  });

  it('B-993: normalizes a mangled entity in description', async () => {
    const updated = { ...sampleEntity, description: 'Save & Continue' };
    const { client } = buildGraphClient({}, { knowledge_update_entity: { data: updated } });
    const result = await updateEntity(client, PROJECT_ID, { entity_id: 'ent-1', description: 'Save &amp; Continue' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_entity', expect.objectContaining({
      p_description: 'Save & Continue',
    }));
    expect(result).toEqual(updated);
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const updated = { ...sampleEntity };
    const { client } = buildGraphClient({}, { knowledge_update_entity: { data: updated } });
    await updateEntity(client, PROJECT_ID, { entity_id: 'ent-1', description: 'x', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_update_entity', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });
});


// ---------------------------------------------------------------------------
// resolveOrCreateEntity — B-993: normalize-before-lookup + two-step resolve +
// rename-in-place, pinned through BOTH callers that share this helper (record_decision's
// affected_entity_names path and assertFact), per the plan's de-risk note that both must
// be pinned, not just one. (link_ticket_entities shares the exact same helper call, so
// fixing resolveOrCreateEntity covers it too — no separate test needed for it.)
// ---------------------------------------------------------------------------

describe('resolveOrCreateEntity — B-993 HTML entity normalization + repair-at-touch', () => {
  const decisionRow = {
    id: 'dec-b993', workspace_id: WORKSPACE_ID, project_id: PROJECT_ID,
    title: 'x', content: '', type: 'business', status: 'Asserted', domain: [], confidence: 1.0,
    review_by: null, drift_risk: false, superseded_by: null, affected_entity_ids: [], madr: null,
    source_type: 'manual', source_id: null, source_activity: null, tags: [], source_task_id: null,
    created_by: USER_ID, created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
  };

  it('(normalized-exists, via record_decision) resolves directly to the existing normalized-name entity', async () => {
    const existing = { id: 'ent-1' };
    const { client, chains } = buildGraphClient(
      { knowledge_entities: [{ data: existing }] },
      { knowledge_record_decision: { data: { ...decisionRow, affected_entity_ids: ['ent-1'] } } },
    );
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'x', affected_entity_names: ['Save &amp; Continue'],
    });
    expect(chains.knowledge_entities.eq).toHaveBeenCalledWith('name', 'Save & Continue');
    expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_affected_entity_ids: ['ent-1'],
    }));
    expect(result.affected_entity_ids).toEqual(['ent-1']);
  });

  it('(raw-legacy-exists, via record_decision) renames a legacy mangled-name row in place', async () => {
    const legacy = { id: 'ent-legacy' };
    const renamed = { id: 'ent-legacy' };
    const { client, chains } = buildGraphClient(
      // normalized-name lookup: miss, raw/legacy-name lookup: hit, rename update: echo
      { knowledge_entities: [{ data: null }, { data: legacy }, { data: renamed }] },
      { knowledge_record_decision: { data: { ...decisionRow, affected_entity_ids: ['ent-legacy'] } } },
    );
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'x', affected_entity_names: ['Save &amp; Continue'],
    });
    expect(chains.knowledge_entities.update).toHaveBeenCalledWith({ name: 'Save & Continue' });
    expect(chains.knowledge_entities.insert).not.toHaveBeenCalled();
    expect(result.affected_entity_ids).toEqual(['ent-legacy']);
  });

  it('(neither-exists, via record_decision) creates a new entity under the normalized name', async () => {
    const { client, chains } = buildGraphClient(
      // normalized-name lookup: miss, raw/legacy-name lookup: miss, B-977 collision check: miss, insert echo
      { knowledge_entities: [{ data: null }, { data: null }, { data: null }, { data: { id: 'ent-new' } }] },
      { knowledge_record_decision: { data: { ...decisionRow, affected_entity_ids: ['ent-new'] } } },
    );
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'x', affected_entity_names: ['Save &amp; Continue'],
    });
    expect(chains.knowledge_entities.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Save & Continue' }),
    );
    expect(result.affected_entity_ids).toEqual(['ent-new']);
  });

  it('(no entities in the name, via record_decision) skips the legacy lookup entirely — a single query resolves it', async () => {
    const { client, chains } = buildGraphClient(
      // no HTML entities in the name → normalized === raw, so only ONE lookup + the B-977
      // collision check + insert; no second (legacy) query is ever issued.
      { knowledge_entities: [{ data: null }, { data: null }, { data: { id: 'ent-plain' } }] },
      { knowledge_record_decision: { data: { ...decisionRow, affected_entity_ids: ['ent-plain'] } } },
    );
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'x', affected_entity_names: ['Checkout flow'],
    });
    expect(chains.knowledge_entities.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Checkout flow' }),
    );
    expect(result.affected_entity_ids).toEqual(['ent-plain']);
  });

  it('(raw-legacy-exists, via assertFact) renames a legacy mangled-name row in place — pins the OTHER caller', async () => {
    const legacy = { id: 'ent-legacy' };
    const renamed = { id: 'ent-legacy' };
    const factRow = { id: 'fact-b993', subject_entity_id: 'ent-legacy', predicate: 'uses', status: 'Asserted' };
    const { client, chains } = buildGraphClient(
      { knowledge_entities: [{ data: null }, { data: legacy }, { data: renamed }] },
      { knowledge_assert_fact: { data: factRow } },
    );
    const result = await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'Save &amp; Continue button', predicate: 'uses', object: 'x', source_type: 'manual',
    });
    expect(chains.knowledge_entities.update).toHaveBeenCalledWith({ name: 'Save & Continue button' });
    // resolveOrCreateEntity settles the entity first (B-993); the RPC's own inline resolution then
    // gets passed the ALREADY-normalized name, so it resolves to the very row just renamed.
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({
      p_subject_entity: 'Save & Continue button',
    }));
    expect(result).toEqual(factRow);
  });
});

describe('reconcileEntity', () => {
  const stub = { id: 'ent-stub', workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, kind: 'concept', name: 'Checkout', description: null, metadata: null, created_at: '2026-07-06T00:00:00Z' };
  const typed = { ...stub, id: 'ent-typed', kind: 'component' };

  // B-995: reconcileEntity is now a thin wrapper around ONE knowledge_reconcile_entity RPC call — the
  // whole merge (repoint facts/decisions/events, delete the stub) happens server-side in a single
  // transaction, so these tests now assert on the RPC call's args and its jsonb return shape rather
  // than on a sequence of `.from()` chain calls.
  function rpcClient(result: { data: any; error?: any }) {
    const rpc = vi.fn().mockResolvedValue({ data: result.data, error: result.error ?? null });
    const client: any = { from: vi.fn(), rpc };
    return client;
  }

  it('UPGRADE-IN-PLACE: retypes the stub in place when no same-named typed node exists (no references move)', async () => {
    const upgraded = { ...stub, kind: 'component', description: 'the checkout surface' };
    const client = rpcClient({ data: { mode: 'upgrade-in-place', entity: upgraded } });

    const result = await reconcileEntity(client, PROJECT_ID, { name: 'Checkout', to_kind: 'component', description: 'the checkout surface' });

    expect(result.mode).toBe('upgrade-in-place');
    expect(result.entity).toEqual(upgraded);
    expect(client.rpc).toHaveBeenCalledWith('knowledge_reconcile_entity', expect.objectContaining({
      p_project_id: PROJECT_ID, p_name: 'Checkout', p_to_kind: 'component', p_from_kind: 'concept',
      p_description: 'the checkout surface',
    }));
  });

  it('MERGE: repoints facts + decisions + events to the typed node (deduping arrays), then deletes the stub', async () => {
    const client = rpcClient({
      data: {
        mode: 'merge',
        entity: typed,
        merged_stub_id: 'ent-stub',
        repointed: { facts: 1, decisions: 1, events: 1 },
      },
    });

    const result = await reconcileEntity(client, PROJECT_ID, { name: 'Checkout', to_kind: 'component' });

    expect(result.mode).toBe('merge');
    expect(result.entity.id).toBe('ent-typed');
    expect(result.merged_stub_id).toBe('ent-stub');
    expect(result.repointed).toEqual({ facts: 1, decisions: 1, events: 1 });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_reconcile_entity', expect.objectContaining({
      p_name: 'Checkout', p_to_kind: 'component', p_from_kind: 'concept',
    }));
  });

  it('MERGE never fails on the append-only event log (events repoint throwing is swallowed) — the RPC reports events:0', async () => {
    // The RPC's own best-effort events repoint (never blocking the merge) is server-side now; from
    // this handler's perspective it is just another field of the jsonb result.
    const client = rpcClient({
      data: { mode: 'merge', entity: typed, merged_stub_id: 'ent-stub', repointed: { facts: 0, decisions: 0, events: 0 } },
    });
    const result = await reconcileEntity(client, PROJECT_ID, { name: 'Checkout', to_kind: 'component' });
    expect(result.mode).toBe('merge');
    expect(result.repointed?.events).toBe(0);
  });

  it('throws when there is no stub to reconcile', async () => {
    const client = rpcClient({
      data: null,
      error: { message: 'knowledge_reconcile_entity: expected exactly one concept entity named "Ghost", found 0' },
    });
    await expect(
      reconcileEntity(client, PROJECT_ID, { name: 'Ghost', to_kind: 'component' }),
    ).rejects.toThrow(/No concept entity named "Ghost"/);
  });

  it('throws when from_kind equals to_kind (nothing to reconcile)', async () => {
    const client = rpcClient({ data: null });
    await expect(
      reconcileEntity(client, PROJECT_ID, { name: 'x', to_kind: 'concept', from_kind: 'concept' }),
    ).rejects.toThrow(/must differ/);
    expect(client.rpc).not.toHaveBeenCalled();   // validation precedes any DB access
  });

  it('surfaces any other RPC error message unchanged', async () => {
    const client = rpcClient({ data: null, error: { message: 'some other precondition failure' } });
    await expect(
      reconcileEntity(client, PROJECT_ID, { name: 'Checkout', to_kind: 'component' }),
    ).rejects.toThrow('some other precondition failure');
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const client = rpcClient({ data: { mode: 'upgrade-in-place', entity: typed } });
    await reconcileEntity(client, PROJECT_ID, { name: 'Checkout', to_kind: 'component', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_reconcile_entity', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });
});

describe('entity-authoring tool schemas (B-397)', () => {
  it('create_entity requires kind + name and documents thin descriptions', () => {
    expect(createEntityTool.name).toBe('create_entity');
    expect((createEntityTool.inputSchema as any).required).toEqual(['kind', 'name']);
    expect(createEntityTool.description.toLowerCase()).toContain('thin');
  });
  it('update_entity exposes new_kind and points collisions at reconcile_entity', () => {
    expect(updateEntityTool.name).toBe('update_entity');
    expect(updateEntityTool.inputSchema.properties).toHaveProperty('new_kind');
    expect(updateEntityTool.description).toContain('reconcile_entity');
  });
  it('reconcile_entity requires name + to_kind and documents both modes', () => {
    expect(reconcileEntityTool.name).toBe('reconcile_entity');
    expect((reconcileEntityTool.inputSchema as any).required).toEqual(['name', 'to_kind']);
    const d = reconcileEntityTool.description.toUpperCase();
    expect(d).toContain('UPGRADE-IN-PLACE');
    expect(d).toContain('MERGE');
  });
});

// ---------------------------------------------------------------------------
// recordDecision
// ---------------------------------------------------------------------------

describe('recordDecision', () => {
  const decisionRow = {
    id: 'dec-1', workspace_id: WORKSPACE_ID, project_id: PROJECT_ID,
    title: 'Adopt RRF for hybrid search', content: '', type: 'technical-design',
    status: 'Asserted', domain: ['engineering'], confidence: 1.0, review_by: null, drift_risk: false,
    superseded_by: null, affected_entity_ids: [], madr: { context: 'why' },
    source_type: 'manual', source_id: null, source_activity: 'design-decide',
    tags: [], source_task_id: null, created_by: USER_ID,
    created_at: '2026-05-29T00:00:00Z', updated_at: '2026-05-29T00:00:00Z',
  };

  it('writes a decision defaulting status=Asserted and stamps token project via knowledge_record_decision', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'technical-design',
      title: 'Adopt RRF for hybrid search',
      domain: ['engineering'],
      madr: { context: 'why' },
      source_activity: 'design-decide',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_project_id: PROJECT_ID, p_type: 'technical-design',
      p_title: 'Adopt RRF for hybrid search', p_status: 'Asserted', p_domain: ['engineering'],
      p_source_activity: 'design-decide',
    }));
    expect(result).toEqual(decisionRow);
  });

  it('throws when type is missing', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      recordDecision(client, PROJECT_ID, USER_ID, { title: 'x' } as any),
    ).rejects.toThrow('type is required');
  });

  it('maps a duplicate-title violation to a friendly error', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null, error: { code: '23505', message: 'dup' } });
    await expect(
      recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'Existing' }),
    ).rejects.toThrow('A decision titled "Existing" already exists in this project');
  });

  it('embeds the decision on write and includes the pgvector literal', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    (client as any).functions = { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.1, 0.2], stub: true }, error: null }) };
    await recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'Adopt RRF' });
    expect((client as any).functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: expect.stringContaining('Adopt RRF') } });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_embedding: '[0.1,0.2]' }));
  });

  it('still writes the decision when embedding fails (embedding omitted, best-effort)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    (client as any).functions = { invoke: vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } }) };
    await recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'Adopt RRF' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_embedding: null }));
  });

  it('persists review_by on the decision row (P4 F2 — research freshness)', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: { ...decisionRow, source_type: 'research', review_by: '2026-08-27T00:00:00Z' },
    });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'specification', title: 'researched finding', source_type: 'research',
      review_by: '2026-08-27T00:00:00Z',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_review_by: '2026-08-27T00:00:00Z', p_source_type: 'research',
    }));
  });

  it('persists the realization axis when provided (B-400)', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: { ...decisionRow, realization: 'agreed' },
    });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'technical-design', title: 'decided not yet built', realization: 'agreed',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_realization: 'agreed' }));
  });

  it('passes p_realization: null when not provided (NULL ≡ live, B-400)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'no realization given',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_realization: null }));
  });

  // B-977 (AC2): a technical/product/ux-ui design decision defaults to realization='agreed'
  // (decided-not-yet-built) instead of NULL, unless the caller passes an explicit override. Every
  // OTHER type keeps the NULL≡live default untouched (B-551 relies on it).
  describe('B-977: default realization for design-decision types', () => {
    it.each(['technical-design', 'product-design', 'ux-ui-design'])(
      "defaults realization='agreed' for type=%s when omitted",
      async (type) => {
        const { client } = buildWorkspaceAndQueryClient({ data: { ...decisionRow, type, realization: 'agreed' } });
        await recordDecision(client, PROJECT_ID, USER_ID, { type, title: `a ${type} decision` });
        expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_realization: 'agreed' }));
      },
    );

    it('an explicit realization on a design-decision type ALWAYS wins over the default', async () => {
      const { client } = buildWorkspaceAndQueryClient({
        data: { ...decisionRow, type: 'technical-design', realization: 'live' },
      });
      await recordDecision(client, PROJECT_ID, USER_ID, {
        type: 'technical-design', title: 'already shipped', realization: 'live',
      });
      expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_realization: 'live' }));
    });

    it.each(['business', 'architecture', 'convention', 'specification', 'deferral'])(
      'every OTHER decision type (%s) keeps the NULL≡live default UNTOUCHED — p_realization: null',
      async (type) => {
        const { client } = buildWorkspaceAndQueryClient({ data: { ...decisionRow, type } });
        await recordDecision(client, PROJECT_ID, USER_ID, { type, title: `a ${type} decision` });
        expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_realization: null }));
      },
    );
  });

  // B-645: elicitation claims — provenance + brief coupling.
  it('includes claim_provenance + underwriting_brief_id in the RPC call when provided (B-645)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'specification', title: 'claim: exports must be CSV-first',
      claim_provenance: 'human-stated', underwriting_brief_id: 'brief-1',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_claim_provenance: 'human-stated', p_underwriting_brief_id: 'brief-1',
    }));
  });

  it('passes p_claim_provenance/p_underwriting_brief_id as null when not provided (a non-claim decision, B-645)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'ordinary decision' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_claim_provenance: null, p_underwriting_brief_id: null,
    }));
  });

  it('rejects an invalid claim_provenance (enum check, B-645)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      recordDecision(client, PROJECT_ID, USER_ID, {
        type: 'specification', title: 'x', claim_provenance: 'vibes',
      }),
    ).rejects.toThrow(/claim_provenance must be one of: human-stated, agent-inferred-human-validated, force-quit/);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("accepts the 'force-quit' provenance (the quarantined ground)", async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'specification', title: 'assumed under force-quit',
      claim_provenance: 'force-quit', underwriting_brief_id: 'brief-1',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({ p_claim_provenance: 'force-quit' }));
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'x', provenance: 'agent-synthesized:unattended',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_record_decision', expect.objectContaining({
      p_provenance: 'agent-synthesized:unattended', p_leg: null,
    }));
  });
});

describe('recordDecisionTool schema — B-645 claim params', () => {
  it('exposes claim_provenance with its enum and underwriting_brief_id, neither required', () => {
    const props = recordDecisionTool.inputSchema.properties as Record<string, any>;
    expect(props.claim_provenance.enum).toEqual(['human-stated', 'agent-inferred-human-validated', 'force-quit']);
    expect(props.underwriting_brief_id).toBeDefined();
    const required = (recordDecisionTool.inputSchema as any).required as string[];
    expect(required).not.toContain('claim_provenance');
    expect(required).not.toContain('underwriting_brief_id');
  });
});

describe('recordDecisionTool schema', () => {
  it('exposes the realization property with its enum (B-400)', () => {
    const props = recordDecisionTool.inputSchema.properties as Record<string, any>;
    expect(props.realization).toBeDefined();
    expect(props.realization.enum).toEqual(['agreed', 'live', 'deprecating', 'retired']);
  });

  it('does not require realization (callers opt in)', () => {
    const required = (recordDecisionTool.inputSchema as any).required as string[];
    expect(required).not.toContain('realization');
  });
});

// ---------------------------------------------------------------------------
// supersedeDecision
// ---------------------------------------------------------------------------

describe('supersedeDecision', () => {
  it('creates the replacement then marks the old decision Superseded with superseded_by (single knowledge_supersede_decision RPC call)', async () => {
    const replacement = { id: 'dec-2', title: 'v2', status: 'Accepted', type: 'business' };
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: 'dec-2' };
    const { client } = buildWorkspaceAndQueryClient({ data: { superseded: supersededOld, replacement } });

    const result = await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1',
      type: 'business',
      title: 'v2',
      reason: 'pricing changed',
    });
    expect(result.replacement!.id).toBe('dec-2');
    expect(result.superseded.status).toBe('Superseded');
    expect(result.superseded.superseded_by).toBe('dec-2');
    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_decision', expect.objectContaining({
      p_old_decision_id: 'dec-1', p_project_id: PROJECT_ID, p_type: 'business', p_title: 'v2',
    }));
  });

  it('throws when old_decision_id is missing', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'v2' } as any),
    ).rejects.toThrow('old_decision_id is required');
  });

  it('throws on a missing old_decision_id without creating an orphan replacement — the RPC RAISEs inside its own transaction, so nothing is ever partially written', async () => {
    const { client } = buildWorkspaceAndQueryClient({
      data: null,
      error: { message: 'knowledge_supersede_decision: decision missing not found in this project' },
    });
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'missing', type: 'business', title: 'v2' }),
    ).rejects.toThrow('not found');
    expect(client.rpc).toHaveBeenCalledTimes(1);   // one atomic call — no separate fetch, no separate insert
  });

  it('retire-mode (B-534): omitting BOTH type+title marks the old decision Superseded with superseded_by=null and creates NO successor', async () => {
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: null };
    const { client } = buildWorkspaceAndQueryClient({ data: { superseded: supersededOld, replacement: null } });

    const result = await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1',
      reason: 'backing the ticket up to re-clarify natively — successor authored later, not here',
    });

    expect(result.replacement).toBeNull();                                   // NO successor
    expect(result.superseded.status).toBe('Superseded');
    expect(result.superseded.superseded_by).toBeNull();
    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_decision', expect.objectContaining({
      p_type: null, p_title: null,
    }));
  });

  it('throws when exactly ONE of type/title is provided (ambiguous — B-534), before touching the DB', async () => {
    const client: any = { from: vi.fn(), rpc: vi.fn() };
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'dec-1', type: 'business' }),
    ).rejects.toThrow(/exactly one of type\/title|retire/i);
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'dec-1', title: 'v2' }),
    ).rejects.toThrow(/exactly one of type\/title|retire/i);
    expect(client.from).not.toHaveBeenCalled();   // validation precedes any DB access
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('resolves affected_entity_names to ids in TS and passes them to p_affected_entity_ids (B-995 option c)', async () => {
    const replacement = { id: 'dec-2', title: 'v2', status: 'Accepted', type: 'business' };
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: 'dec-2' };
    const { client, chains } = buildGraphClient(
      { knowledge_entities: [{ data: { id: 'ent-1' } }] },
      { knowledge_supersede_decision: { data: { superseded: supersededOld, replacement } } },
    );

    await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1', type: 'business', title: 'v2', affected_entity_names: ['Checkout'],
    });

    expect(chains.knowledge_entities.eq).toHaveBeenCalledWith('name', 'Checkout');
    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_decision', expect.objectContaining({
      p_affected_entity_ids: ['ent-1'],
    }));
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const replacement = { id: 'dec-2', title: 'v2', status: 'Accepted', type: 'business' };
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: 'dec-2' };
    const { client } = buildWorkspaceAndQueryClient({ data: { superseded: supersededOld, replacement } });
    await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1', type: 'business', title: 'v2', provenance: 'human-in-session',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_supersede_decision', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });
});

describe('supersedeDecisionTool schema (B-534 retire-mode)', () => {
  it('requires only old_decision_id (type/title optional to allow retire-mode)', () => {
    const required = (supersedeDecisionTool.inputSchema as any).required as string[];
    expect(required).toEqual(['old_decision_id']);
    expect(required).not.toContain('type');
    expect(required).not.toContain('title');
  });

  it('documents retire-mode (omit both type and title) in the tool + type/title descriptions', () => {
    expect(supersedeDecisionTool.description.toLowerCase()).toContain('retire');
    const props = supersedeDecisionTool.inputSchema.properties as Record<string, any>;
    expect(props.type.description.toLowerCase()).toContain('retire');
    expect(props.title.description.toLowerCase()).toContain('retire');
  });
});

// ---------------------------------------------------------------------------
// assertFact
// ---------------------------------------------------------------------------

describe('assertFact', () => {
  // assertFact's own from() calls are now just the getWorkspaceId lookup + resolveOrCreateEntity's
  // entity lookup (B-993 normalize/repair-at-touch, unchanged) — the fact write itself moved to a
  // client.rpc('knowledge_assert_fact', ...) call.
  function buildAssertFactClient(entityData: any, rpcData: any) {
    const entityHit: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    entityHit.select.mockReturnValue(entityHit); entityHit.eq.mockReturnValue(entityHit);
    entityHit.maybeSingle.mockResolvedValue({ data: entityData, error: null });
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    let i = 0;
    const client: any = {
      from: vi.fn().mockImplementation(() => [ws, entityHit][i++] ?? entityHit),
      rpc: vi.fn().mockResolvedValue({ data: rpcData, error: null }),
    };
    return client;
  }

  it('resolves the subject entity then calls knowledge_assert_fact with provenance', async () => {
    const factRow = { id: 'fact-1', subject_entity_id: 'ent-1', predicate: 'uses', status: 'Asserted' };
    const client = buildAssertFactClient({ id: 'ent-1' }, factRow);

    const result = await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'uses', object: 'HSL tokens', source_type: 'ticket', source_id: 'task-9',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({
      p_project_id: PROJECT_ID, p_subject_entity: 'board', p_predicate: 'uses', p_object: 'HSL tokens',
      p_source_type: 'ticket', p_source_id: 'task-9',
    }));
    expect(result).toEqual(factRow);
  });

  it('throws when source_type is missing (provenance is required)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      assertFact(client, PROJECT_ID, USER_ID, { subject_entity: 'x', predicate: 'uses', object: 1 } as any),
    ).rejects.toThrow('source_type is required');
  });

  it('passes a structured (non-scalar) object through to the RPC call unchanged', async () => {
    const client = buildAssertFactClient({ id: 'ent-1' }, { id: 'fact-2' });
    await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'configured_by', object: { ref: 'ent-2', weight: 3 }, source_type: 'manual',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({
      p_object: { ref: 'ent-2', weight: 3 },
    }));
  });

  it('embeds the fact on write and includes the pgvector literal', async () => {
    const client = buildAssertFactClient({ id: 'ent-1' }, { id: 'fact-1' });
    client.functions = { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.3, 0.4] }, error: null }) };
    await assertFact(client, PROJECT_ID, USER_ID, { subject_entity: 'board', predicate: 'uses', object: 'x', source_type: 'manual' });
    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', expect.objectContaining({ body: expect.objectContaining({ text: expect.stringContaining('board') }) }));
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({ p_embedding: '[0.3,0.4]' }));
  });

  it('persists review_by on the fact row (P4 F2 — research freshness)', async () => {
    const client = buildAssertFactClient({ id: 'ent-1' }, { id: 'fact-3' });
    await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'uses', object: 'x', source_type: 'research',
      review_by: '2026-08-27T00:00:00Z',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({
      p_review_by: '2026-08-27T00:00:00Z', p_source_type: 'research',
    }));
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const client = buildAssertFactClient({ id: 'ent-1' }, { id: 'fact-4' });
    await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'uses', object: 'x', source_type: 'manual', provenance: 'human-in-session',
    });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_assert_fact', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });
});

// ---------------------------------------------------------------------------
// invalidateFact
// ---------------------------------------------------------------------------

describe('invalidateFact', () => {
  it('calls knowledge_invalidate_fact with the fact id and project id', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ data: { id: 'fact-1', status: 'Superseded' }, error: null }) };
    const result = await invalidateFact(client, PROJECT_ID, { fact_id: 'fact-1', reason: 'no longer true' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_invalidate_fact', expect.objectContaining({
      p_fact_id: 'fact-1', p_project_id: PROJECT_ID,
    }));
    expect(result).toEqual({ id: 'fact-1', status: 'Superseded' });
  });

  it('throws when fact_id is missing', async () => {
    const client: any = { rpc: vi.fn() };
    await expect(invalidateFact(client, PROJECT_ID, {} as any)).rejects.toThrow('fact_id is required');
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it('threads an explicit provenance and the run-config conduction id, defaulting p_leg to null', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ data: { id: 'fact-1' }, error: null }) };
    await invalidateFact(client, PROJECT_ID, { fact_id: 'fact-1', provenance: 'human-in-session' });
    expect(client.rpc).toHaveBeenCalledWith('knowledge_invalidate_fact', expect.objectContaining({
      p_provenance: 'human-in-session', p_leg: null,
    }));
  });

  it('surfaces the RPC error message', async () => {
    const client: any = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'knowledge_invalidate_fact: fact x not found in this project' } }) };
    await expect(invalidateFact(client, PROJECT_ID, { fact_id: 'x' })).rejects.toThrow('not found in this project');
  });
});

// ---------------------------------------------------------------------------
// queryFacts
// ---------------------------------------------------------------------------

describe('queryFacts', () => {
  it('filters currently-valid facts by min_confidence and scopes to workspace', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    secondChain.is = vi.fn().mockReturnValue(secondChain);
    secondChain.gte = vi.fn().mockReturnValue(secondChain);
    // queryFacts terminates on .order() (no .range), so .order must resolve here
    secondChain.order = vi.fn().mockResolvedValue({ data: [], error: null });
    await queryFacts(client, PROJECT_ID, { min_confidence: 0.7 });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_facts');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.is).toHaveBeenCalledWith('valid_to', null);
    expect(secondChain.gte).toHaveBeenCalledWith('confidence', 0.7);
  });

  it('resolves an entity name spanning multiple kinds via .in() (no silent empty, no swallowed error)', async () => {
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const facts: any = {};
    facts.select = vi.fn().mockReturnValue(facts);
    facts.eq = vi.fn().mockReturnValue(facts);
    facts.is = vi.fn().mockReturnValue(facts);
    facts.in = vi.fn().mockReturnValue(facts);
    facts.order = vi.fn().mockResolvedValue({ data: [{ id: 'fact-1' }], error: null });
    const ents: any = { select: vi.fn(), eq: vi.fn(), ilike: vi.fn() };
    ents.select.mockReturnValue(ents); ents.eq.mockReturnValue(ents);
    ents.ilike.mockResolvedValue({ data: [{ id: 'ent-a' }, { id: 'ent-b' }], error: null });
    let i = 0;
    const client: any = { from: vi.fn().mockImplementation(() => [ws, facts, ents][i++]) };
    const result = await queryFacts(client, PROJECT_ID, { entity: 'board' });
    expect(facts.in).toHaveBeenCalledWith('subject_entity_id', ['ent-a', 'ent-b']);
    expect(result).toEqual([{ id: 'fact-1' }]);
  });

  it('applies the as_of two-sided window and suppresses the currently-valid filter', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    secondChain.is = vi.fn().mockReturnValue(secondChain);
    secondChain.lte = vi.fn().mockReturnValue(secondChain);
    secondChain.or = vi.fn().mockReturnValue(secondChain);
    secondChain.order = vi.fn().mockResolvedValue({ data: [], error: null });
    await queryFacts(client, PROJECT_ID, { as_of: '2026-01-01T00:00:00Z' });
    expect(secondChain.lte).toHaveBeenCalledWith('valid_from', '2026-01-01T00:00:00Z');
    expect(secondChain.or).toHaveBeenCalledWith('valid_to.is.null,valid_to.gt.2026-01-01T00:00:00Z');
    expect(secondChain.is).not.toHaveBeenCalled();   // as_of suppresses the valid_to-null filter
  });
});
