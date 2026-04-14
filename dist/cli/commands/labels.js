import { listLabels, createLabel } from '../../tools/labels.js';
import { manageTaskLabels } from '../../tools/task-labels.js';
import { runCommand } from '../run-command.js';
import { formatTable } from '../formatter.js';
export function registerLabelCommands(program) {
    const labels = program.command('labels').description('Manage labels');
    labels.command('list')
        .description('List all labels in the workspace')
        .action(async () => {
        await runCommand(program.opts(), async (ctx) => listLabels(ctx.client, ctx.projectId), (data) => formatTable(data, [
            { key: 'id', header: 'ID', width: 38 },
            { key: 'name', header: 'Name', width: 30 },
            { key: 'color', header: 'Color' },
        ]));
    });
    labels.command('create')
        .description('Create a new label in the workspace')
        .requiredOption('--name <name>', 'Label name')
        .option('--color <color>', 'Color key (red, orange, amber, yellow, lime, green, teal, cyan, blue, indigo, purple, pink)')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => createLabel(ctx.client, ctx.projectId, ctx.userId, {
            name: opts.name,
            color: opts.color,
        }), (label) => `Created label: ${label.name} (${label.id})`);
    });
    labels.command('manage')
        .description('Add or remove labels on a task')
        .argument('<task-id>', 'Task ID (UUID, number, or B-123)')
        .option('--add <ids...>', 'Label IDs to add')
        .option('--remove <ids...>', 'Label IDs to remove')
        .action(async (taskId, opts) => {
        await runCommand(program.opts(), async (ctx) => manageTaskLabels(ctx.client, ctx.projectId, {
            task_id: taskId,
            add: opts.add,
            remove: opts.remove,
        }), (result) => `Added: ${result.added.length} label(s), Removed: ${result.removed.length} label(s)`);
    });
}
//# sourceMappingURL=labels.js.map