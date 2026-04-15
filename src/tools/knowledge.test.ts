import { describe, it, expect, vi } from 'vitest';
import {
  queryKnowledge,
  getKnowledgeEntry,
  createKnowledgeEntry,
  updateKnowledgeEntry,
  supersedeKnowledgeEntry,
} from './knowledge.js';

const PROJECT_ID = 'proj-abc-123';
const WORKSPACE_ID = 'ws-xyz-456';
const USER_ID = 'user-abc-123';

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/**
 * Creates a chainable mock that resolves at .order() (used by queryKnowledge).
 * Also supports .range() as the terminal call if needed.
 */
function createMockOrderClient(data: any[] | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.contains = vi.fn().mockReturnValue(chain);
  chain.or = vi.fn().mockReturnValue(chain);
  chain.ilike = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockReturnValue(chain);
  chain.range = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

/** Creates a chainable mock that resolves at .single() */
function createMockSingleClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

/** Creates a chainable mock for insert().select().single() */
function createMockInsertClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

/** Creates a chainable mock for update().eq().select().single() */
function createMockUpdateClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

/**
 * Creates a multi-call mock client that returns different responses per .from() call.
 * Calls are matched in order against the `responses` array.
 */
function createMultiCallClient(responses: Array<{ data: any; error?: any }>) {
  let callIndex = 0;

  const makeChain = (responseIndex: number) => {
    const chain: any = {};
    const response = responses[responseIndex] ?? { data: null };

    // Build a universal chain — terminal call resolves with the response
    chain.from = vi.fn().mockReturnValue(chain);
    chain.select = vi.fn().mockReturnValue(chain);
    chain.insert = vi.fn().mockReturnValue(chain);
    chain.update = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.single = vi.fn().mockResolvedValue({ data: response.data, error: response.error ?? null });
    return chain;
  };

  const root: any = {
    from: vi.fn().mockImplementation(() => {
      const chain = makeChain(callIndex);
      callIndex++;
      // re-wire from on chain so subsequent froms also advance
      chain.from = vi.fn().mockImplementation(() => {
        const inner = makeChain(callIndex);
        callIndex++;
        return inner;
      });
      return chain;
    }),
  };

  return root;
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleWorkspaceRow = { workspace_id: WORKSPACE_ID };

const sampleSummaries = [
  {
    id: 'ke-1',
    title: 'Use TypeScript strict mode',
    type: 'convention',
    status: 'accepted',
    tags: ['typescript'],
    project_id: null,
    updated_at: '2026-03-10T00:00:00Z',
  },
  {
    id: 'ke-2',
    title: 'PostgreSQL for all persistence',
    type: 'architecture',
    status: 'accepted',
    tags: ['database'],
    project_id: PROJECT_ID,
    updated_at: '2026-03-12T00:00:00Z',
  },
];

const sampleFullEntry = {
  id: 'ke-1',
  workspace_id: WORKSPACE_ID,
  project_id: null,
  title: 'Use TypeScript strict mode',
  content: 'We use TypeScript strict mode across all projects.',
  type: 'convention',
  status: 'accepted',
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
  // We'll track calls manually
  let fromCallCount = 0;

  // Workspace id chain
  const wsChain: any = {};
  wsChain.select = vi.fn().mockReturnValue(wsChain);
  wsChain.eq = vi.fn().mockReturnValue(wsChain);
  wsChain.single = vi.fn().mockResolvedValue({ data: sampleWorkspaceRow, error: null });

  // Second chain (query / insert / update)
  const secondChain: any = {};
  secondChain.select = vi.fn().mockReturnValue(secondChain);
  secondChain.insert = vi.fn().mockReturnValue(secondChain);
  secondChain.update = vi.fn().mockReturnValue(secondChain);
  secondChain.eq = vi.fn().mockReturnValue(secondChain);
  secondChain.contains = vi.fn().mockReturnValue(secondChain);
  secondChain.or = vi.fn().mockReturnValue(secondChain);
  secondChain.order = vi.fn().mockReturnValue(secondChain);
  secondChain.range = vi
    .fn()
    .mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null });
  secondChain.single = vi
    .fn()
    .mockResolvedValue({ data: secondResponse.data, error: secondResponse.error ?? null });

  const client: any = {
    from: vi.fn().mockImplementation(() => {
      fromCallCount++;
      return fromCallCount === 1 ? wsChain : secondChain;
    }),
  };

  return { client, wsChain, secondChain };
}

