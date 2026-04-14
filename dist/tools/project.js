export const getProjectTool = {
    name: 'get_project',
    description: 'Get project details including statuses, field definitions, and epics',
    inputSchema: { type: 'object', properties: {} },
};
export async function getProject(client, projectId) {
    const { data, error } = await client
        .from('projects')
        .select('id, name, key, description, custom_statuses, field_definitions, archived')
        .eq('id', projectId)
        .single();
    if (error)
        throw error;
    return data;
}
//# sourceMappingURL=project.js.map