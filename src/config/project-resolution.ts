/**
 * B-1501: the ONE answer to "which Harmony project, with which token, does this process use?".
 * Shared by the MCP server's start-up (src/mcp-auth.ts, called from src/index.ts) and the CLI
 * (getAuthenticatedContext in src/cli/auth.ts, and `harmony watch`'s auth), and so by every hook and
 * command that goes through either.
 *
 * Precedence, first match wins:
 *
 *   (a) HARMONY_API_TOKEN is set in the environment -> that token. Its Supabase pair comes from the
 *       environment, then the built-in default, exactly as before B-1501.
 *   (b) else HARMONY_PROJECT names a project stored in ~/.harmony/config.json -> that entry's token
 *       AND its own stored Supabase pair. Refused, by name, when:
 *         - no stored entry has that key (no fallback to the active project);
 *         - the environment's HARMONY_SUPABASE_URL, HARMONY_SUPABASE_ANON_KEY or
 *           HARMONY_SUPABASE_PUBLISHABLE_KEY contradicts the pair stored with the entry, or the pair
 *           this call would use is not the backend the token was saved against (`verifiedUrl`).
 *           One environment's token is never sent to another's backend. Messages name URLs and
 *           variable names, never a key or a token;
 *       and, after the exchange, when the token reaches a different project than the entry's saved
 *       `projectId` (HarmonyAuth's expectedProjectId).
 *   (c) else, on the CLI only (a terminal outside any session), the active project, as before.
 *       Refused, by name (URLs only), when the entry was saved against a backend (`verifiedUrl`)
 *       other than the one this call would use; an entry saved before B-1501 has none and is read
 *       as before. The MCP server with neither (a) nor (b) stops with its old message, naming
 *       HARMONY_PROJECT as the alternative. `harmony conductor`'s operator-side reads (surface
 *       'conductor-operator') have no (c) either: they stop naming both variables, so a
 *       conductor's composed environment is never paired with the CLI's active project.
 *
 * Change of behaviour (B-1501): before, the CLI preferred the active project over
 * HARMONY_API_TOKEN. Now the environment wins, and the CLI prints one stderr line per process when
 * an environment token or HARMONY_PROJECT overrides a different active project
 * (`overrideNotice`); `harmony whoami`, `harmony project list` and `harmony project switch` say
 * which source is in force and why.
 */
import { harmonyEnv } from '../env.js';
import { getConfigFile, loadConfig, type HarmonyConfig, type ProjectConfig } from '../cli/config.js';
import { resolveSupabaseTarget, type ResolvedSupabaseTarget } from '../cli/resolve-supabase-target.js';
import { resolvePublicKey } from '../supabase-key.js';
import { DEFAULT_SUPABASE_ANON_KEY, DEFAULT_SUPABASE_URL } from '../auth.js';

export type ProjectSource = 'env-token' | 'harmony-project' | 'active-project';

export interface ResolvedProject {
  source: ProjectSource;
  /** The stored key in config.json; null for an environment token. */
  key: string | null;
  token: string;
  /** The stored entry, when the token came from one. */
  project: ProjectConfig | null;
  /** The Supabase pair. null only for the MCP server's environment token, whose pair HarmonyAuth
   *  reads from the environment per call, as before B-1501. */
  target: ResolvedSupabaseTarget | null;
  /** The project id the exchange must reach (HARMONY_PROJECT entries saved since B-1501). */
  expectedProjectId?: string;
  /** The label used when that check refuses. */
  expectedLabel?: string;
  /** config.json's active project, when it names a stored entry. */
  activeProject: string | null;
  /** true when this resolution overrides a DIFFERENT active project. */
  overridesActive: boolean;
}

export class ProjectResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectResolutionError';
  }
}

export const MCP_MISSING_MESSAGE =
  'HARMONY_API_TOKEN environment variable is required (or set HARMONY_PROJECT to a project stored in ~/.harmony/config.json; `harmony project list` names them)';

/** `harmony conductor`'s operator-side reads with neither variable (B-1501): never the active project. */
export const OPERATOR_MISSING_MESSAGE =
  'Neither HARMONY_API_TOKEN nor HARMONY_PROJECT is set in the conductor\'s environment; `harmony conductor` never falls back to the active project. ' +
  'Set HARMONY_API_TOKEN (the conductor\'s token), or HARMONY_PROJECT to a project stored in ~/.harmony/config.json (`harmony project list` names them).';

export interface ResolveOptions {
  /** 'conductor-operator': the CLI's resolution without the active-project rung. */
  surface: 'mcp' | 'cli' | 'conductor-operator';
  env?: NodeJS.ProcessEnv;
  /** Defaults to reading config.json (src/cli/config.ts). */
  loadConfig?: () => HarmonyConfig;
}

