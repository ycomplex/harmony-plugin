import { listComments, addComment } from '../../tools/comments.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDate } from '../formatter.js';
export function registerCommentCommands(program) {
    const tasks = program.commands.find((c) => c.name() === 'tasks');
    if (!tasks)
        throw new Error('tasks command not found — register task commands first');
    tasks.command('comments')
        .description('List comments on a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .action(async (taskId) => {
        await runCommand(program.opts(), async (ctx) => listComments(ctx.client, ctx.projectId, { task_id: taskId }), (data) => formatTable(data, [
            { key: 'created_at', header: 'Date', transform: (v) => formatDate(v) },
            { key: 'user_id', header: 'User' },
            { key: 'content', header: 'Comment', width: 60 },
        ]));
    });
    tasks.command('comment')
        .description('Add a comment to a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .argument('<content>', 'Comment content')
        .action(async (taskId, content) => {
        await runCommand(program.opts(), async (ctx) => addComment(ctx.client, ctx.projectId, ctx.userId, { task_id: taskId, content }), () => 'Comment added.');
    });
}
//# sourceMappingURL=comments.js.map