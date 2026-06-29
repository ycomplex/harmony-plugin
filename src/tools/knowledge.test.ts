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

  const client: any = {
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'projects') return wsChain;
      if (table === 'knowledge_decisions') return baseChain;
      return viewChain; // workspace_knowledge
    }),
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

  it('updates by entry_id and scopes to token project', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    const result = await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1',
      new_title: 'Updated Title',
    });

    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated Title' }));
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('id', 'ke-1');
    expect(result).toEqual(updatedEntry);
  });

  it('updates a next-gen-typed entry via the base table (B-418)', async () => {
    // The compat view's INSTEAD-OF UPDATE never fires for rows outside its WHERE
    // (the legacy four types) → zero rows → "Cannot coerce". The base table sees all types.
    const nextGen = { ...sampleFullEntry, id: 'ke-ng', type: 'technical-design', tags: ['layer3-nextgen'] };
    const { client, baseChain, viewChain } = buildEmbedAwareClient({ baseResult: { data: nextGen } });

    const result = await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-ng', tags: ['layer3-nextgen'] });

    expect(viewChain.update).not.toHaveBeenCalled();
    expect(baseChain.update).toHaveBeenCalledWith({ tags: ['layer3-nextgen'] });
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-ng');
    expect(result).toEqual(nextGen);
  });

  it('updates by title scoped to token project', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      title: 'Use TypeScript strict mode',
      content: 'new content',
    });
    expect(secondChain.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('title', 'Use TypeScript strict mode');
  });

  it('can update content, type, status, and tags (status normalized to base vocab)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1',
      content: 'new content',
      type: 'business',
      status: 'accepted',
      tags: ['new-tag'],
    });
    expect(secondChain.update).toHaveBeenCalledWith(
      expect.objectContaining({
        content: 'new content',
        type: 'business',
        status: 'Accepted',   // base table speaks v1 vocab; legacy lowercase is normalized up
        tags: ['new-tag'],
      }),
    );
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
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', content: 'NEW why-rich content', status: 'accepted' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `${updated.title}\nNEW why-rich content` } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-1');
  });

  it('re-embeds when the title changes', async () => {
    // content is unchanged — the re-embed must still fire because the title changed
    const updated = { ...sampleFullEntry, title: 'Renamed title' };
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', new_title: 'Renamed title' });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: `Renamed title\n${sampleFullEntry.content}` } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
  });

  it('does NOT re-embed when only status changes (no wasted embed call)', async () => {
    const updated = { ...sampleFullEntry, status: 'Accepted' };
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });

    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'accepted' });

    expect(client.functions.invoke).not.toHaveBeenCalled();            // no embed
    expect(baseChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ embedding: expect.anything() }),       // no embedding write
    );
  });

  it('normalizes legacy lowercase status to the v1 vocab the base table expects (B-418)', async () => {
    const updated = { ...sampleFullEntry, status: 'Asserted' };
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'draft' });
    expect(baseChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Asserted' }));
  });

  it('passes v1-capitalized status through unchanged', async () => {
    const updated = { ...sampleFullEntry, status: 'Superseded' };
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Superseded' });
    expect(baseChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Superseded' }));
  });

  it('allows Archived now that the write hits the base table (view limitation gone)', async () => {
    const updated = { ...sampleFullEntry, status: 'Archived' };
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Archived' });
    expect(baseChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Archived' }));
  });

  it('rejects an unrecognized status instead of silently dropping it', async () => {
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: sampleFullEntry } });
    await expect(
      updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'bogus' }),
    ).rejects.toThrow(/Unsupported status/);
    expect(baseChain.update).not.toHaveBeenCalled();
  });

  it('returns the row from the base-table update directly (RETURNING is authoritative — no re-read)', async () => {
    const persisted = { ...sampleFullEntry, id: 'ke-1', status: 'Accepted', updated_at: '2026-06-08T12:00:00Z' };
    const { client, baseChain, viewChain } = buildEmbedAwareClient({ baseResult: { data: persisted } });
    const result = await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', status: 'Accepted' });
    expect(result).toEqual(persisted);
    expect(viewChain.single).not.toHaveBeenCalled();          // view never touched
    expect(baseChain.single).toHaveBeenCalledTimes(1);        // exactly the UPDATE … RETURNING, no extra read
  });

  // B-468 (+B-494): the decision-axis columns recordDecision writes but the update path
  // historically omitted — domain / madr / realization / review_by — are now editable.
  it('updates domain only (no throw from hasUpdates; passed through to the base update)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({
      data: { ...updatedEntry, domain: ['engineering', 'data'] },
    });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', domain: ['engineering', 'data'] });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.update).toHaveBeenCalledWith({ domain: ['engineering', 'data'] });
  });

  it('updates madr only as a full-object replace (not a key-merge)', async () => {
    const madr = { context: 'new ctx', decision_outcome: 'do X' };
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: { ...updatedEntry, madr } });
    await updateKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1', madr });
    // the WHOLE madr object is set — exact-match, no merged-in extra keys
    expect(secondChain.update).toHaveBeenCalledWith({ madr });
  });

  it('updates realization + review_by together', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({
      data: { ...updatedEntry, realization: 'live', review_by: '2026-09-01T00:00:00Z' },
    });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1', realization: 'live', review_by: '2026-09-01T00:00:00Z',
    });
    expect(secondChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ realization: 'live', review_by: '2026-09-01T00:00:00Z' }),
    );
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
    const { client, baseChain } = buildEmbedAwareClient({ baseResult: { data: updated } });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1', domain: ['engineering'], madr: { context: 'c' }, realization: 'live', review_by: '2026-09-01T00:00:00Z',
    });
    expect(client.functions.invoke).not.toHaveBeenCalled();        // no embed-knowledge call
    expect(baseChain.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ embedding: expect.anything() }),    // no embedding write
    );
  });
});