function trimUrl(u: string): string {
  return u.trim().replace(/\/+$/, '');
}

function readConfigOrNull(load: () => HarmonyConfig): HarmonyConfig | null {
  try {
    return load();
  } catch {
    return null;
  }
}

function usableActive(config: HarmonyConfig | null): string | null {
  const name = config?.activeProject;
  return name && config?.projects?.[name] ? name : null;
}

/** The stored entry's own public key, or the default key when it names the default URL with none. */
function storedKey(p: ProjectConfig): string | undefined {
  const k = resolvePublicKey(p.supabaseAnonKey, p.supabasePublishableKey, ['supabaseAnonKey', 'supabasePublishableKey']);
  if (k) return k;
  if (p.supabaseUrl && trimUrl(p.supabaseUrl) === DEFAULT_SUPABASE_URL) return DEFAULT_SUPABASE_ANON_KEY;
  return undefined;
}

/** (b)'s pair checks. Names URLs and variable names only. */
function checkStoredPair(key: string, p: ProjectConfig, env: NodeJS.ProcessEnv): ResolvedSupabaseTarget {
  const envUrl = harmonyEnv('HARMONY_SUPABASE_URL', env);
  const envAnon = harmonyEnv('HARMONY_SUPABASE_ANON_KEY', env);
  const envPub = harmonyEnv('HARMONY_SUPABASE_PUBLISHABLE_KEY', env);
  if (p.supabaseUrl) {
    const stored = trimUrl(p.supabaseUrl);
    if (envUrl && trimUrl(envUrl) !== stored) {
      throw new ProjectResolutionError(
        `HARMONY_PROJECT=${key} is stored for ${stored} but HARMONY_SUPABASE_URL says ${trimUrl(envUrl)}; refusing to send its token to another backend. ` +
          'Unset HARMONY_SUPABASE_URL (the stored project carries its own pair), or name the project stored for that backend.',
      );
    }
    const sk = storedKey(p);
    for (const [name, value] of [['HARMONY_SUPABASE_ANON_KEY', envAnon], ['HARMONY_SUPABASE_PUBLISHABLE_KEY', envPub]] as const) {
      if (value && sk && value !== sk) {
        throw new ProjectResolutionError(
          `HARMONY_PROJECT=${key} is stored for ${stored} with its own public key, but ${name} in the environment is a different key; refusing. ` +
            `Unset ${name} (the stored project carries its own pair).`,
        );
      }
    }
  }
  const target = resolveSupabaseTarget({ flags: {}, project: p, env });
  if (p.verifiedUrl && trimUrl(target.url) !== trimUrl(p.verifiedUrl)) {
    const from = target.source === 'env' ? 'HARMONY_SUPABASE_URL' : target.source === 'default' ? 'the built-in default' : 'its stored Supabase settings';
    throw new ProjectResolutionError(
      `HARMONY_PROJECT=${key} was saved against ${trimUrl(p.verifiedUrl)} but this session would use ${trimUrl(target.url)} (from ${from}); refusing to send its token to another backend. ` +
        `Set HARMONY_SUPABASE_URL (and its key) for ${trimUrl(p.verifiedUrl)}, or name the project stored for this backend.`,
    );
  }
  return target;
}

