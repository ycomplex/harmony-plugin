import { Command } from 'commander';
import chalk from 'chalk';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { getProject } from '../../tools/project.js';
import { addProject, removeProject, listProjects } from '../config.js';
import { formatTable } from '../formatter.js';
import { resolveSupabaseTarget } from '../resolve-supabase-target.js';

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
        // B-1025: resolve the Supabase pair for THIS call.
        //
        // This used to write the flags into process.env and let the auth module read them back —
        // but the auth module had already captured the environment at IMPORT time, so
        // `--supabase-url` never reached the token exchange. The pair is resolved here, by name,
        // and handed to the auth instance explicitly.
        const target = resolveSupabaseTarget({
          flags: { url: opts.supabaseUrl, anonKey: opts.supabaseAnonKey },
          project: undefined,
        });

        // B-1025: when the user passes only one of the two flags, the OTHER side is taken from
        // the resolver (env / default), and the half they passed is silently dropped. Surface
        // that loudly: "harmony login --supabase-anon-key K" with HARMONY_SUPABASE_URL set used
        // to log the user in with the env URL and the env key, ignoring K entirely — a silent
        // surprise when they meant to register K.
        // B-1025: surface a half-flag warning. The flag-URL case can't trigger this — when
        // --supabase-url is set, the flag tier owns the URL and target.url always equals
        // opts.supabaseUrl — but the flag-anon-key case can: with HARMONY_SUPABASE_URL set in env,
        // the user passing --supabase-anon-key K (no --supabase-url) means the env owns the URL
        // AND its key, silently dropping K. Warn loudly. Only fires when the login is non-json
        // (json consumers don't want human prose on stderr).
        if (!json && opts.supabaseAnonKey !== undefined && target.anonKey !== opts.supabaseAnonKey) {
          console.error(
            `harmony login: --supabase-anon-key was overridden by ${target.source} — the resolver ` +
              `used ${target.source}'s anon key instead of the one you passed. Pass ` +
              `--supabase-url <url> --supabase-anon-key <key> together to use the key you typed.`,
          );
        }

        const auth = new HarmonyAuth(opts.token, target.url, target.anonKey);
        const client = await createAuthenticatedClient(auth);
        const projectId = auth.getProjectId();

        let name = opts.name;
        if (!name) {
          const project = await getProject(client, projectId);
          name = project.name.toLowerCase().replace(/\s+/g, '-');
        }

        // B-1025: store the FLAGS, not the resolved pair. A project registered without flags
        // keeps working off the environment (the documented env-var route), and a project
        // registered WITH flags carries the pair the founder typed — never a default URL
        // silently recorded as if they had chosen it.
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
