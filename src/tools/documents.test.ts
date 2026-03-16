import { describe, it, expect, vi } from 'vitest';
import { listProjectDocuments, getProjectDocument } from './documents.js';

const PROJECT_ID = 'proj-abc-123';

// Mock Supabase client for select queries ending with order()
function createMockSelectClient(data: any[] | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.order = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

// Mock Supabase client for select queries ending with single()
function createMockSingleClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

const sampleDocuments = [
  {
    id: 'doc-1',
    title: 'Architecture Notes',
    updated_at: '2026-03-10T00:00:00Z',
  },
  {
    id: 'doc-2',
    title: 'Product Brief',
    updated_at: '2026-03-12T00:00:00Z',
  },
];

const sampleFullDocument = {
  id: 'doc-1',
  title: 'Architecture Notes',
  content: '# Architecture\n\nSome markdown content here.',
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-10T00:00:00Z',
};

describe('listProjectDocuments', () => {
  it('returns documents sorted by title', async () => {
    const client = createMockSelectClient(sampleDocuments);
    const result = await listProjectDocuments(client, PROJECT_ID);

    expect(client.from).toHaveBeenCalledWith('project_documents');
    expect(client.select).toHaveBeenCalledWith('id, title, updated_at');
    expect(client.eq).toHaveBeenCalledWith('project_id', PROJECT_ID);
    expect(client.order).toHaveBeenCalledWith('title', { ascending: true });
    expect(result).toEqual(sampleDocuments);
  });

  it('returns empty array when no documents exist', async () => {
    const client = createMockSelectClient([]);
    const result = await listProjectDocuments(client, PROJECT_ID);
    expect(result).toEqual([]);
  });

  it('throws on Supabase error', async () => {
    const client = createMockSelectClient(null, { message: 'DB failure' });
    await expect(listProjectDocuments(client, PROJECT_ID)).rejects.toThrow('DB failure');
  });
});

describe('getProjectDocument', () => {
  it('retrieves document by ID', async () => {
    const client = createMockSingleClient(sampleFullDocument);
    const result = await getProjectDocument(client, PROJECT_ID, { document_id: 'doc-1' });

    expect(client.from).toHaveBeenCalledWith('project_documents');
    expect(client.select).toHaveBeenCalledWith('id, title, content, created_at, updated_at');
    expect(client.eq).toHaveBeenNthCalledWith(1, 'project_id', PROJECT_ID);
    expect(client.eq).toHaveBeenNthCalledWith(2, 'id', 'doc-1');
    expect(client.single).toHaveBeenCalled();
    expect(result).toEqual(sampleFullDocument);
  });

  it('retrieves document by title', async () => {
    const client = createMockSingleClient(sampleFullDocument);
    const result = await getProjectDocument(client, PROJECT_ID, { title: 'Architecture Notes' });

    expect(client.eq).toHaveBeenNthCalledWith(1, 'project_id', PROJECT_ID);
    expect(client.eq).toHaveBeenNthCalledWith(2, 'title', 'Architecture Notes');
    expect(result).toEqual(sampleFullDocument);
  });

  it('prefers document_id over title when both provided', async () => {
    const client = createMockSingleClient(sampleFullDocument);
    await getProjectDocument(client, PROJECT_ID, { document_id: 'doc-1', title: 'Architecture Notes' });

    expect(client.eq).toHaveBeenNthCalledWith(2, 'id', 'doc-1');
  });

  it('throws when neither document_id nor title provided', async () => {
    const client = createMockSingleClient(null);
    await expect(getProjectDocument(client, PROJECT_ID, {})).rejects.toThrow(
      'Either document_id or title must be provided',
    );
  });

  it('throws on Supabase error', async () => {
    const client = createMockSingleClient(null, { message: 'Not found' });
    await expect(
      getProjectDocument(client, PROJECT_ID, { document_id: 'doc-999' }),
    ).rejects.toThrow('Not found');
  });
});
