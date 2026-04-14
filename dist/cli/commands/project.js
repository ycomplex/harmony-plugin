import chalk from 'chalk';
import { getProject } from '../../tools/project.js';
import { switchProject } from '../config.js';
import { runCommand } from '../run-command.js';
import { formatDetail } from '../formatter.js';
export function registerProjectCommands(program) {
    const project = program.command('project').description('Manage active project');
    project.command('info')
        .description('Show details of the active project')
        .action(async () => {
        await runCommand(program.opts(), async (ctx) => getProject(ctx.client, ctx.projectId), (data) => formatDetail([
            { label: 'Name', value: data.name },
            { label: 'Key', value: data.key },
            { label: 'Description', value: data.description ?? '' },
            { label: 'Statuses', value: Array.isArray(data.custom_statuses) ? data.custom_statuses.map((s) => s.name ?? s).join(', ') : '' },
        ]));
    });
    project.command('switch')
        .description('Switch the active project (local config only)')
        .argument('<name>', 'Project name to switch to')
        .action(async (name) => {
        const json = program.opts().json;
        try {
            switchProject(name);
            if (json) {
                console.log(JSON.stringify({ name, status: 'switched' }));
            }
            else {
                console.log(chalk.green(`Switched to project "${name}".`));
            }
        }
        catch (err) {
            if (json) {
                console.error(JSON.stringify({ error: err.message }));
            }
            else {
                console.error(chalk.red(`Error: ${err.message}`));
            }
            process.exit(1);
        }
    });
}
//# sourceMappingURL=project.js.map