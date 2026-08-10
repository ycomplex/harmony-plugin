// B-800: the single per-deployment config file — ~/.harmony/deployment.json by default.
//
// Replaces THREE previously-separate mechanisms with one JSON file, three top-level sections:
//   env      — the worker base env today held in ~/.harmony-container.env (container/env.example).
//   profiles — keyed by profile name (local, cloud, …), replacing the standalone
//              ~/.harmony-daemon-profile-*.json files (see src/daemon/config.ts's LaunchProfile).
//   launcher — the launcher-host env contract (HARMONY_PLUGIN_DIR, the GitHub App id/installation
//              id/key path, the Supabase env triple) plus supabase_refs (replaces
//              src/tools/environment.ts's KNOWN_REFS).
//
// The config file PATH is an instance parameter, not a fixed location — one machine can run N
// daemon deployments bound to N boards, each with its own file. Resolution order: an explicit
// configPath argument > HARMONY_DEPLOYMENT_CONFIG env var > the single-deployment default
// ~/.harmony/deployment.json.
//
// This module is the ONLY place that knows the file's shape (zod is the single source of truth for
// shape and defaults) — shell consumers never re-implement parsing; they call `harmony config get`
// (src/cli/commands/config.ts), which is backed by this same loader.
//
// Loading degrades gracefully: most machines have no deployment config at all, so a missing file at
// the resolved path returns null everywhere this is consulted (never throws). A file that EXISTS but
// is malformed (bad JSON or a schema violation) throws with a clear message — a typo in a file you
// meant to be read should never fail silently.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// --- env: the worker base env (container/env.example) -----------------------------------------
const DeploymentEnvSchema = z
  .object({
    HARMONY_TARGET: z.enum(['prod', 'staging', 'custom']).optional(),
    HARMONY_API_TOKEN: z.string().optional(),
    HARMONY_SUPABASE_ANON_KEY: z.string().optional(),
    HARMONY_SUPABASE_URL: z.string().optional(),
    // Git identity.
    GIT_TOKEN: z.string().optional(),
    GIT_USER_NAME: z.string().optional(),
    GIT_USER_EMAIL: z.string().optional(),
    // Ref pins.
    WEB_REF: z.string().optional(),
    WORKSPACE_REF: z.string().optional(),
    // B-803: the single posture knob — collapses the old PLUGIN_REF + HARMONY_ACK_PLUGIN_AHEAD_OF_PROD
    // pair (which could be set inconsistently, and the ack half was unreachable on the cloud
    // profile). Encodes which plugin ref to run AND whether running it ahead of prod is
    // acknowledged: "prod" | "ack:<ref>" | a bare "<ref>" (unacknowledged) — see provision.sh.
    HARMONY_PLUGIN_POSTURE: z.string().optional(),
    // Agent layer.
    CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    CLAUDE_HEADLESS_FLAGS: z.string().optional(),
  })
  .partial();

// --- profiles: keyed launch profiles (mirrors src/daemon/config.ts's LaunchProfile) ------------
const LaunchProfileSchema = z.object({
  /** Command template that launches a one-shot worker. Placeholders: {conduction_id}, {ticket}. */
  launch: z.string().min(1),
  /** Command template that force-removes a (possibly dead) worker. Same placeholders. */
  reap: z.string().min(1),
  /** Optional restart-reconciliation probe template — see src/daemon/config.ts's LaunchProfile. */
  probe: z.string().min(1).optional(),
  /** This profile's own concurrency ceiling. */
  maxConcurrentWorkers: z.number().int().nonnegative().optional(),
  /** B-800: replaces the CLOUDSDK_CORE_PROJECT hardcoded default baked into cloud-worker-*.sh —
   *  the cloud profile's GCP project, read by those scripts via `harmony config get`. */
  gcloud_project: z.string().optional(),
});

// --- launcher: the launcher-host env contract ----------------------------------------------------
const GithubAppSchema = z
  .object({
    app_id: z.string(),
    installation_id: z.string(),
    private_key_path: z.string().optional(),
  })
  .partial({ private_key_path: true });

const LauncherSupabaseSchema = z.object({
  url: z.string(),
  anon_key: z.string().optional(),
  api_token: z.string().optional(),
});

const LauncherSchema = z
  .object({
    plugin_dir: z.string().optional(),
    github_app: GithubAppSchema.optional(),
    supabase: LauncherSupabaseSchema.optional(),
    /** Project-ref -> target name map, replacing src/tools/environment.ts's KNOWN_REFS. Merged
     *  OVER (not instead of) the two baked-in defaults, never replacing them. */
    supabase_refs: z.record(z.enum(['prod', 'staging'])).optional(),
  })
  .partial();

export const DeploymentConfigSchema = z.object({
  env: DeploymentEnvSchema.optional(),
  profiles: z.record(LaunchProfileSchema).optional(),
  launcher: LauncherSchema.optional(),
});

export type DeploymentEnv = z.infer<typeof DeploymentEnvSchema>;
export type LaunchProfileConfig = z.infer<typeof LaunchProfileSchema>;
export type LauncherConfig = z.infer<typeof LauncherSchema>;
export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;

/** Resolve the config file path: explicit param > HARMONY_DEPLOYMENT_CONFIG > the single-deployment
 *  default ~/.harmony/deployment.json. Exported so shell-facing callers (the CLI `config get`
 *  subcommand) can report which path they resolved to without duplicating this precedence. */
export function resolveDeploymentConfigPath(opts?: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const env = opts?.env ?? process.env;
  if (opts?.configPath) return opts.configPath;
  if (env.HARMONY_DEPLOYMENT_CONFIG) return env.HARMONY_DEPLOYMENT_CONFIG;
  return join(homedir(), '.harmony', 'deployment.json');
}

export interface LoadDeploymentConfigOptions {
  /** Explicit path, takes precedence over HARMONY_DEPLOYMENT_CONFIG and the default. */
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable so this loader is unit-testable without touching the real filesystem. */
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string) => string;
}

/** Load + validate the deployment config from whichever path this instance was launched with.
 *  Returns null (never throws) when no file exists at the resolved path — most machines won't have
 *  one, and every call site must degrade gracefully. Throws a clear error when the file exists but
 *  is malformed (bad JSON or a schema violation) — that case is a real misconfiguration, not an
 *  absence, and must fail loud rather than silently fall back. */
export function loadDeploymentConfig(opts: LoadDeploymentConfigOptions = {}): DeploymentConfig | null {
  const env = opts.env ?? process.env;
  const exists = opts.existsSync ?? existsSync;
  const readFile = opts.readFileSync ?? ((p: string) => readFileSync(p, 'utf8'));
  const path = resolveDeploymentConfigPath({ configPath: opts.configPath, env });

  if (!exists(path)) return null;

  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    throw new Error(
      `could not read deployment config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `deployment config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = DeploymentConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`deployment config at ${path} failed validation: ${result.error.message}`, {
      cause: result.error,
    });
  }
  return result.data;
}

/** Resolve a dot-path (e.g. "launcher.supabase_refs.prod") against a loaded config object — the
 *  primitive behind `harmony config get`. Returns undefined for a missing path at any depth; the
 *  caller decides how to report that (the CLI treats it as "not configured"). */
export function resolveConfigPath(config: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.').filter((p) => p.length > 0);
  let cur: unknown = config;
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
