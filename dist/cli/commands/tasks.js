import { listTasks, getTask, createTask, updateTask } from '../../tools/tasks.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail, formatPriority, formatStatus, formatDate } from '../formatter.js';
export function registerTaskCommands(program) {
    const tasks = program.command('tasks').description('Manage tasks');
    tasks.command('list')
        .description('List tasks with optional filters')
        .option('--status <status>', 'Filter by status')
        .option('--assignee <id>', 'Filter by assignee')
        .option('--epic <id>', 'Filter by epic')
        .option('--label <ids...>', 'Filter by label IDs')
        .option('--archived', 'Include archived tasks', false)
        .option('--limit <n>', 'Max results', '50')
        .option('--offset <n>', 'Skip results', '0')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => listTasks(ctx.client, ctx.projectId, {
            status: opts.status, assignee_id: opts.assignee, epic_id: opts.epic,
            label_ids: opts.label, archived: opts.archived,
            limit: parseInt(opts.limit), offset: parseInt(opts.offset),
        }), (data) => formatTable(data, [
            { key: 'task_number', header: '#' },
            { key: 'title', header: 'Title', width: 50 },
            { key: 'status', header: 'Status', transform: (v) => formatStatus(v) },
            { key: 'priority', header: 'Priority', transform: (v) => formatPriority(v) },
            { key: 'due_date', header: 'Due', transform: (v) => formatDate(v) },
        ]));
    });
    tasks.command('get')
        .description('Get full details of a task')
        .argument('<id>', 'Task ID (UUID, number, or B-123)')
        .action(async (id) => {
        await runCommand(program.opts(), async (ctx) => getTask(ctx.client, ctx.projectId, { task_id: id }), (task) => formatDetail([
            { label: 'ID', value: `#${task.task_number}` },
            { label: 'Title', value: task.title },
            { label: 'Status', value: formatStatus(task.status) },
            { label: 'Priority', value: formatPriority(task.priority) },
            { label: 'Assignee', value: task.assignee_id ?? 'Unassigned' },
            { label: 'Epic', value: task.epic_id ?? 'None' },
            { label: 'Due', value: formatDate(task.due_date) },
            { label: 'Description', value: task.description ?? '' },
        ]));
    });
    tasks.command('create')
        .description('Create a new task')
        .requiredOption('--title <title>', 'Task title')
        .option('--status <status>', 'Status (default: Backlog)')
        .option('--priority <priority>', 'Priority: high, medium, low')
        .option('--assignee <id>', 'Assignee (name, email, or UUID)')
        .option('--epic <id>', 'Epic ID')
        .option('--description <text>', 'Task description')
        .option('--due <date>', 'Due date (YYYY-MM-DD)')
        .option('--cycle <id>', 'Cycle ID')
        .option('--milestone <id>', 'Milestone ID')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => createTask(ctx.client, ctx.projectId, ctx.userId, {
            title: opts.title, status: opts.status, priority: opts.priority,
            assignee_id: opts.assignee, epic_id: opts.epic, description: opts.description,
            due_date: opts.due, cycle_id: opts.cycle, milestone_id: opts.milestone,
        }), (task) => `Created task #${task.task_number}: ${task.title}`);
    });
    tasks.command('update')
        .description('Update an existing task')
        .argument('<id>', 'Task ID')
        .option('--title <title>', 'New title')
        .option('--status <status>', 'New status')
        .option('--priority <priority>', 'New priority')
        .option('--assignee <id>', 'New assignee')
        .option('--epic <id>', 'New epic')
        .option('--description <text>', 'New description')
        .option('--due <date>', 'New due date')
        .option('--cycle <id>', 'Cycle ID')
        .option('--milestone <id>', 'Milestone ID')
        .action(async (id, opts) => {
        await runCommand(program.opts(), async (ctx) => updateTask(ctx.client, ctx.projectId, {
            task_id: id, title: opts.title, status: opts.status, priority: opts.priority,
            assignee_id: opts.assignee, epic_id: opts.epic, description: opts.description,
            due_date: opts.due, cycle_id: opts.cycle, milestone_id: opts.milestone,
        }), (task) => `Updated task #${task.task_number}: ${task.title}`);
    });
}
//# sourceMappingURL=tasks.js.map