export function resolveProject(opts: ResolveOptions): ResolvedProject {
  const env = opts.env ?? process.env;
  const load = opts.loadConfig ?? loadConfig;

  // (a) HARMONY_API_TOKEN.
  const envToken = harmonyEnv('HARMONY_API_TOKEN', env);
  if (envToken) {
    const config = opts.surface === 'cli' ? readConfigOrNull(load) : null;
    const pairHere = opts.surface !== 'mcp';
    const active = usableActive(config);
    const activeToken = active ? config?.projects[active]?.token : undefined;
    return {
      source: 'env-token',
      key: null,
      token: envToken,
      project: null,
      target: pairHere ? resolveSupabaseTarget({ flags: {}, project: undefined, env }) : null,
      activeProject: active,
      overridesActive: Boolean(active && activeToken !== envToken),
    };
  }

  // (b) HARMONY_PROJECT.
  const wanted = harmonyEnv('HARMONY_PROJECT', env)?.trim();
  if (wanted) {
    let config: HarmonyConfig;
    try {
      config = load();
    } catch (e) {
      throw new ProjectResolutionError(
        `HARMONY_PROJECT=${wanted} is set but ${getConfigFile()} cannot be read: ${(e as Error).message}`,
      );
    }
    const p = config.projects[wanted];
    if (!p || typeof p.token !== 'string' || p.token.length === 0) {
      const stored = Object.keys(config.projects);
      throw new ProjectResolutionError(
        `HARMONY_PROJECT=${wanted} names no project stored in ${getConfigFile()}` +
          (stored.length ? ` (stored: ${stored.join(', ')})` : ' (none is stored)') +
          '. Run `harmony project list`, or save its token with `harmony login --no-activate --token-stdin`.',
      );
    }
    const target = checkStoredPair(wanted, p, env);
    const active = usableActive(config);
    return {
      source: 'harmony-project',
      key: wanted,
      token: p.token,
      project: p,
      target,
      expectedProjectId: p.projectId,
      expectedLabel: `HARMONY_PROJECT=${wanted}`,
      activeProject: active,
      overridesActive: Boolean(active && active !== wanted),
    };
  }

  // (c) the active project — the CLI only.
  if (opts.surface === 'mcp') {
    throw new ProjectResolutionError(MCP_MISSING_MESSAGE);
  }
  if (opts.surface === 'conductor-operator') {
    // A URL without its key is named first (MissingAnonKeyError), so the person fixes that half too.
    resolveSupabaseTarget({ flags: {}, project: undefined, env });
    throw new ProjectResolutionError(OPERATOR_MISSING_MESSAGE);
  }
  const config = load();
  const active = usableActive(config);
  if (!active) {
    const stored = Object.keys(config.projects);
    if (stored.length > 0) {
      throw new Error(`No active project. Run \`harmony project switch <name>\` to pick one of the stored projects: ${stored.join(', ')}.`);
    }
    throw new Error('No active project. Run `harmony login` to add one.');
  }
  const p = config.projects[active];
  const target = resolveSupabaseTarget({ flags: {}, project: p, env });
  if (p.verifiedUrl && trimUrl(target.url) !== trimUrl(p.verifiedUrl)) {
    const from = target.source === 'env' ? 'HARMONY_SUPABASE_URL' : target.source === 'default' ? 'the built-in default' : 'its stored Supabase settings';
    throw new ProjectResolutionError(
      `The active project "${active}" was saved against ${trimUrl(p.verifiedUrl)} but this call would use ${trimUrl(target.url)} (from ${from}); refusing to send its token to another backend. ` +
        `Unset HARMONY_SUPABASE_URL (and its key), or switch to the project stored for that backend.`,
    );
  }
  return {
    source: 'active-project',
    key: active,
    token: p.token,
    project: p,
    target,
    activeProject: active,
    overridesActive: false,
  };
}

/** Which source is in force, and why, in plain words. Names only. */
export function describeSource(r: Pick<ResolvedProject, 'source' | 'key' | 'activeProject'>): string {
  switch (r.source) {
    case 'env-token':
      return r.activeProject
        ? `HARMONY_API_TOKEN in the environment (it wins over the active project "${r.activeProject}")`
        : 'HARMONY_API_TOKEN in the environment (no active project is configured)';
    case 'harmony-project':
      return r.activeProject && r.activeProject !== r.key
        ? `HARMONY_PROJECT=${r.key} in the environment (it wins over the active project "${r.activeProject}")`
        : `HARMONY_PROJECT=${r.key} in the environment`;
    case 'active-project':
      return `the active project "${r.key}" (neither HARMONY_API_TOKEN nor HARMONY_PROJECT is set)`;
  }
}

/** The one stderr line printed when the environment overrides a different active project. */
export function overrideNotice(r: ResolvedProject): string | null {
  if (!r.overridesActive) return null;
  if (r.source === 'env-token') {
    return `harmony: using HARMONY_API_TOKEN from the environment, not the active project "${r.activeProject}" (the environment wins; unset HARMONY_API_TOKEN to use "${r.activeProject}")`;
  }
  return `harmony: using HARMONY_PROJECT=${r.key} from the environment, not the active project "${r.activeProject}" (the environment wins; unset HARMONY_PROJECT to use "${r.activeProject}")`;
}

/** B-1501 fix 8: the Supabase URL the CLI's token exchange will use in this shell — the same
 *  resolution getAuthenticatedContext makes (HARMONY_API_TOKEN with the environment's pair, then
 *  HARMONY_PROJECT's stored pair, then the active project's). undefined when no project resolves
 *  (the caller falls back to the environment / built-in default, as before). Names a URL only. */
export function resolvedCliSupabaseUrl(opts: { env?: NodeJS.ProcessEnv; loadConfig?: () => HarmonyConfig } = {}): string | undefined {
  const env = opts.env ?? process.env;
  try {
    const r = resolveProject({ surface: 'cli', env, loadConfig: opts.loadConfig });
    return (r.target ?? resolveSupabaseTarget({ flags: {}, project: undefined, env })).url;
  } catch {
    return undefined;
  }
}