// ---------------------------------------------------------------------------
// queryKnowledge
// ---------------------------------------------------------------------------

describe('queryKnowledge', () => {
  it('applies default filters (status=accepted, no type/tags)', async () => {
    const { client, wsChain, secondChain } = buildWorkspaceAndQueryClient({
      data: sampleSummaries,
    });

    const result = await queryKnowledge(client, PROJECT_ID, {});

    // workspace lookup
    expect(client.from).toHaveBeenNthCalledWith(1, 'projects');
    expect(wsChain.select).toHaveBeenCalledWith('workspace_id');
    expect(wsChain.eq).toHaveBeenCalledWith('id', PROJECT_ID);

    // knowledge query
    expect(client.from).toHaveBeenNthCalledWith(2, 'workspace_knowledge');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('status', 'accepted');
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

  it('applies project_id filter via .or()', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { project_id: 'proj-other' });
    expect(secondChain.or).toHaveBeenCalledWith(
      `project_id.eq.proj-other,project_id.is.null`,
    );
  });

  it('applies search filter via .or() ilike', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: [] });
    await queryKnowledge(client, PROJECT_ID, { search: 'postgres' });
    expect(secondChain.or).toHaveBeenCalledWith(
      `title.ilike.%postgres%,content.ilike.%postgres%`,
    );
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
});

// ---------------------------------------------------------------------------
// getKnowledgeEntry
// ---------------------------------------------------------------------------

