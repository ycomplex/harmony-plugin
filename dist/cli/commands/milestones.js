import { listMilestones, createMilestone, updateMilestone, shipMilestone } from '../../tools/milestones.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail } from '../formatter.js';
export function registerMilestoneCommands(program) {
    const milestones = program.command('milestones').description('Manage milestones');
    milestones.command('list')
        .description('List milestones in the project')
        .option('--shipped', 'Show only shipped milestones', false)
        .option('--planning', 'Show only planning milestones', false)
        .action(async (opts) => {
        const status = opts.shipped ? 'shipped' : opts.planning ? 'planning' : undefined;
        await runCommand(program.opts(), async (ctx) => listMilestones(ctx.client, ctx.projectId, { status }), (data) => formatTable(data, [
            { key: 'id', header: 'ID', width: 38 },
            { key: 'name', header: 'Name', width: 30 },
            { key: 'status', header: 'Status' },
            { key: 'description', header: 'Description', width: 40 },
        ]));
    });
    milestones.command('create')
        .description('Create a new milestone')
        .requiredOption('--name <name>', 'Milestone name')
        .option('--description <text>', 'Description or release notes')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => createMilestone(ctx.client, ctx.projectId, ctx.userId, {
            name: opts.name,
            description: opts.description,
        }), (milestone) => `Created milestone: ${milestone.name} (${milestone.id})`);
    });
    milestones.command('update')
        .description('Update a milestone')
        .argument('<id>', 'Milestone ID (UUID)')
        .option('--name <name>', 'New name')
        .option('--description <text>', 'New description')
        .action(async (id, opts) => {
        await runCommand(program.opts(), async (ctx) => updateMilestone(ctx.client, ctx.projectId, {
            milestone_id: id,
            name: opts.name,
            description: opts.description,
        }), (milestone) => formatDetail([
            { label: 'ID', value: milestone.id },
            { label: 'Name', value: milestone.name },
            { label: 'Status', value: milestone.status },
            { label: 'Description', value: milestone.description ?? '' },
        ]));
    });
    milestones.command('ship')
        .description('Ship a milestone (marks as shipped; removes non-Done tasks)')
        .argument('<id>', 'Milestone ID (UUID)')
        .action(async (id) => {
        await runCommand(program.opts(), async (ctx) => shipMilestone(ctx.client, ctx.projectId, { milestone_id: id }), (result) => [
            `Shipped milestone: ${result.milestone.name}`,
            `  Shipped tasks: ${result.shipped_task_count}`,
            `  Removed (non-Done) tasks: ${result.removed_tasks.length}`,
        ].join('\n'));
    });
}
//# sourceMappingURL=milestones.js.map