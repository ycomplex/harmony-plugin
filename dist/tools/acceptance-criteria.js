import { resolveTaskId } from './resolve-task-id.js';
export const listAcceptanceCriteriaTool = {
    name: 'list_acceptance_criteria',
    description: 'List acceptance criteria for a task',
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
export async function listAcceptanceCriteria(client, projectId, args) {
    const resolvedId = await resolveTaskId(client, projectId, args.task_id);
    const { data, error } = await client
        .from('acceptance_criteria')
        .select('id, content, checked, position, created_by, created_at')
        .eq('task_id', resolvedId)
        .order('position', { ascending: true });
    if (error)
        throw error;
    return data;
}
export const manageAcceptanceCriteriaTool = {
    name: 'manage_acceptance_criteria',
    description: 'Add, update, or delete acceptance criteria on a task. Supports batch operations.',
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
                        content: { type: 'string', description: 'Acceptance criterion content' },
                        checked: { type: 'boolean', description: 'Whether the criterion is met. Default false.' },
                    },
                    required: ['content'],
                },
                description: 'Acceptance criteria to add (appended in order)',
            },
            update: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Acceptance criterion UUID' },
                        content: { type: 'string', description: 'New content' },
                        checked: { type: 'boolean', description: 'New checked state' },
                    },
                    required: ['id'],
                },
                description: 'Acceptance criteria to update',
            },
            delete: {
                type: 'array',
                items: { type: 'string' },
                description: 'Acceptance criterion UUIDs to delete',
            },
        },
        required: ['task_id'],
    },
};
export async function manageAcceptanceCriteria(client, projectId, userId, args) {
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
            .from('acceptance_criteria')
            .select('position')
            .eq('task_id', resolvedTaskId)
            .order('position', { ascending: false })
            .limit(1);
        maxPosition = existing?.[0]?.position ?? -1;
    }
    // Add acceptance criteria
    if (args.add && args.add.length > 0) {
        const rows = args.add.map((item, i) => ({
            task_id: resolvedTaskId,
            content: item.content,
            checked: item.checked ?? false,
            position: maxPosition + 1 + i,
            created_by: userId,
        }));
        const { data, error } = await client
            .from('acceptance_criteria')
            .insert(rows)
            .select();
        if (error)
            throw error;
        results.added = data ?? [];
    }
    // Update acceptance criteria
    if (args.update && args.update.length > 0) {
        for (const item of args.update) {
            const { id, ...updates } = item;
            const payload = {};
            if (updates.content !== undefined)
                payload.content = updates.content;
            if (updates.checked !== undefined)
                payload.checked = updates.checked;
            if (Object.keys(payload).length === 0)
                continue;
            const { data, error } = await client
                .from('acceptance_criteria')
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
    // Delete acceptance criteria
    if (args.delete && args.delete.length > 0) {
        const { error } = await client
            .from('acceptance_criteria')
            .delete()
            .in('id', args.delete)
            .eq('task_id', resolvedTaskId);
        if (error)
            throw error;
        results.deleted = args.delete;
    }
    return results;
}
//# sourceMappingURL=acceptance-criteria.js.map