describe('getKnowledgeEntry', () => {
  it('retrieves entry by entry_id', async () => {
    const { client, wsChain, secondChain } = buildWorkspaceAndQueryClient({
      data: sampleFullEntry,
    });

    const result = await getKnowledgeEntry(client, PROJECT_ID, { entry_id: 'ke-1' });

    expect(client.from).toHaveBeenNthCalledWith(1, 'projects');
    expect(wsChain.eq).toHaveBeenCalledWith('id', PROJECT_ID);
    expect(client.from).toHaveBeenNthCalledWith(2, 'workspace_knowledge');
    expect(secondChain.eq).toHaveBeenCalledWith('workspace_id', WORKSPACE_ID);
    expect(secondChain.eq).toHaveBeenCalledWith('id', 'ke-1');
    expect(result).toEqual(sampleFullEntry);
  });

  it('retrieves entry by title', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: sampleFullEntry });
    await getKnowledgeEntry(client, PROJECT_ID, { title: 'Use TypeScript strict mode' });
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

  it('throws on Supabase error', async () => {
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
    project_id: null,
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

  it('creates an entry with required fields and defaults status to draft', async () => {
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
        title: 'New Convention',
        content: 'Always use const for variables.',
        type: 'convention',
        status: 'draft',
        created_by: USER_ID,
      }),
    );
    expect(result).toEqual(newEntry);
  });

  it('accepts optional fields: status, tags, project_id, source_task_id', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: newEntry });
    await createKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      title: 'New Convention',
      content: 'content',
      type: 'convention',
      status: 'accepted',
      tags: ['tag1'],
      project_id: PROJECT_ID,
      source_task_id: 'task-1',
    });

    expect(secondChain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'accepted',
        tags: ['tag1'],
        project_id: PROJECT_ID,
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

  it('updates by entry_id', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    const result = await updateKnowledgeEntry(client, PROJECT_ID, {
      entry_id: 'ke-1',
      new_title: 'Updated Title',
    });

    expect(client.from).toHaveBeenNthCalledWith(2, 'workspace_knowledge');
    expect(secondChain.update).toHaveBeenCalledWith(expect.objectContaining({ title: 'Updated Title' }));
    expect(secondChain.eq).toHaveBeenCalledWith('id', 'ke-1');
    expect(result).toEqual(updatedEntry);
  });

  it('updates by title', async () => {
    const { client, secondChain } = buildWorkspaceAndQueryClient({ data: updatedEntry });
    await updateKnowledgeEntry(client, PROJECT_ID, {
      title: 'Use TypeScript strict mode',
      content: 'new content',
    });
    expect(secondChain.eq).toHaveBeenCalledWith('title', 'Use TypeScript strict mode');
  });

  it('can update content, type, status, and tags', async () => {
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
        status: 'accepted',
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
    status: 'accepted',
  };
  const supersededEntry = {
    ...sampleFullEntry,
    status: 'superseded',
    superseded_by: 'ke-new',
  };

  /**
   * supersedeKnowledgeEntry makes these .from() calls:
   * 1. getKnowledgeEntry ws lookup  (projects → single)
   * 2. getKnowledgeEntry fetch  (workspace_knowledge → single)
   * 3. createKnowledgeEntry ws lookup  (projects → single)
   * 4. createKnowledgeEntry insert  (workspace_knowledge → insert → single)
   * 5. supersede's own getWorkspaceId  (projects → single)
   * 6. supersede direct update  (workspace_knowledge → update → single)
   *
   * We use a call-ordered multi-response client instead of the two-chain helper.
   */

  function buildSupersedeClient() {
    // Responses in call order (each .from() call gets the next response)
    const responses = [
      { data: sampleWorkspaceRow },           // 1. getKnowledgeEntry ws lookup
      { data: existingEntry },                // 2. getKnowledgeEntry fetch
      { data: sampleWorkspaceRow },           // 3. createKnowledgeEntry ws lookup
      { data: replacementEntry },             // 4. createKnowledgeEntry insert
      { data: sampleWorkspaceRow },           // 5. supersede's own getWorkspaceId
      { data: supersededEntry },              // 6. supersede direct update
    ];

    let fromCallCount = 0;

    const makeChain = (idx: number) => {
      const r = responses[idx] ?? { data: null };
      const c: any = {};
      c.select = vi.fn().mockReturnValue(c);
      c.insert = vi.fn().mockReturnValue(c);
      c.update = vi.fn().mockReturnValue(c);
      c.eq = vi.fn().mockReturnValue(c);
      c.single = vi.fn().mockResolvedValue({ data: r.data, error: (r as any).error ?? null });
      return c;
    };

    const client: any = {
      from: vi.fn().mockImplementation(() => {
        const chain = makeChain(fromCallCount);
        fromCallCount++;
        return chain;
      }),
    };

    return client;
  }

  it('supersedes old entry and creates replacement', async () => {
    const client = buildSupersedeClient();

    const result = await supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
      entry_id: 'ke-1',
      new_title: 'Use TypeScript strict mode v2',
      new_content: 'Updated content for strict mode.',
    });

    expect(result.superseded.status).toBe('superseded');
    expect(result.superseded.superseded_by).toBe('ke-new');
    expect(result.replacement.id).toBe('ke-new');
    expect(result.replacement.status).toBe('accepted');
  });

  it('throws when neither entry_id nor title provided to identify old entry', async () => {
    // ws lookup will succeed but validation happens before queries
    const { client } = buildWorkspaceAndQueryClient({ data: null });
    await expect(
      supersedeKnowledgeEntry(client, PROJECT_ID, USER_ID, {
        new_title: 'New',
        new_content: 'content',
      }),
    ).rejects.toThrow('Either entry_id or title must be provided');
  });
});
