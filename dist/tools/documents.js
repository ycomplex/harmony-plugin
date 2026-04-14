export const listProjectDocumentsTool = {
    name: 'list_project_documents',
    description: 'List all documents for the current project. Returns titles and IDs — use get_project_document to retrieve full content. Documents contain product context: PRDs, architecture notes, user feedback, etc.',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};
export async function listProjectDocuments(client, projectId) {
    const { data, error } = await client
        .from('project_documents')
        .select('id, title, updated_at')
        .eq('project_id', projectId)
        .order('title', { ascending: true });
    if (error)
        throw error;
    return data;
}
export const getProjectDocumentTool = {
    name: 'get_project_document',
    description: 'Get the full content of a project document by ID or title. Documents are markdown.',
    inputSchema: {
        type: 'object',
        properties: {
            document_id: { type: 'string', description: 'Document UUID' },
            title: { type: 'string', description: 'Document title (exact match)' },
        },
    },
};
export async function getProjectDocument(client, projectId, args) {
    if (!args.document_id && !args.title) {
        throw new Error('Either document_id or title must be provided');
    }
    let query = client
        .from('project_documents')
        .select('id, title, content, created_at, updated_at')
        .eq('project_id', projectId);
    if (args.document_id) {
        query = query.eq('id', args.document_id);
    }
    else {
        query = query.eq('title', args.title);
    }
    const { data, error } = await query.single();
    if (error)
        throw error;
    return data;
}
export const createProjectDocumentTool = {
    name: 'create_project_document',
    description: 'Create a new project document. Documents are markdown and must have a unique title within the project. Use for PRDs, architecture notes, meeting notes, etc.',
    inputSchema: {
        type: 'object',
        properties: {
            title: { type: 'string', description: 'Document title (must be unique within the project)' },
            content: { type: 'string', description: 'Markdown content of the document' },
        },
        required: ['title', 'content'],
    },
};
export async function createProjectDocument(client, projectId, userId, args) {
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
    return data;
}
export const updateProjectDocumentTool = {
    name: 'update_project_document',
    description: 'Update an existing project document by ID or title. Can update the title, content, or both.',
    inputSchema: {
        type: 'object',
        properties: {
            document_id: { type: 'string', description: 'Document UUID' },
            title: { type: 'string', description: 'Current document title (used to find the document if document_id not provided)' },
            new_title: { type: 'string', description: 'New title for the document' },
            content: { type: 'string', description: 'New markdown content' },
        },
    },
};
export async function updateProjectDocument(client, projectId, args) {
    if (!args.document_id && !args.title) {
        throw new Error('Either document_id or title must be provided to identify the document');
    }
    if (args.new_title === undefined && args.content === undefined) {
        throw new Error('At least one of new_title or content must be provided');
    }
    const updates = {};
    if (args.new_title !== undefined)
        updates.title = args.new_title.trim();
    if (args.content !== undefined)
        updates.content = args.content;
    let query = client
        .from('project_documents')
        .update(updates)
        .eq('project_id', projectId);
    if (args.document_id) {
        query = query.eq('id', args.document_id);
    }
    else {
        query = query.eq('title', args.title);
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
    return data;
}
//# sourceMappingURL=documents.js.map