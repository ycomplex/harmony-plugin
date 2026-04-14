export const listMilestonesTool = {
    name: 'list_milestones',
    description: 'List milestones in the project',
    inputSchema: {
        type: 'object',
        properties: {
            status: { type: 'string', enum: ['planning', 'shipped'], description: 'Filter by status. Optional.' },
        },
    },
};
export async function listMilestones(client, projectId, args) {
    let query = client
        .from('milestones')
        .select('*')
        .eq('project_id', projectId)
        .order('position');
    if (args.status)
        query = query.eq('status', args.status);
    const { data, error } = await query;
    if (error)
        throw error;
    return data;
}
export const createMilestoneTool = {
    name: 'create_milestone',
    description: 'Create a new milestone in the project',
    inputSchema: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Milestone name (e.g., "v1.2", "Beta Ready")' },
            description: { type: 'string', description: 'Description or release notes. Optional.' },
        },
        required: ['name'],
    },
};
export async function createMilestone(client, projectId, userId, args) {
    const { data, error } = await client
        .from('milestones')
        .insert({
        project_id: projectId,
        name: args.name,
        description: args.description ?? null,
        created_by: userId,
    })
        .select()
        .single();
    if (error)
        throw error;
    return data;
}
export const updateMilestoneTool = {
    name: 'update_milestone',
    description: "Update a milestone's name or description",
    inputSchema: {
        type: 'object',
        properties: {
            milestone_id: { type: 'string', description: 'Milestone ID' },
            name: { type: 'string', description: 'New name' },
            description: { type: 'string', description: 'New description' },
        },
        required: ['milestone_id'],
    },
};
export async function updateMilestone(client, projectId, args) {
    const updates = {};
    if (args.name !== undefined)
        updates.name = args.name;
    if (args.description !== undefined)
        updates.description = args.description;
    const { data, error } = await client
        .from('milestones')
        .update(updates)
        .eq('id', args.milestone_id)
        .eq('project_id', projectId)
        .select()
        .single();
    if (error)
        throw error;
    return data;
}
export const shipMilestoneTool = {
    name: 'ship_milestone',
    description: "Ship a milestone. Non-Done tasks are removed from the milestone (returned in response). Done tasks become hidden from board/list views.",
    inputSchema: {
        type: 'object',
        properties: {
            milestone_id: { type: 'string', description: 'Milestone ID' },
        },
        required: ['milestone_id'],
    },
};
export async function shipMilestone(client, projectId, args) {
    // Get project statuses to determine what "Done" means
    const { data: project } = await client
        .from('projects')
        .select('custom_statuses')
        .eq('id', projectId)
        .single();
    const statuses = project?.custom_statuses ?? ['Backlog', 'To Do', 'In Progress', 'In Review', 'Done'];
    const doneStatus = statuses[statuses.length - 1];
    // Get tasks in this milestone
    const { data: tasks } = await client
        .from('tasks')
        .select('id, status, title')
        .eq('milestone_id', args.milestone_id);
    const nonDone = (tasks ?? []).filter(t => t.status !== doneStatus);
    const done = (tasks ?? []).filter(t => t.status === doneStatus);
    // Remove non-Done tasks from milestone
    if (nonDone.length > 0) {
        await client
            .from('tasks')
            .update({ milestone_id: null })
            .in('id', nonDone.map(t => t.id));
    }
    // Ship the milestone
    const { data, error } = await client
        .from('milestones')
        .update({ status: 'shipped', shipped_at: new Date().toISOString() })
        .eq('id', args.milestone_id)
        .select()
        .single();
    if (error)
        throw error;
    return {
        milestone: data,
        shipped_task_count: done.length,
        removed_tasks: nonDone.map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
}
//# sourceMappingURL=milestones.js.map