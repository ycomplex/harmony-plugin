import { readProjectContext } from '../../tools/project-context.js';
import { checkProjectContextFile, refreshProjectContextFile } from '../../tools/project-context-file.js';
import { Command } from 'commander';
import chalk from 'chalk';
import { getProject } from '../../tools/project.js';
import { switchProject } from '../config.js';
import { runCommand } from '../run-command.js';
import { formatDetail } from '../formatter.js';

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Manage active project');

  const context = project.command('context').description('Check or refresh source-linked project CLAUDE.md context');
  for (const operation of ['check', 'refresh'] as const) {
    context.command(operation).option('--root <directory>', 'Local repository root', process.cwd())
      .option('--json', 'Print JSON')
      .action(async (options) => {
        await runCommand({ json: program.opts().json || options.json }, async (ctx) => {
          const snapshot = await readProjectContext(ctx.client, ctx.projectId);
          const file = operation === 'refresh'
            ? await refreshProjectContextFile(options.root, snapshot)
            : await checkProjectContextFile(options.root, snapshot);
          return { ...file, snapshot };
        }, data => JSON.stringify(data, null, 2));
      });
  }

  project.command('info')
    .description('Show details of the active project')
    .action(async () => {
      await runCommand(program.opts(), async (ctx) =>
        getProject(ctx.client, ctx.projectId),
        (data) => formatDetail([
          { label: 'Name', value: data.name },
          { label: 'Key', value: data.key },
          { label: 'Description', value: data.description ?? '' },
          { label: 'Statuses', value: Array.isArray(data.custom_statuses) ? data.custom_statuses.map((s: any) => s.name ?? s).join(', ') : '' },
        ]),
      );
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
        } else {
          console.log(chalk.green(`Switched to project "${name}".`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(`Error: ${err.message}`));
        }
        process.exit(1);
      }
    });
}
