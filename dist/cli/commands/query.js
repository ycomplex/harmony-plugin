import { queryTasks } from '../../tools/query-tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatPriority, formatStatus, formatDate } from '../formatter.js';
export function registerQueryCommand(program) {
    const tasks = program.commands.find((c) => c.name() === 'tasks');
    if (!tasks)
        throw new Error('tasks command not found — register task commands first');
    tasks.command('query')
        .description('Search tasks with rich filters')
        .option('--status <status>', 'Filter by status')
        .option('--assignee <id>', 'Filter by assignee ID')
        .option('--epic <id>', 'Filter by epic ID')
        .option('--cycle <id>', 'Filter by cycle ID')
        .option('--milestone <id>', 'Filter by milestone ID')
        .option('--priority <priority>', 'Filter by priority: high, medium, low')
        .option('--label <ids...>', 'Filter by label IDs (must have ALL)')
        .option('--due-from <date>', 'Due date on or after (YYYY-MM-DD)')
        .option('--due-to <date>', 'Due date on or before (YYYY-MM-DD)')
        .option('--stale <days>', 'Tasks not updated in this many days')
        .option('--archived', 'Include archived tasks', false)
        .option('--sort <field>', 'Sort by: position, due_date, priority, updated_at', 'position')
        .option('--limit <n>', 'Max results', '50')
        .option('--offset <n>', 'Skip results', '0')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => queryTasks(ctx.client, ctx.projectId, {
            status: opts.status,
            assignee_id: opts.assignee,
            epic_id: opts.epic,
            cycle_id: opts.cycle,
            milestone_id: opts.milestone,
            priority: opts.priority,
            label_ids: opts.label,
            due_date_from: opts.dueFrom,
            due_date_to: opts.dueTo,
            stale_days: opts.stale ? parseInt(opts.stale) : undefined,
            archived: opts.archived,
            sort_by: opts.sort,
            limit: parseInt(opts.limit),
            offset: parseInt(opts.offset),
        }), (data) => formatTable(data, [
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status', transform: (v) => formatStatus(v) },
            { key: 'priority', header: 'Priority', transform: (v) => formatPriority(v) },
            { key: 'due_date', header: 'Due', transform: (v) => formatDate(v) },
        ]));
    });
}
//# sourceMappingURL=query.js.map