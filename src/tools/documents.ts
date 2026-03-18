import type { SupabaseClient } from '@supabase/supabase-js';

export const listProjectDocumentsTool = {
  name: 'list_project_documents',
  description:
    'List all documents for the current project. Returns titles and IDs — use get_project_document to retrieve full content. Documents contain product context: PRDs, architecture notes, user feedback, etc.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
  },
};

export interface ProjectDocumentSummary {
  id: string;
  title: string;
  updated_at: string;
}

export async function listProjectDocuments(
  client: SupabaseClient,
  projectId: string,
): Promise<ProjectDocumentSummary[]> {
  const { data, error } = await client
    .from('project_documents')
    .select('id, title, updated_at')
    .eq('project_id', projectId)
    .order('title', { ascending: true });
  if (error) throw error;
  return data as ProjectDocumentSummary[];
}

export const getProjectDocumentTool = {
  name: 'get_project_document',
  description:
    'Get the full content of a project document by ID or title. Documents are markdown.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      document_id: { type: 'string', description: 'Document UUID' },
      title: { type: 'string', description: 'Document title (exact match)' },
    },
  },
};

export interface ProjectDocument {
  id: string;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

export async function getProjectDocument(
  client: SupabaseClient,
  projectId: string,
  args: { document_id?: string; title?: string },
): Promise<ProjectDocument> {
  if (!args.document_id && !args.title) {
    throw new Error('Either document_id or title must be provided');
  }

  let query = client
    .from('project_documents')
    .select('id, title, content, created_at, updated_at')
    .eq('project_id', projectId);

  if (args.document_id) {
    query = query.eq('id', args.document_id);
  } else {
    query = query.eq('title', args.title!);
  }

  const { data, error } = await query.single();
  if (error) throw error;
  return data as ProjectDocument;
}

export const createProjectDocumentTool = {
  name: 'create_project_document',
  description:
    'Create a new project document. Documents are markdown and must have a unique title within the project. Use for PRDs, architecture notes, meeting notes, etc.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Document title (must be unique within the project)' },
      content: { type: 'string', description: 'Markdown content of the document' },
    },
    required: ['title', 'content'],
  },
};

export async function createProjectDocument(
  client: SupabaseClient,
  projectId: string,
  userId: string,
  args: { title: string; content: string },
): Promise<ProjectDocument> {
  if (!args.title?.trim()) {
    throw new Error('title is required');
  }

  const { data, error } = await client
    .from('project_documents')
    .insert({
      project_id: projectId,
      title: args.title.trim(),
      content: args.content ?? '',
      created_by: userId,
    })
    .select('id, title, content, created_at, updated_at')
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new Error(`A document titled "${args.title.trim()}" already exists in this project`);
    }
    throw error;
  }
  return data as ProjectDocument;
}

export const updateProjectDocumentTool = {
  name: 'update_project_document',
  description:
    'Update an existing project document by ID or title. Can update the title, content, or both.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      document_id: { type: 'string', description: 'Document UUID' },
      title: { type: 'string', description: 'Current document title (used to find the document if document_id not provided)' },
      new_title: { type: 'string', description: 'New title for the document' },
      content: { type: 'string', description: 'New markdown content' },
    },
  },
};

export async function updateProjectDocument(
  client: SupabaseClient,
  projectId: string,
  args: { document_id?: string; title?: string; new_title?: string; content?: string },
): Promise<ProjectDocument> {
  if (!args.document_id && !args.title) {
    throw new Error('Either document_id or title must be provided to identify the document');
  }
  if (args.new_title === undefined && args.content === undefined) {
    throw new Error('At least one of new_title or content must be provided');
  }

  const updates: Record<string, string> = {};
  if (args.new_title !== undefined) updates.title = args.new_title.trim();
  if (args.content !== undefined) updates.content = args.content;

  let query = client
    .from('project_documents')
    .update(updates)
    .eq('project_id', projectId);

  if (args.document_id) {
    query = query.eq('id', args.document_id);
  } else {
    query = query.eq('title', args.title!);
  }

  const { data, error } = await query
    .select('id, title, content, created_at, updated_at')
    .single();
  if (error) {
    if (error.code === '23505') {
      throw new Error(`A document titled "${updates.title}" already exists in this project`);
    }
    throw error;
  }
  return data as ProjectDocument;
}
