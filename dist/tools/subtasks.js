import { resolveTaskId } from './resolve-task-id.js';
export const listSubtasksTool = {
    name: 'list_subtasks',
    description: 'List subtasks for a task',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
            },
        },
        required: ['task_id'],
    },
};
export async function listSubtasks(client, projectId, args) {
    const resolvedId = await resolveTaskId(client, projectId, args.task_id);
    const { data, error } = await client
        .from('subtasks')
        .select('id, title, completed, position, created_by, created_at')
        .eq('task_id', resolvedId)
        .order('position', { ascending: true });
    if (error)
        throw error;
    return data;
}
export const manageSubtasksTool = {
    name: 'manage_subtasks',
    description: 'Add, update, or delete subtasks on a task. Supports batch operations.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
            },
            add: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: 'Subtask title' },
                    },
                    required: ['title'],
                },
                description: 'Subtasks to add (appended in order)',
            },
            update: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Subtask UUID' },
                        title: { type: 'string', description: 'New title' },
                        completed: { type: 'boolean', description: 'New completion state' },
                    },
                    required: ['id'],
                },
                description: 'Subtasks to update',
            },
            delete: {
                type: 'array',
                items: { type: 'string' },
                description: 'Subtask UUIDs to delete',
            },
        },
        required: ['task_id'],
    },
};
export async function manageSubtasks(client, projectId, userId, args) {
    const resolvedTaskId = await resolveTaskId(client, projectId, args.task_id);
    const results = {
        added: [],
        updated: [],
        deleted: [],
    };
    // Get current max position for appending
    let maxPosition = -1;
    if (args.add && args.add.length > 0) {
        const { data: existing } = await client
            .from('subtasks')
            .select('position')
            .eq('task_id', resolvedTaskId)
            .order('position', { ascending: false })
            .limit(1);
        maxPosition = existing?.[0]?.position ?? -1;
    }
    // Add subtasks
    if (args.add && args.add.length > 0) {
        const rows = args.add.map((item, i) => ({
            task_id: resolvedTaskId,
            title: item.title,
            position: maxPosition + 1 + i,
            created_by: userId,
        }));
        const { data, error } = await client
            .from('subtasks')
            .insert(rows)
            .select();
        if (error)
            throw error;
        results.added = data ?? [];
    }
    // Update subtasks
    if (args.update && args.update.length > 0) {
        for (const item of args.update) {
            const { id, ...updates } = item;
            const payload = {};
            if (updates.title !== undefined)
                payload.title = updates.title;
            if (updates.completed !== undefined)
                payload.completed = updates.completed;
            if (Object.keys(payload).length === 0)
                continue;
            const { data, error } = await client
                .from('subtasks')
                .update(payload)
                .eq('id', id)
                .eq('task_id', resolvedTaskId)
                .select()
                .single();
            if (error)
                throw error;
            results.updated.push(data);
        }
    }
    // Delete subtasks
    if (args.delete && args.delete.length > 0) {
        const { error } = await client
            .from('subtasks')
            .delete()
            .in('id', args.delete)
            .eq('task_id', resolvedTaskId);
        if (error)
            throw error;
        results.deleted = args.delete;
    }
    return results;
}
//# sourceMappingURL=subtasks.js.map