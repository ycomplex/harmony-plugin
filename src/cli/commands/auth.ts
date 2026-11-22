import { Command } from 'commander';
import chalk from 'chalk';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { getProject } from '../../tools/project.js';
import { removeProject, listProjects, loadConfig, saveProject } from '../config.js';
import { describeSource, resolveProject, type ResolvedProject } from '../../config/project-resolution.js';
import { formatTable } from '../formatter.js';
import { resolveSupabaseTarget } from '../resolve-supabase-target.js';

export interface LoginFlags {
  name?: string;
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  supabasePublishableKey?: string;
}

export interface StoredToken {
  /** The key in config.json — what HARMONY_PROJECT names. */
  key: string;
  projectId: string;
  /** Set when the wanted key held a different project, which was left untouched. */
  collidedWith?: string;
  activated: boolean;
}

/** Exchange the token against Harmony (so a bad one is refused before anything is stored), name the
 *  project, and store it keyed by its project id (B-1501: never over a different project's entry).
 *  `harmony login` activates it, as always; install, `download token set` and /harmony-setup save
 *  with `activate: false`. Shared by `harmony login` and the download commands, which save a token
 *  in-process, never passing it as a subprocess argument. */
export async function verifyAndStoreToken(
  token: string,
  target: { url: string; anonKey: string },
  flags: LoginFlags = {},
  opts: { activate?: boolean } = {},
): Promise<StoredToken> {
  const auth = new HarmonyAuth(token, target.url, target.anonKey);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  let name = flags.name;
  if (!name) {
    const project = await getProject(client, projectId);
    name = project.name.toLowerCase().replace(/\s+/g, '-');
  }

  // B-1025: store the FLAGS, not the resolved pair. A project registered without flags
  // keeps working off the environment (the documented env-var route), and a project
  // registered WITH flags carries the pair the founder typed — never a default URL
  // silently recorded as if they had chosen it. B-1501 records the URL the exchange used as
  // `verifiedUrl`, which picks nothing; it only lets HARMONY_PROJECT refuse another backend.
  const saved = saveProject({
    name,
    token,
    projectId,
    verifiedUrl: target.url,
    supabaseUrl: flags.supabaseUrl,
    supabaseAnonKey: flags.supabaseAnonKey,
    supabasePublishableKey: flags.supabasePublishableKey,
    explicitName: Boolean(flags.name),
    activate: opts.activate ?? true,
  });
  return { ...saved, projectId };
}

/** The lines that tell a person where a save went. Names only. */
export function describeStored(s: StoredToken): string[] {
  const lines: string[] = [];
  if (s.collidedWith) {
    lines.push(`A different project is already stored as "${s.collidedWith}" and was left as it is; this one is stored as "${s.key}".`);
  }
  lines.push(`To use it in a project's sessions, put HARMONY_PROJECT=${s.key} in that project's .claude/settings.local.json env.`);
  return lines;
}

/** Save a token with no flags, in-process, without changing the active project (B-1479, B-1501). */
export async function saveTokenNoActivate(token: string): Promise<StoredToken> {
  const target = resolveSupabaseTarget({ flags: {}, project: undefined });
  return verifyAndStoreToken(token, target, {}, { activate: false });
}

/** Where the CLI's token comes from in this shell, or why none. Names only; never throws. */
export function currentSource(): { resolved: ResolvedProject | null; error: string | null } {
  try {
    return { resolved: resolveProject({ surface: 'cli' }), error: null };
  } catch (e) {
    return { resolved: null, error: (e as Error).message };
  }
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Add a project by providing an API token')
    .requiredOption('--token <token>', 'Harmony API token')
    .option('--name <name>', 'Project name (auto-detected if not provided)')
    .option('--supabase-url <url>', 'Custom Supabase URL (advanced)')
    .option('--supabase-anon-key <key>', 'Custom Supabase anon key (advanced)')
    .option('--supabase-publishable-key <key>', 'Custom Supabase publishable key (advanced)')
    .option('--no-activate', 'Store the project without making it the active one (B-1501)')
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
          flags: { url: opts.supabaseUrl, anonKey: opts.supabaseAnonKey, publishableKey: opts.supabasePublishableKey },
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

        if (!json && opts.supabasePublishableKey !== undefined && target.anonKey !== opts.supabasePublishableKey) {
          console.error(`harmony login: --supabase-publishable-key was overridden by ${target.source}. Pass --supabase-url and --supabase-publishable-key together.`);
        }

        const stored = await verifyAndStoreToken(opts.token, target, opts, { activate: opts.activate !== false });

        if (json) {
          console.log(JSON.stringify({ name: stored.key, status: 'logged_in', active: stored.activated, collided_with: stored.collidedWith ?? null }));
        } else {
          console.log(chalk.green(`Logged in to project "${stored.key}"${stored.activated ? ' (now active)' : ' (stored; the active project is unchanged)'}.`));
          for (const line of describeStored(stored)) console.log(line);
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
        const pinned = loadConfig().downloadProject === name;
        removeProject(name);
        if (pinned && !json) {
          console.error(`Note: "${name}" was the project the plugin download uses. Pin another with \`harmony download token use <project>\` or \`harmony download token set\`.`);
        }
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
    .description('List all logged-in projects (same as `harmony project list`)')
    .action(async () => {
      printProjectList(Boolean(program.opts().json));
    });

  program
    .command('whoami')
    .description('Say which project and token source this shell uses, and why (names only; no network call)')
    .action(async () => {
      const json = Boolean(program.opts().json);
      const { resolved, error } = currentSource();
      if (json) {
        console.log(JSON.stringify(resolved
          ? { source: resolved.source, project: resolved.key, active_project: resolved.activeProject, overrides_active: resolved.overridesActive, supabase_url: resolved.target?.url ?? null, reason: describeSource(resolved) }
          : { source: null, error }, null, 2));
        if (!resolved) process.exitCode = 1;
        return;
      }
      if (!resolved) {
        console.error(chalk.red(`No project: ${error}`));
        process.exitCode = 1;
        return;
      }
      console.log(`Project: ${resolved.key ?? '(the project HARMONY_API_TOKEN belongs to)'}`);
      console.log(`Source: ${describeSource(resolved)}`);
      if (resolved.target) console.log(`Supabase: ${resolved.target.url}`);
      console.log('Order: HARMONY_API_TOKEN, then HARMONY_PROJECT, then the active project.');
    });
}

/** `harmony projects` / `harmony project list`: names, the active and download marks, and the source in force. */
export function printProjectList(json: boolean): void {
  const projects = listProjects();
  const { resolved, error } = currentSource();

  if (json) {
    console.log(JSON.stringify(projects, null, 2));
    return;
  }

  if (projects.length === 0) {
    console.log('No projects configured. Run `harmony login --token <token>` to add one.');
  } else {
    console.log(
      formatTable(
        projects.map((p) => ({
          name: p.name,
          active: p.active ? chalk.green('*') : '',
          download: p.download ? 'download' : '',
        })),
        [
          { key: 'active', header: '' },
          { key: 'name', header: 'Project' },
          { key: 'download', header: '' },
        ],
      ),
    );
  }
  console.log(resolved ? `In this shell: ${describeSource(resolved)}.` : `In this shell: no project (${error})`);
  if (resolved?.overridesActive) {
    console.error(`harmony: the environment overrides the active project "${resolved.activeProject}" here.`);
  }
}
