import { bulkUpdateTasks } from '../../tools/bulk-update.js';
import { bulkCreateTasks } from '../../tools/tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatStatus, formatPriority } from '../formatter.js';
export function registerBulkCommands(program) {
    const tasks = program.commands.find((c) => c.name() === 'tasks');
    if (!tasks)
        throw new Error('tasks command not found — register task commands first');
    tasks.command('bulk-create')
        .description('Create multiple tasks at once from JSON data')
        .requiredOption('--data <json>', 'JSON array of task objects (each requires "title")')
        .action(async (opts) => {
        let taskList;
        try {
            taskList = JSON.parse(opts.data);
            if (!Array.isArray(taskList))
                throw new Error('Expected JSON array');
        }
        catch (e) {
            console.error(`Error: invalid JSON — ${e.message}`);
            process.exit(1);
        }
        await runCommand(program.opts(), async (ctx) => bulkCreateTasks(ctx.client, ctx.projectId, ctx.userId, { tasks: taskList }), (data) => {
            const created = data ?? [];
            return formatTable(created, [
                { key: 'task_number', header: '#' },
                { key: 'title', header: 'Title', width: 50 },
                { key: 'status', header: 'Status', transform: (v) => formatStatus(v) },
                { key: 'priority', header: 'Priority', transform: (v) => formatPriority(v) },
            ]);
        });
    });
    tasks.command('bulk-update')
        .description('Update multiple tasks at once')
        .requiredOption('--ids <ids...>', 'Task UUIDs to update')
        .option('--status <status>', 'New status')
        .option('--priority <priority>', 'New priority: high, medium, low')
        .option('--assignee <id>', 'New assignee user ID (use "null" to unassign)')
        .option('--archived', 'Archive tasks', false)
        .action(async (opts) => {
        const assigneeId = opts.assignee === 'null' ? null : opts.assignee;
        await runCommand(program.opts(), async (ctx) => bulkUpdateTasks(ctx.client, ctx.projectId, {
            task_ids: opts.ids,
            status: opts.status,
            priority: opts.priority,
            assignee_id: assigneeId,
            archived: opts.archived || undefined,
        }), (data) => {
            const updated = data ?? [];
            return `Updated ${updated.length} task(s)`;
        });
    });
}
//# sourceMappingURL=bulk.js.map