// ---------------------------------------------------------------------------
// supersedeKnowledgeEntry
// ---------------------------------------------------------------------------

describe('supersedeKnowledgeEntry', () => {
  const existingEntry = { ...sampleFullEntry };
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

  /**
   * supersedeKnowledgeEntry's .single() calls (via buildEmbedAwareClient):
   * base 0. getKnowledgeEntry fetch  (knowledge_decisions → single): existing entry
   * view 0. createKnowledgeEntry insert echo  (workspace_knowledge → insert → single): echoed replacement
   * base 1. createKnowledgeEntry re-read  (knowledge_decisions → single, B-415): authoritative replacement
   * base 2. mark-superseded update  (knowledge_decisions → update → single): supersededEntry
   * (the embedding write never calls .single(), so it doesn't consume the base queue)
   *
   * wsChain handles all projects lookups (returns WORKSPACE_ID every time).
   * We capture inserts by spying on viewChain.insert.
   */
  function buildSupersedeClient(overrides?: { existing?: any }) {
    const existingRow = overrides?.existing ?? existingEntry;
    const { client, viewChain, baseChain } = buildEmbedAwareClient({
      viewResult: { data: replacementEntry },  // createKnowledgeEntry insert echo
      baseResult: [
        { data: existingRow },      // getKnowledgeEntry fetch
        { data: replacementEntry }, // createKnowledgeEntry re-read (authoritative — same row is fine for these tests)
        { data: supersededEntry },  // mark-superseded update
      ],
    });

    const insertCalls: any[] = [];
    const origInsert = viewChain.insert.bind(viewChain);
    viewChain.insert = vi.fn().mockImplementation((record: any) => {
      insertCalls.push(record);
      return origInsert(record);
    });

    return { client, insertCalls, baseChain };
  }

  it('supersedes old entry and creates replacement scoped to token project', async () => {
    const { client, insertCalls, baseChain } = buildSupersedeClient();

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

    // The mark-superseded UPDATE must hit the base table with v1 vocab — a view
    // update silently matches zero rows for next-gen types and would orphan the
    // already-created replacement (B-418).
    expect(baseChain.update).toHaveBeenCalledWith({ status: 'Superseded', superseded_by: 'ke-new' });

    // Replacement insert must carry the token's project_id
    const replacementInsert = insertCalls.find((r) => r.title === 'Use TypeScript strict mode v2');
    expect(replacementInsert).toBeDefined();
    expect(replacementInsert.project_id).toBe(PROJECT_ID);
  });

  it('replacement inherits token project_id even when existing entry has no project_id', async () => {
    // Simulate a legacy existing entry whose project_id is missing
    const legacyExisting = { ...existingEntry, project_id: undefined as any };
    const { client, insertCalls } = buildSupersedeClient({ existing: legacyExisting });

    await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-1',
      new_title: 'Use TypeScript strict mode v2',
      new_content: 'Updated content.',
    });

    const replacementInsert = insertCalls.find((r) => r.title === 'Use TypeScript strict mode v2');
    expect(replacementInsert.project_id).toBe(PROJECT_ID);
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

  it('embeds the replacement entry (transitive via createKnowledgeEntry) [B-401]', async () => {
    const existing = { ...sampleFullEntry, id: 'ke-old' };
    const replacement = { ...sampleFullEntry, id: 'ke-repl', title: 'New ruling', content: 'updated body' };
    const supersededRow = { ...existing, status: 'Superseded', superseded_by: 'ke-repl' };
    const { client, baseChain } = buildEmbedAwareClient({
      viewResult: { data: replacement },  // createKnowledgeEntry: insert echo
      baseResult: [
        { data: existing },      // getKnowledgeEntry: fetch the old entry
        { data: replacement },   // createKnowledgeEntry: re-read (B-415) — same row is authoritative here
        { data: supersededRow }, // mark the old entry superseded
      ],
    });

    const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-old', new_title: 'New ruling', new_content: 'updated body',
    });

    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: 'New ruling\nupdated body' } });
    expect(baseChain.update).toHaveBeenCalledWith({ embedding: '[0.1,0.2]' });
    expect(baseChain.eq).toHaveBeenCalledWith('id', 'ke-repl');
    expect(result.replacement.id).toBe('ke-repl');
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
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'ent-new' }, error: null });
    const client: any = { from: vi.fn().mockImplementation(() => (call++ === 0 ? lookup : ins)) };

    const id = await resolveOrCreateEntity(client, WORKSPACE_ID, PROJECT_ID, 'OIDC', 'concept');
    expect(id).toBe('ent-new');
    expect(ins.insert).toHaveBeenCalledWith(
      expect.objectContaining({ workspace_id: WORKSPACE_ID, kind: 'concept', name: 'OIDC' }),
    );
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

  it('writes a decision defaulting status=Asserted and stamps token project + author', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: decisionRow });
    const result = await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'technical-design',
      title: 'Adopt RRF for hybrid search',
      domain: ['engineering'],
      madr: { context: 'why' },
      source_activity: 'design-decide',
    });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_decisions');
    expect(secondChain.insert).toHaveBeenCalledWith(expect.objectContaining({
      workspace_id: WORKSPACE_ID, project_id: PROJECT_ID, type: 'technical-design',
      title: 'Adopt RRF for hybrid search', status: 'Asserted', domain: ['engineering'],
      source_activity: 'design-decide', created_by: USER_ID,
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
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: decisionRow });
    (client as any).functions = { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.1, 0.2], stub: true }, error: null }) };
    await recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'Adopt RRF' });
    expect((client as any).functions.invoke).toHaveBeenCalledWith('embed-knowledge', { body: { text: expect.stringContaining('Adopt RRF') } });
    expect(secondChain.insert).toHaveBeenCalledWith(expect.objectContaining({ embedding: '[0.1,0.2]' }));
  });

  it('still writes the decision when embedding fails (embedding omitted, best-effort)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: decisionRow });
    (client as any).functions = { invoke: vi.fn().mockResolvedValue({ data: null, error: { message: 'down' } }) };
    await recordDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'Adopt RRF' });
    expect(secondChain.insert.mock.calls[0][0]).not.toHaveProperty('embedding');
  });

  it('persists review_by on the decision row (P4 F2 — research freshness)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({
      data: { ...decisionRow, source_type: 'research', review_by: '2026-08-27T00:00:00Z' },
    });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'specification', title: 'researched finding', source_type: 'research',
      review_by: '2026-08-27T00:00:00Z',
    });
    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ review_by: '2026-08-27T00:00:00Z', source_type: 'research' }),
    );
  });

  it('persists the realization axis when provided (B-400)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({
      data: { ...decisionRow, realization: 'agreed' },
    });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'technical-design', title: 'decided not yet built', realization: 'agreed',
    });
    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ realization: 'agreed' }),
    );
  });

  it('omits realization from the insert when not provided (NULL ≡ live, B-400)', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: decisionRow });
    await recordDecision(client, PROJECT_ID, USER_ID, {
      type: 'business', title: 'no realization given',
    });
    expect(secondChain.insert.mock.calls[0][0]).not.toHaveProperty('realization');
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
  it('creates the replacement then marks the old decision Superseded with superseded_by', async () => {
    // from() calls: 1 supersede getWorkspaceId -> 2 fetch existing -> 3 recordDecision getWorkspaceId -> 4 recordDecision insert -> 5 update old
    const replacement = { id: 'dec-2', title: 'v2', status: 'Asserted', type: 'business' };
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: 'dec-2' };
    const responses = [
      { data: { workspace_id: WORKSPACE_ID } },   // 1 supersede getWorkspaceId
      { data: { id: 'dec-1' } },                   // 2 fetch existing (found)
      { data: { workspace_id: WORKSPACE_ID } },    // 3 recordDecision getWorkspaceId
      { data: replacement },                        // 4 recordDecision insert
      { data: supersededOld },                      // 5 update old
    ];
    let i = 0;
    const make = (idx: number) => {
      const r = responses[idx] ?? { data: null };
      const c: any = {};
      c.select = vi.fn().mockReturnValue(c);
      c.insert = vi.fn().mockReturnValue(c);
      c.update = vi.fn().mockReturnValue(c);
      c.eq = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: r.data, error: null });
      return c;
    };
    const client: any = { from: vi.fn().mockImplementation(() => make(i++)) };

    const result = await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1',
      type: 'business',
      title: 'v2',
      reason: 'pricing changed',
    });
    expect(result.replacement.id).toBe('dec-2');
    expect(result.superseded.status).toBe('Superseded');
    expect(result.superseded.superseded_by).toBe('dec-2');
  });

  it('throws when old_decision_id is missing', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { type: 'business', title: 'v2' } as any),
    ).rejects.toThrow('old_decision_id is required');
  });

  it('throws on a missing old_decision_id without creating an orphan replacement', async () => {
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const lookup: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    lookup.select.mockReturnValue(lookup); lookup.eq.mockReturnValue(lookup);
    lookup.single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } });
    const insert = vi.fn();
    let i = 0;
    const client: any = { from: vi.fn().mockImplementation(() => ([ws, lookup][i++] ?? { insert })) };
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'missing', type: 'business', title: 'v2' }),
    ).rejects.toThrow('not found');
    expect(insert).not.toHaveBeenCalled();   // no replacement created
  });

  it('retire-mode (B-534): omitting BOTH type+title marks the old decision Superseded with superseded_by=null and creates NO successor', async () => {
    // from() calls in retire-mode: 1 getWorkspaceId -> 2 fetch existing -> 3 update old.
    // recordDecision is NEVER called (no successor), so there is no .insert and no extra getWorkspaceId.
    const supersededOld = { id: 'dec-1', status: 'Superseded', superseded_by: null };
    const responses = [
      { data: { workspace_id: WORKSPACE_ID } },   // 1 getWorkspaceId
      { data: { id: 'dec-1' } },                   // 2 fetch existing (found)
      { data: supersededOld },                     // 3 update old
    ];
    const inserts: any[] = [];
    const updates: any[] = [];
    let i = 0;
    const make = (idx: number) => {
      const r = responses[idx] ?? { data: null };
      const c: any = {};
      c.select = vi.fn().mockReturnValue(c);
      c.insert = vi.fn().mockImplementation((row: any) => { inserts.push(row); return c; });
      c.update = vi.fn().mockImplementation((row: any) => { updates.push(row); return c; });
      c.eq = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: r.data, error: null });
      return c;
    };
    const client: any = { from: vi.fn().mockImplementation(() => make(i++)) };

    const result = await supersedeDecision(client, PROJECT_ID, USER_ID, {
      old_decision_id: 'dec-1',
      reason: 'backing the ticket up to re-clarify natively — successor authored later, not here',
    });

    expect(result.replacement).toBeNull();                                   // NO successor
    expect(result.superseded.status).toBe('Superseded');
    expect(result.superseded.superseded_by).toBeNull();
    expect(inserts).toHaveLength(0);                                         // recordDecision never ran
    expect(updates[0]).toEqual({ status: 'Superseded', superseded_by: null });
    expect(client.from).toHaveBeenCalledTimes(3);                           // getWorkspaceId + fetch + update only
  });

  it('throws when exactly ONE of type/title is provided (ambiguous — B-534), before touching the DB', async () => {
    const client: any = { from: vi.fn() };
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'dec-1', type: 'business' }),
    ).rejects.toThrow(/exactly one of type\/title|retire/i);
    await expect(
      supersedeDecision(client, PROJECT_ID, USER_ID, { old_decision_id: 'dec-1', title: 'v2' }),
    ).rejects.toThrow(/exactly one of type\/title|retire/i);
    expect(client.from).not.toHaveBeenCalled();   // validation precedes any DB access
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
  it('resolves the subject entity then inserts an Asserted fact with provenance', async () => {
    // from(): 1 getWorkspaceId -> 2 entity lookup(maybeSingle hit) -> 3 fact insert
    const entityHit: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    entityHit.select.mockReturnValue(entityHit); entityHit.eq.mockReturnValue(entityHit);
    entityHit.maybeSingle.mockResolvedValue({ data: { id: 'ent-1' }, error: null });
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const factRow = { id: 'fact-1', subject_entity_id: 'ent-1', predicate: 'uses', status: 'Asserted' };
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: factRow, error: null });
    let i = 0;
    const client: any = { from: vi.fn().mockImplementation(() => [ws, entityHit, ins][i++]) };

    const result = await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'uses', object: 'HSL tokens', source_type: 'ticket', source_id: 'task-9',
    });
    expect(ins.insert).toHaveBeenCalledWith(expect.objectContaining({
      subject_entity_id: 'ent-1', predicate: 'uses', object: 'HSL tokens', source_type: 'ticket', status: 'Asserted', created_by: USER_ID,
    }));
    expect(result).toEqual(factRow);
  });

  it('throws when source_type is missing (provenance is required)', async () => {
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      assertFact(client, PROJECT_ID, USER_ID, { subject_entity: 'x', predicate: 'uses', object: 1 } as any),
    ).rejects.toThrow('source_type is required');
  });

  it('passes a structured (non-scalar) object through to the insert unchanged', async () => {
    const entityHit: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    entityHit.select.mockReturnValue(entityHit); entityHit.eq.mockReturnValue(entityHit);
    entityHit.maybeSingle.mockResolvedValue({ data: { id: 'ent-1' }, error: null });
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'fact-2' }, error: null });
    let i = 0;
    const client: any = { from: vi.fn().mockImplementation(() => [ws, entityHit, ins][i++]) };
    await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'configured_by', object: { ref: 'ent-2', weight: 3 }, source_type: 'manual',
    });
    expect(ins.insert).toHaveBeenCalledWith(expect.objectContaining({ object: { ref: 'ent-2', weight: 3 } }));
  });

  it('embeds the fact on write and includes the pgvector literal', async () => {
    const entityHit: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    entityHit.select.mockReturnValue(entityHit); entityHit.eq.mockReturnValue(entityHit);
    entityHit.maybeSingle.mockResolvedValue({ data: { id: 'ent-1' }, error: null });
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'fact-1' }, error: null });
    let i = 0;
    const client: any = {
      from: vi.fn().mockImplementation(() => [ws, entityHit, ins][i++]),
      functions: { invoke: vi.fn().mockResolvedValue({ data: { embedding: [0.3, 0.4] }, error: null }) },
    };
    await assertFact(client, PROJECT_ID, USER_ID, { subject_entity: 'board', predicate: 'uses', object: 'x', source_type: 'manual' });
    expect(client.functions.invoke).toHaveBeenCalledWith('embed-knowledge', expect.objectContaining({ body: expect.objectContaining({ text: expect.stringContaining('board') }) }));
    expect(ins.insert).toHaveBeenCalledWith(expect.objectContaining({ embedding: '[0.3,0.4]' }));
  });

  it('persists review_by on the fact row (P4 F2 — research freshness)', async () => {
    const entityHit: any = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn() };
    entityHit.select.mockReturnValue(entityHit); entityHit.eq.mockReturnValue(entityHit);
    entityHit.maybeSingle.mockResolvedValue({ data: { id: 'ent-1' }, error: null });
    const ws: any = { select: vi.fn(), eq: vi.fn(), single: vi.fn() };
    ws.select.mockReturnValue(ws); ws.eq.mockReturnValue(ws);
    ws.single.mockResolvedValue({ data: { workspace_id: WORKSPACE_ID }, error: null });
    const ins: any = { insert: vi.fn(), select: vi.fn(), single: vi.fn() };
    ins.insert.mockReturnValue(ins); ins.select.mockReturnValue(ins);
    ins.single.mockResolvedValue({ data: { id: 'fact-3' }, error: null });
    let i = 0;
    const client: any = { from: vi.fn().mockImplementation(() => [ws, entityHit, ins][i++]) };
    await assertFact(client, PROJECT_ID, USER_ID, {
      subject_entity: 'board', predicate: 'uses', object: 'x', source_type: 'research',
      review_by: '2026-08-27T00:00:00Z',
    });
    expect(ins.insert).toHaveBeenCalledWith(
      expect.objectContaining({ review_by: '2026-08-27T00:00:00Z', source_type: 'research' }),
    );
  });
});

// ---------------------------------------------------------------------------
// invalidateFact
// ---------------------------------------------------------------------------

describe('invalidateFact', () => {
  it('sets valid_to + status Superseded on the fact', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: { id: 'fact-1', status: 'Superseded' } });
    secondChain.not = vi.fn().mockReturnValue(secondChain);
    await invalidateFact(client, PROJECT_ID, { fact_id: 'fact-1', reason: 'no longer true' });
    expect(client.from).toHaveBeenNthCalledWith(2, 'knowledge_facts');
    expect(secondChain.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'Superseded' }));
    const updateArg = secondChain.update.mock.calls[0][0];
    expect(updateArg).toHaveProperty('valid_to');
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
