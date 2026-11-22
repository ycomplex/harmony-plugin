import { refreshAfterCompletingAccept } from '../../tools/project-context-consumer.js';
import { readProjectContext } from '../../tools/project-context.js';
import { checkProjectContextFile, refreshProjectContextFile } from '../../tools/project-context-file.js';
import { Command } from 'commander';
import chalk from 'chalk';
import { getProject } from '../../tools/project.js';
import { switchProject } from '../config.js';
import { adoptSettingsToken, currentSource, describeStored, printProjectList } from './auth.js';
import { runCommand } from '../run-command.js';
import { formatDetail } from '../formatter.js';

export function registerProjectCommands(program: Command): void {
  const project = program.command('project').description('Manage active project');

  const context = project.command('context').description('Check or refresh source-linked project CLAUDE.md context');
  context.command('after-accept').requiredOption('--task <ticket>', 'Completed proposition or decision ticket')
    .option('--root <directory>', 'Reachable project repository root', process.cwd()).option('--json', 'Print JSON')
    .action(async options => {
      await runCommand({ json: program.opts().json || options.json }, ctx =>
        refreshAfterCompletingAccept(ctx.client, ctx.projectId, ctx.userId, options.task, options.root),
      data => JSON.stringify(data, null, 2));
    });
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

  project.command('list')
    .description('List stored projects (names only), the active and download marks, and the source this shell uses')
    .action(async () => {
      printProjectList(Boolean(program.opts().json));
    });

  project.command('adopt-settings-token')
    .description(
      "Move the token a project keeps in its .claude/settings.local.json (env.HARMONY_API_TOKEN) into ~/.harmony/config.json: " +
        'reads it from the file itself (never an argument), checks it, saves it without changing the active project, and prints the key ' +
        'to name with HARMONY_PROJECT. The file is left unchanged (B-1501).',
    )
    .option('--file <path>', 'The settings file holding env.HARMONY_API_TOKEN', '.claude/settings.local.json')
    .option('--name <name>', 'Project name (auto-detected if not provided)')
    .option('--supabase-url <url>', "Supabase URL (default: the file's own HARMONY_SUPABASE_URL, if any)")
    .option('--supabase-anon-key <key>', "Supabase anon key (default: the file's own, if any)")
    .option('--supabase-publishable-key <key>', "Supabase publishable key (default: the file's own, if any)")
    .action(async (opts: { file: string; name?: string; supabaseUrl?: string; supabaseAnonKey?: string; supabasePublishableKey?: string }) => {
      const json = program.opts().json;
      try {
        const stored = await adoptSettingsToken(opts.file, opts);
        if (json) {
          console.log(JSON.stringify({ name: stored.key, status: 'stored', active: stored.activated, collided_with: stored.collidedWith ?? null }));
        } else {
          console.log(chalk.green(`Stored the token from ${opts.file} as project "${stored.key}" (the active project is unchanged; the file is unchanged).`));
          for (const line of describeStored(stored)) console.log(line);
        }
      } catch (err: any) {
        if (json) console.error(JSON.stringify({ error: err.message }));
        else console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }
    });

  project.command('switch')
    .description('Switch the active project (local config only)')
    .argument('<name>', 'Project name to switch to')
    .action(async (name) => {
      const json = program.opts().json;
      try {
        switchProject(name);
        // B-1501: the environment wins over the active project. Say so when it does here.
        const { resolved } = currentSource();
        const overridden = resolved && resolved.source !== 'active-project' && resolved.key !== name;
        if (json) {
          console.log(JSON.stringify({ name, status: 'switched', in_force: resolved?.source ?? null }));
        } else {
          console.log(chalk.green(`Switched to project "${name}".`));
        }
        if (overridden) {
          const v = resolved.source === 'env-token' ? 'HARMONY_API_TOKEN' : `HARMONY_PROJECT=${resolved.key}`;
          console.error(`harmony: ${v} is set in this shell and wins over the active project, so commands here still use it, not "${name}". Unset it to use "${name}".`);
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
