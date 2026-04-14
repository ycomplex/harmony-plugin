import { resolveTaskId } from './resolve-task-id.js';
export const listTestCasesTool = {
    name: 'list_test_cases',
    description: 'List test cases for a task',
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
export async function listTestCases(client, projectId, args) {
    const resolvedId = await resolveTaskId(client, projectId, args.task_id);
    const { data, error } = await client
        .from('test_cases')
        .select('id, name, type, position, created_by, created_at')
        .eq('task_id', resolvedId)
        .order('position', { ascending: true });
    if (error)
        throw error;
    return data;
}
export const manageTestCasesTool = {
    name: 'manage_test_cases',
    description: 'Add, update, or delete test cases on a task. Supports batch operations.',
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
                        name: { type: 'string', description: 'Test case name' },
                        type: { type: 'string', description: 'Test case type (e.g., "manual", "automated")' },
                    },
                    required: ['name'],
                },
                description: 'Test cases to add (appended in order)',
            },
            update: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string', description: 'Test case UUID' },
                        name: { type: 'string', description: 'New name' },
                        type: { type: 'string', description: 'New type' },
                    },
                    required: ['id'],
                },
                description: 'Test cases to update',
            },
            delete: {
                type: 'array',
                items: { type: 'string' },
                description: 'Test case UUIDs to delete',
            },
        },
        required: ['task_id'],
    },
};
export async function manageTestCases(client, projectId, userId, args) {
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
            .from('test_cases')
            .select('position')
            .eq('task_id', resolvedTaskId)
            .order('position', { ascending: false })
            .limit(1);
        maxPosition = existing?.[0]?.position ?? -1;
    }
    // Add test cases
    if (args.add && args.add.length > 0) {
        const rows = args.add.map((item, i) => ({
            task_id: resolvedTaskId,
            name: item.name,
            type: item.type ?? null,
            position: maxPosition + 1 + i,
            created_by: userId,
        }));
        const { data, error } = await client
            .from('test_cases')
            .insert(rows)
            .select();
        if (error)
            throw error;
        results.added = data ?? [];
    }
    // Update test cases
    if (args.update && args.update.length > 0) {
        for (const item of args.update) {
            const { id, ...updates } = item;
            const payload = {};
            if (updates.name !== undefined)
                payload.name = updates.name;
            if (updates.type !== undefined)
                payload.type = updates.type;
            if (Object.keys(payload).length === 0)
                continue;
            const { data, error } = await client
                .from('test_cases')
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
    // Delete test cases
    if (args.delete && args.delete.length > 0) {
        const { error } = await client
            .from('test_cases')
            .delete()
            .in('id', args.delete)
            .eq('task_id', resolvedTaskId);
        if (error)
            throw error;
        results.deleted = args.delete;
    }
    return results;
}
//# sourceMappingURL=test-cases.js.map