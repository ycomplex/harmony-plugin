import { resolveTaskId } from './resolve-task-id.js';
export const manageTaskLabelsTool = {
    name: 'manage_labels',
    description: 'Add or remove labels on a task. Unlike update_task (which replaces all labels), this tool lets you add or remove specific labels without knowing the current set.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: {
                type: 'string',
                description: 'Task identifier — UUID, task number (e.g., 43), or visual ID (e.g., B-43)',
            },
            add: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs to add',
            },
            remove: {
                type: 'array',
                items: { type: 'string' },
                description: 'Label IDs to remove',
            },
        },
        required: ['task_id'],
    },
};
export async function manageTaskLabels(client, projectId, args) {
    const taskId = await resolveTaskId(client, projectId, args.task_id);
    const results = {
        added: [],
        removed: [],
    };
    // Add labels
    if (args.add && args.add.length > 0) {
        const rows = args.add.map((labelId) => ({
            task_id: taskId,
            label_id: labelId,
        }));
        const { error } = await client.from('task_labels').insert(rows).select();
        if (error)
            throw error;
        results.added = args.add;
    }
    // Remove labels
    if (args.remove && args.remove.length > 0) {
        const { error } = await client
            .from('task_labels')
            .delete()
            .eq('task_id', taskId)
            .in('label_id', args.remove);
        if (error)
            throw error;
        results.removed = args.remove;
    }
    return results;
}
//# sourceMappingURL=task-labels.js.map