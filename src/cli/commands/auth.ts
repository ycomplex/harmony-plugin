import { Command } from 'commander';
import chalk from 'chalk';
import { HarmonyAuth } from '../../auth.js';
import { createAuthenticatedClient } from '../../supabase.js';
import { getProject } from '../../tools/project.js';
import { removeProject, listProjects, loadConfig, saveProject } from '../config.js';
import { describeSource, resolveProject, type ResolvedProject } from '../../config/project-resolution.js';
import { formatTable } from '../formatter.js';
import { resolveSupabaseTarget, type ResolvedSupabaseTarget } from '../resolve-supabase-target.js';
import { promptHidden, TOKEN_PROMPT } from '../hidden-prompt.js';
import fs from 'node:fs';

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
  if (!s.activated) lines.push(...noActiveHint(s.key));
  return lines;
}

/** B-1501 fix 6: a non-activating save never sets the active project. When there is none, say how
 *  to set one (a terminal outside any session uses it). Names only. */
export function noActiveHint(key: string): string[] {
  let active: string | null = null;
  try {
    const c = loadConfig();
    active = c.activeProject && c.projects[c.activeProject] ? c.activeProject : null;
  } catch {
    active = null;
  }
  return active ? [] : [`No project is active for terminal commands outside a session. To use this one there, run: harmony project switch ${key}`];
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

/** Where `harmony login --token-stdin` reads from. A test swaps these. */
export const loginInput: {
  stdin: () => NodeJS.ReadableStream;
  /** true when stdin is a terminal: then the token is asked for with echo off, never read plainly. */
  isTTY: () => boolean;
  promptHidden: (question: string) => Promise<string>;
} = {
  stdin: () => process.stdin,
  isTTY: () => Boolean(process.stdin.isTTY),
  promptHidden,
};

/** B-1501 fix 3: `--token-stdin` at a terminal asks with echo off (the hidden prompt `harmony download
 *  token set` uses), so a pasted token is never shown; from a pipe it reads stdin. */
export async function readLoginToken(): Promise<string> {
  if (loginInput.isTTY()) {
    const token = (await loginInput.promptHidden(TOKEN_PROMPT)).trim();
    if (token === '') throw new Error('no token was given.');
    return token;
  }
  return readTokenFromStdin();
}

/** B-1501: read a token piped to `harmony login --token-stdin`. One trailing newline is trimmed; the
 *  token is never echoed and never appears in any argv. */
export async function readTokenFromStdin(input: NodeJS.ReadableStream = loginInput.stdin()): Promise<string> {
  let data = '';
  for await (const chunk of input) data += String(chunk);
  const token = data.replace(/\r?\n$/, '');
  if (token.trim() === '') throw new Error('--token-stdin read no token from stdin.');
  return token;
}

/** The token for `harmony login`: exactly one of --token and --token-stdin. */
async function loginToken(opts: { token?: string; tokenStdin?: boolean }): Promise<string> {
  if (opts.token !== undefined && opts.tokenStdin) {
    throw new Error('Pass either --token or --token-stdin, not both.');
  }
  if (opts.tokenStdin) return readLoginToken();
  if (opts.token === undefined || opts.token === '') {
    throw new Error('Pass --token <token>, or pipe the token in with --token-stdin.');
  }
  return opts.token;
}

export function registerAuthCommands(program: Command): void {
  program
    .command('login')
    .description('Add a project by providing an API token')
    .option('--token <token>', 'Harmony API token (prefer --token-stdin: an argument can be seen by other processes)')
    .option('--token-stdin', 'Read the Harmony API token from stdin (one trailing newline is trimmed); at a terminal, ask for it with echo off', false)
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

        const token = await loginToken(opts);
        const stored = await verifyAndStoreToken(token, target, opts, { activate: opts.activate !== false });

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
          ? { source: resolved.source, project: resolved.key, active_project: resolved.activeProject, overrides_active: resolved.overridesActive, supabase_url: resolved.target?.url ?? null, supabase_source: resolved.target?.source ?? null, reason: describeSource(resolved) }
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
      if (resolved.target) console.log(`Supabase: ${resolved.target.url} (${describeTargetSource(resolved.target, resolved.source)})`);
      console.log('Order: HARMONY_API_TOKEN, then HARMONY_PROJECT, then the active project.');
    });
}

/** Where the Supabase address whoami prints comes from, so /harmony-setup can tell whether a stored
 *  project carries its own pair. Names only, never a key. */
export function describeTargetSource(t: Pick<ResolvedSupabaseTarget, 'source'>, source: ResolvedProject['source']): string {
  const stored = source !== 'env-token';
  switch (t.source) {
    case 'project':
      return 'the pair stored with the project';
    case 'env':
      return stored ? 'HARMONY_SUPABASE_URL in the environment; the project stores no pair' : 'HARMONY_SUPABASE_URL in the environment';
    case 'default':
      return stored ? 'the built-in default; the project stores no pair' : 'the built-in default';
    case 'flags':
      return 'flags';
  }
}

/** B-1501 fix 2: move a token a project keeps in its `.claude/settings.local.json` into
 *  ~/.harmony/config.json without the token ever being in a command line, a prompt or the agent's
 *  view: this reads `env.HARMONY_API_TOKEN` from the file itself, checks it against Harmony, and
 *  saves it WITHOUT activating. The file's own HARMONY_SUPABASE_URL / _ANON_KEY / _PUBLISHABLE_KEY,
 *  when present, travel with it as the stored pair (explicit flags win). The file is not changed:
 *  /harmony-setup removes the copy only after proving the stored one works. */
export async function adoptSettingsToken(file: string, flags: LoginFlags = {}): Promise<StoredToken> {
  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new Error(code ? `${file} cannot be read (${code}).` : `${file} is not valid JSON.`);
  }
  const env = parsed && typeof parsed === 'object' ? parsed.env : undefined;
  const token = env && typeof env.HARMONY_API_TOKEN === 'string' ? env.HARMONY_API_TOKEN.trim() : '';
  if (!token) throw new Error(`${file} has no env.HARMONY_API_TOKEN to move. Nothing was changed.`);
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const fromFlags = flags.supabaseUrl !== undefined || flags.supabaseAnonKey !== undefined || flags.supabasePublishableKey !== undefined;
  const pair: LoginFlags = fromFlags
    ? { supabaseUrl: flags.supabaseUrl, supabaseAnonKey: flags.supabaseAnonKey, supabasePublishableKey: flags.supabasePublishableKey }
    : { supabaseUrl: str(env.HARMONY_SUPABASE_URL), supabaseAnonKey: str(env.HARMONY_SUPABASE_ANON_KEY), supabasePublishableKey: str(env.HARMONY_SUPABASE_PUBLISHABLE_KEY) };
  const target = resolveSupabaseTarget({
    flags: { url: pair.supabaseUrl, anonKey: pair.supabaseAnonKey, publishableKey: pair.supabasePublishableKey },
    project: undefined,
  });
  try {
    return await verifyAndStoreToken(token, target, { ...pair, name: flags.name }, { activate: false });
  } catch (e) {
    throw new Error(String((e as Error)?.message ?? e).split(token).join('<token>'));
  }
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
