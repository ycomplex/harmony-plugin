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
