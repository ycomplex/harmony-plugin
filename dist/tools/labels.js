async function getWorkspaceIdForProject(client, projectId) {
    const { data, error } = await client
        .from('projects')
        .select('workspace_id')
        .eq('id', projectId)
        .single();
    if (error)
        throw error;
    return data.workspace_id;
}
export const listLabelsTool = {
    name: 'list_labels',
    description: 'List all labels in the workspace',
    inputSchema: {
        type: 'object',
        properties: {},
    },
};
export async function listLabels(client, projectId) {
    const workspaceId = await getWorkspaceIdForProject(client, projectId);
    const { data, error } = await client
        .from('labels')
        .select('id, name, color')
        .eq('workspace_id', workspaceId)
        .order('name');
    if (error)
        throw error;
    return data;
}
export const createLabelTool = {
    name: 'create_label',
    description: 'Create a new label in the workspace',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Label name' },
            color: { type: 'string', description: 'Color key (red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, pink). Defaults to blue.' },
        },
        required: ['name'],
    },
};
export async function createLabel(client, projectId, userId, args) {
    const workspaceId = await getWorkspaceIdForProject(client, projectId);
    const { data, error } = await client
        .from('labels')
        .insert({
        workspace_id: workspaceId,
        name: args.name,
        color: args.color ?? 'blue',
        created_by: userId,
    })
        .select('id, name, color')
        .single();
    if (error)
        throw error;
    return data;
}
//# sourceMappingURL=labels.js.map