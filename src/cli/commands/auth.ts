import { Command } from 'commander';
import chalk from 'chalk';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { getProject } from '../../tools/project.js';
import { addProject, removeProject, listProjects } from '../config.js';
import { formatOutput, formatTable } from '../formatter.js';

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Add a project by providing an API token')
    .requiredOption('--token <token>', 'Harmony API token')
    .option('--name <name>', 'Project name (auto-detected if not provided)')
    .option('--supabase-url <url>', 'Custom Supabase URL (advanced)')
    .option('--supabase-anon-key <key>', 'Custom Supabase anon key (advanced)')
    .action(async (opts) => {
      const json = program.opts().json;
      try {
        if (opts.supabaseUrl) process.env.HARMONY_SUPABASE_URL = opts.supabaseUrl;
        if (opts.supabaseAnonKey) process.env.HARMONY_SUPABASE_ANON_KEY = opts.supabaseAnonKey;

        const auth = new HarmonyAuth(opts.token);
        const client = await createAuthenticatedClient(auth);
        const projectId = auth.getProjectId();

        let name = opts.name;
        if (!name) {
          const project = await getProject(client, projectId);
          name = project.name.toLowerCase().replace(/\s+/g, '-');
        }

        addProject(name, opts.token, {
          supabaseUrl: opts.supabaseUrl,
          supabaseAnonKey: opts.supabaseAnonKey,
        });

        if (json) {
          console.log(JSON.stringify({ name, status: 'logged_in' }));
        } else {
          console.log(chalk.green(`Logged in to project "${name}" (now active).`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(`Login failed: ${err.message}`));
        }
        process.exit(1);
      }
    });

  program
    .command('logout')
    .description('Remove a project from the CLI')
    .argument('<name>', 'Project name to remove')
    .action(async (name) => {
      const json = program.opts().json;
      try {
        removeProject(name);
        if (json) {
          console.log(JSON.stringify({ name, status: 'logged_out' }));
        } else {
          console.log(chalk.green(`Removed project "${name}".`));
        }
      } catch (err: any) {
        if (json) {
          console.error(JSON.stringify({ error: err.message }));
        } else {
          console.error(chalk.red(err.message));
        }
        process.exit(1);
      }
    });

  program
    .command('projects')
    .description('List all logged-in projects')
    .action(async () => {
      const json = program.opts().json;
      const projects = listProjects();

      if (json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }

      if (projects.length === 0) {
        console.log('No projects configured. Run `harmony login --token <token>` to add one.');
        return;
      }

      console.log(
        formatTable(
          projects.map((p) => ({
            name: p.name,
            active: p.active ? chalk.green('*') : '',
          })),
          [
            { key: 'active', header: '' },
            { key: 'name', header: 'Project' },
          ],
        ),
      );
    });
}
