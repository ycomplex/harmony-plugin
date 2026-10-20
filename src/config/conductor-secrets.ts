// B-1173: the BOOT-TIME SECRETS RESOLVER of a remote conductor.
//
// (Runs in every mode since the B-1173 acceptance change: see resolveConductorSecrets.)
// A pod has no ~/.harmony/conductor.env and no key file. What it has is a Workload Identity that may read the
// project's Secret Manager secrets, and the host file's `secrets` block, which holds secret NAMES only. When
// HARMONY_CONDUCTOR_REMOTE=1 the daemon calls this BEFORE anything reads HARMONY_API_TOKEN, and the values land in
// the process environment only:
//
//   secrets.api_token               -> HARMONY_API_TOKEN
//   secrets.github_app_private_key  -> HARMONY_APP_PRIVATE_KEY   (inline key contents; no private_key_path needed)
//
// `base` and `codex_auth` are names the launch scripts hand to the leg Jobs; the conductor does not read them.
//
// Secrets discipline: the value is read from the `gcloud` child's stdout through an injectable exec, so no value is
// ever in argv (only the secret NAME and the project), never logged, never written to a file, and an error names
// the secret NAME only (gcloud's stderr is dropped: a failure message is not worth risking a value in it). A key
// already present in the environment wins and costs no call (env-wins, like every other host-file default).
// The host file's gcloud.account is passed as --account so the read uses the conductor's identity, not gcloud's active one.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { HostFileSchema, resolveConductorPaths, SECRET_KEYS } from './conductor-config.js';
import { isRemoteConductor } from '../daemon/conductor-remote.js';

type Env = Record<string, string | undefined>;

export interface SecretExecResult {
  code: number;
  stdout: string;
}

/** Runs `file args`, returning the exit code and stdout. Never throws: a missing binary is code 127. */
export type SecretExec = (file: string, args: string[]) => Promise<SecretExecResult>;

/** logical secrets key -> the environment variable it fills. */
export const SECRET_ENV_TARGETS: ReadonlyArray<{ key: string; envVar: string }> = [
  { key: SECRET_KEYS.apiToken, envVar: 'HARMONY_API_TOKEN' },
  { key: SECRET_KEYS.githubAppPrivateKey, envVar: 'HARMONY_APP_PRIVATE_KEY' },
];

export class ConductorSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConductorSecretsError';
  }
}

export interface ResolveSecretsDeps {
  env: Env;
  /** Where the resolved values are placed (process.env in the daemon). */
  target: Env;
  exec: SecretExec;
  readFile?: (path: string) => string;
}

export interface ResolveSecretsResult {
  /** Env var NAMES that were filled from Secret Manager. Never values. */
  resolved: string[];
  /** Env var names that were already set and so left alone. */
  skipped: string[];
}

/** The GCP project the secrets live in: the host file's gcp.project, else the usual environment variables. */
function projectOf(host: { gcp?: { project?: string } }, env: Env): string | undefined {
  return host.gcp?.project || env.HARMONY_GCP_PROJECT || env.CLOUDSDK_CORE_PROJECT || env.GOOGLE_CLOUD_PROJECT || undefined;
}

/** Resolves whichever of the two names the host file's secrets block carries and the env does not already set. Strict in remote mode (HARMONY_CONDUCTOR_REMOTE=1: missing file/entry is an error); lenient locally (nothing to do => no-op). Throws ConductorSecretsError (naming secret NAMES only) on any problem. */
export async function resolveConductorSecrets(deps: ResolveSecretsDeps): Promise<ResolveSecretsResult> {
  const result: ResolveSecretsResult = { resolved: [], skipped: [] };
  const remote = isRemoteConductor(deps.env);
  // Mode-independent (B-1173 AC): a LOCAL host that names `api_token` / `github_app_private_key` in its secrets
  // block resolves them too, so it needs no conductor.env of secret values. A local host whose host file is
  // absent, unreadable, invalid or names neither key is left byte-unchanged: no call, no new failure.

  const hostPath = resolveConductorPaths(deps.env as NodeJS.ProcessEnv).hostFile;
  const read = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  let text: string;
  try {
    text = read(hostPath);
  } catch {
    if (!remote) return result;
    throw new ConductorSecretsError(`the host file ${hostPath} could not be read; a conductor with a secrets block takes its secret names from its "secrets" block`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    if (!remote) return result;
    throw new ConductorSecretsError(`the host file ${hostPath} is not valid JSON`);
  }
  const parsed = HostFileSchema.safeParse(json);
  if (!parsed.success) {
    if (!remote) return result;
    // zod messages name keys, never values (the secrets block is names-only and a value-looking name is refused by key).
    const first = parsed.error.issues[0];
    throw new ConductorSecretsError(`the host file ${hostPath} is invalid: ${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'unknown problem'}`);
  }
  const secrets = parsed.data.secrets ?? {};
  const project = projectOf(parsed.data, deps.env);
  // B-1183: this runs BEFORE the host file's gcloud.account is applied to the environment (applyLaunchEnv sets
  // CLOUDSDK_CORE_ACCOUNT later), so without this the call would use gcloud's ACTIVE account. An account already
  // in the environment still wins, like every other host-file default.
  const account = deps.env.CLOUDSDK_CORE_ACCOUNT ? undefined : parsed.data.gcloud?.account;

  for (const { key, envVar } of SECRET_ENV_TARGETS) {
    const name = secrets[key];
    if (deps.target[envVar]) {
      result.skipped.push(envVar);
      continue;
    }
    if (!name) {
      // api_token is required to run at all; the App key may instead come from a file path or be absent (cloud profile).
      if (remote && key === SECRET_KEYS.apiToken) throw new ConductorSecretsError(`HARMONY_API_TOKEN is not set and the host file's secrets block has no "${key}" entry naming its secret`);
      continue;
    }
    if (!project) {
      throw new ConductorSecretsError(`cannot read secret "${name}": no GCP project (set gcp.project in the host file, or HARMONY_GCP_PROJECT)`);
    }
    const r = await deps.exec('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${name}`, `--project=${project}`, ...(account ? [`--account=${account}`] : [])]);
    if (r.code !== 0) {
      throw new ConductorSecretsError(`could not read secret "${name}" (for ${envVar}) from Secret Manager: gcloud exited ${r.code}${r.code === 127 ? ' (gcloud is not installed)' : ''}`);
    }
    const value = r.stdout.replace(/\r?\n$/, '');
    if (value.length === 0) throw new ConductorSecretsError(`secret "${name}" (for ${envVar}) is empty`);
    deps.target[envVar] = value;
    result.resolved.push(envVar);
  }
  return result;
}

/** The real exec: stdout captured (never echoed), stderr dropped, bounded. */
export const execFileSecretExec: SecretExec = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { maxBuffer: 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout: String(stdout) });
      const code = (err as NodeJS.ErrnoException).code;
      resolve({ code: code === 'ENOENT' ? 127 : typeof code === 'number' ? code : 1, stdout: '' });
    });
  });
