import { resolveTaskId } from './resolve-task-id.js';
export const listActivityTool = {
    name: 'list_activity',
    description: 'List the activity timeline for a task — merges system events (field changes, moves, label/subtask changes) with comments in chronological order.',
    inputSchema: {
        type: 'object',
        properties: {
            task_id: { type: 'string', description: 'Task identifier — UUID, task number, or visual ID (e.g., B-42)' },
        },
        required: ['task_id'],
    },
};
export async function listActivity(client, projectId, args) {
    const taskId = await resolveTaskId(client, projectId, args.task_id);
    const [eventsResult, commentsResult] = await Promise.all([
        client
            .from('activity_events')
            .select('*, author:profiles!activity_events_user_id_fkey(display_name, email)')
            .eq('task_id', taskId)
            .order('created_at', { ascending: true }),
        client
            .from('task_comments')
            .select('id, content, created_at, updated_at, author:profiles!task_comments_user_id_fkey(display_name, email)')
            .eq('task_id', taskId)
            .order('created_at', { ascending: true }),
    ]);
    if (eventsResult.error)
        throw eventsResult.error;
    if (commentsResult.error)
        throw commentsResult.error;
    const timeline = [
        ...eventsResult.data.map((e) => ({
            type: 'event',
            timestamp: e.created_at,
            user_name: e.author?.display_name ?? e.author?.email ?? null,
            event_type: e.event_type,
            field_name: e.field_name,
            old_value: e.old_value,
            new_value: e.new_value,
            metadata: e.metadata,
        })),
        ...commentsResult.data.map((c) => ({
            type: 'comment',
            timestamp: c.created_at,
            user_name: c.author?.display_name ?? c.author?.email ?? null,
            comment_id: c.id,
            content: c.content,
        })),
    ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return timeline;
}
//# sourceMappingURL=activity.js.map