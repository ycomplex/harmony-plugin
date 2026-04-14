import { listEpics, createEpic, updateEpic } from '../../tools/epics.js';
import { runCommand } from '../run-command.js';
import { formatTable, formatDetail } from '../formatter.js';
export function registerEpicCommands(program) {
    const epics = program.command('epics').description('Manage epics');
    epics.command('list')
        .description('List all epics in the project')
        .action(async () => {
        await runCommand(program.opts(), async (ctx) => listEpics(ctx.client, ctx.projectId), (data) => formatTable(data, [
            { key: 'id', header: 'ID', width: 38 },
            { key: 'name', header: 'Name', width: 40 },
            { key: 'color', header: 'Color' },
            { key: 'position', header: 'Pos' },
        ]));
    });
    epics.command('create')
        .description('Create a new epic')
        .requiredOption('--name <name>', 'Epic name')
        .option('--color <color>', 'Hex color (e.g. #6366f1)')
        .action(async (opts) => {
        await runCommand(program.opts(), async (ctx) => createEpic(ctx.client, ctx.projectId, ctx.userId, {
            name: opts.name,
            color: opts.color,
        }), (epic) => `Created epic: ${epic.name} (${epic.id})`);
    });
    epics.command('update')
        .description('Update an epic')
        .argument('<id>', 'Epic ID (UUID)')
        .option('--name <name>', 'New name')
        .option('--color <color>', 'New hex color')
        .action(async (id, opts) => {
        await runCommand(program.opts(), async (ctx) => updateEpic(ctx.client, ctx.projectId, {
            epic_id: id,
            name: opts.name,
            color: opts.color,
        }), (epic) => formatDetail([
            { label: 'ID', value: epic.id },
            { label: 'Name', value: epic.name },
            { label: 'Color', value: epic.color },
        ]));
    });
}
//# sourceMappingURL=epics.js.map