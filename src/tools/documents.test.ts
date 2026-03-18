import { describe, it, expect, vi } from 'vitest';
import { listProjectDocuments, getProjectDocument, createProjectDocument, updateProjectDocument } from './documents.js';

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

const USER_ID = 'user-abc-123';

// Mock Supabase client for insert().select().single() chains
function createMockInsertClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

// Mock Supabase client for update().eq().select().single() chains
function createMockUpdateClient(data: any | null, error: any = null) {
  const chain: any = {};
  chain.from = vi.fn().mockReturnValue(chain);
  chain.update = vi.fn().mockReturnValue(chain);
  chain.eq = vi.fn().mockReturnValue(chain);
  chain.select = vi.fn().mockReturnValue(chain);
  chain.single = vi.fn().mockResolvedValue({ data, error });
  return chain;
}

describe('createProjectDocument', () => {
  const newDoc = {
    id: 'doc-new',
    title: 'New PRD',
    content: '# PRD\n\nDetails here.',
    created_at: '2026-03-18T00:00:00Z',
    updated_at: '2026-03-18T00:00:00Z',
  };

  it('creates a document with title and content', async () => {
    const client = createMockInsertClient(newDoc);
    const result = await createProjectDocument(client, PROJECT_ID, USER_ID, {
      title: 'New PRD',
      content: '# PRD\n\nDetails here.',
    });

    expect(client.from).toHaveBeenCalledWith('project_documents');
    expect(client.insert).toHaveBeenCalledWith({
      project_id: PROJECT_ID,
      title: 'New PRD',
      content: '# PRD\n\nDetails here.',
      created_by: USER_ID,
    });
    expect(client.select).toHaveBeenCalledWith('id, title, content, created_at, updated_at');
    expect(result).toEqual(newDoc);
  });

  it('trims whitespace from title', async () => {
    const client = createMockInsertClient(newDoc);
    await createProjectDocument(client, PROJECT_ID, USER_ID, {
      title: '  New PRD  ',
      content: 'content',
    });

    expect(client.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'New PRD' }),
    );
  });

  it('throws when title is empty', async () => {
    const client = createMockInsertClient(null);
    await expect(
      createProjectDocument(client, PROJECT_ID, USER_ID, { title: '  ', content: 'x' }),
    ).rejects.toThrow('title is required');
  });

  it('throws a friendly message on duplicate title', async () => {
    const client = createMockInsertClient(null, { code: '23505', message: 'unique violation' });
    await expect(
      createProjectDocument(client, PROJECT_ID, USER_ID, { title: 'Existing', content: 'x' }),
    ).rejects.toThrow('A document titled "Existing" already exists in this project');
  });

  it('throws on other Supabase errors', async () => {
    const client = createMockInsertClient(null, { message: 'DB failure' });
    await expect(
      createProjectDocument(client, PROJECT_ID, USER_ID, { title: 'Test', content: 'x' }),
    ).rejects.toThrow('DB failure');
  });
});

describe('updateProjectDocument', () => {
  const updatedDoc = {
    id: 'doc-1',
    title: 'Updated Title',
    content: '# Updated\n\nNew content.',
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-18T00:00:00Z',
  };

  it('updates content by document_id', async () => {
    const client = createMockUpdateClient(updatedDoc);
    const result = await updateProjectDocument(client, PROJECT_ID, {
      document_id: 'doc-1',
      content: '# Updated\n\nNew content.',
    });

    expect(client.from).toHaveBeenCalledWith('project_documents');
    expect(client.update).toHaveBeenCalledWith({ content: '# Updated\n\nNew content.' });
    expect(client.eq).toHaveBeenNthCalledWith(1, 'project_id', PROJECT_ID);
    expect(client.eq).toHaveBeenNthCalledWith(2, 'id', 'doc-1');
    expect(result).toEqual(updatedDoc);
  });

  it('updates title by current title', async () => {
    const client = createMockUpdateClient(updatedDoc);
    await updateProjectDocument(client, PROJECT_ID, {
      title: 'Old Title',
      new_title: 'Updated Title',
    });

    expect(client.update).toHaveBeenCalledWith({ title: 'Updated Title' });
    expect(client.eq).toHaveBeenNthCalledWith(2, 'title', 'Old Title');
  });

  it('updates both title and content', async () => {
    const client = createMockUpdateClient(updatedDoc);
    await updateProjectDocument(client, PROJECT_ID, {
      document_id: 'doc-1',
      new_title: 'Updated Title',
      content: 'new content',
    });

    expect(client.update).toHaveBeenCalledWith({ title: 'Updated Title', content: 'new content' });
  });

  it('throws when neither document_id nor title provided', async () => {
    const client = createMockUpdateClient(null);
    await expect(
      updateProjectDocument(client, PROJECT_ID, { content: 'x' }),
    ).rejects.toThrow('Either document_id or title must be provided');
  });

  it('throws when no update fields provided', async () => {
    const client = createMockUpdateClient(null);
    await expect(
      updateProjectDocument(client, PROJECT_ID, { document_id: 'doc-1' }),
    ).rejects.toThrow('At least one of new_title or content must be provided');
  });

  it('throws a friendly message on duplicate title', async () => {
    const client = createMockUpdateClient(null, { code: '23505', message: 'unique violation' });
    await expect(
      updateProjectDocument(client, PROJECT_ID, { document_id: 'doc-1', new_title: 'Taken' }),
    ).rejects.toThrow('A document titled "Taken" already exists in this project');
  });

  it('throws on other Supabase errors', async () => {
    const client = createMockUpdateClient(null, { message: 'DB failure' });
    await expect(
      updateProjectDocument(client, PROJECT_ID, { document_id: 'doc-1', content: 'x' }),
    ).rejects.toThrow('DB failure');
  });
});
