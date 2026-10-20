// B-1171: the settings a lifecycle command acts on, and the PRE-FLIGHT shared by `start`, `restart` and the
// profile switch (container/gke/switch-daemon-profile.sh runs the same checks in bash).
//
// Pre-flight is READ-ONLY and runs BEFORE any signal is sent, so a failed check leaves the running conductor
// and its leases untouched. Every check is reported by NAME; credentials are reported by NAME only, never by
// value. The config check is `harmony conductor config doctor`'s own logic (runDoctor), not a copy.

import { join } from 'node:path';
import {
  evaluateConductorConfig,
  launchEnvFromMerged,
  resolveConductorPaths,
  type ConductorConfig,
  type ConductorPaths,
} from '../../config/conductor-config.js';
import { resolveConductorSecrets } from '../../config/conductor-secrets.js';
import { loadLegacyDeploymentConfig } from '../../config/deployment-config.js';
import type { BoardRow } from '../../daemon/conductor-board.js';
import { runDoctor } from './conductor-config.js';
import type { LifecycleDeps } from './conductor-lifecycle-deps.js';

export type Env = Record<string, string | undefined>;

/** Variables the sourcing shell itself sets or changes: not the env file's content. */
const SHELL_NOISE = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD']);

export interface ConductorSettings {
  /** Effective environment: launch env derived from the config files < this shell < the conductor env file. */
  env: Env;
  paths: ConductorPaths;
  /** The conductor env file that was loaded (conductor.env, else the legacy daemon.env), or null. */
  envFile: { path: string; legacy: boolean } | null;
  envFileError?: string;
  /** B-1173: reading the host file's named secrets failed (names only, never values). */
  secretsError?: string;
  merged: ConductorConfig | null;
  configIssues: string[];
  pluginDir: string;
  channel?: 'staging' | 'prod';
  /** The profile to run under: --profile, else the config file's. */
  profile?: string;
  /** --config passthrough (a deployment.json path), when given. */
  deploymentConfig?: string;
}

export interface SettingsOptions {
  profile?: string;
  config?: string;
}

/** Source the env file with a real shell (the launcher's semantics) and read it back as JSON. Values stay in
 *  memory; nothing is printed. */
export async function sourceEnvFile(deps: LifecycleDeps, file: string): Promise<{ env: Env } | { error: string }> {
  const script = 'set -a; . "$1" >/dev/null 2>&1 || exit 97; exec node -e \'process.stdout.write(JSON.stringify(process.env))\'';
  const r = await deps.exec('bash', ['-c', script, '_', file]);
  if (r.code !== 0) return { error: `env file could not be loaded: ${file}` };
  try {
    return { env: JSON.parse(r.stdout) as Env };
  } catch {
    return { error: `env file could not be loaded: ${file}` };
  }
}

export async function loadSettings(deps: LifecycleDeps, opts: SettingsOptions = {}): Promise<ConductorSettings> {
  const paths = resolveConductorPaths(deps.env);
  const envPath = join(paths.home, 'conductor.env');
  const legacyPath = join(paths.home, 'daemon.env');
  let envFile: ConductorSettings['envFile'] = null;
  const fileEnv: Env = {};
  let envFileError: string | undefined;
  const chosen = deps.existsSync(envPath) ? { path: envPath, legacy: false } : deps.existsSync(legacyPath) ? { path: legacyPath, legacy: true } : null;
  if (chosen) {
    const r = await sourceEnvFile(deps, chosen.path);
    envFile = chosen;
    if ('env' in r) {
      // Only what the file ADDS or CHANGES over this shell matters; the rest is the shell's own environment.
      for (const [k, v] of Object.entries(r.env)) if (deps.env[k] !== v && !SHELL_NOISE.has(k)) fileEnv[k] = v;
    } else envFileError = r.error;
  }

  // The config files are evaluated against the same environment the conductor would see.
  const evalEnv: Env = { ...deps.env, ...fileEnv };
  // B-1173: a host whose secrets block names the token / App key needs no env file of values: resolve them here,
  // in memory, so the pre-flight can read the board. The child conductor resolves for itself. An env var that is
  // already set wins and costs no call.
  let secretsError: string | undefined;
  try {
    await resolveConductorSecrets({
      env: evalEnv as Record<string, string | undefined>,
      target: evalEnv,
      exec: async (file, args) => {
        const r = await deps.exec(file, args, { env: evalEnv });
        return { code: r.code, stdout: r.stdout };
      },
      readFile: deps.readFileSync,
    });
  } catch (err) {
    secretsError = err instanceof Error ? err.message : String(err);
  }

  let merged: ConductorConfig | null = null;
  const configIssues: string[] = [];
  try {
    const ev = evaluateConductorConfig({
      env: evalEnv as NodeJS.ProcessEnv,
      existsSync: deps.existsSync,
      readFileSync: deps.readFileSync,
      warn: () => {},
      loadLegacy: () => loadLegacyDeploymentConfig({ configPath: opts.config, env: evalEnv as NodeJS.ProcessEnv, existsSync: deps.existsSync, readFileSync: deps.readFileSync }),
    });
    if (ev) {
      merged = ev.merged;
      for (const i of ev.issues) configIssues.push(`${i.file} › ${i.key}: ${i.problem}`);
    }
  } catch (err) {
    configIssues.push(err instanceof Error ? err.message : String(err));
  }

  const launchEnv = merged && configIssues.length === 0 ? launchEnvFromMerged(merged) : {};
  const env: Env = { ...launchEnv, ...evalEnv };
  return {
    env,
    paths,
    envFile,
    envFileError,
    secretsError,
    merged,
    configIssues,
    pluginDir: env.HARMONY_PLUGIN_DIR || deps.cliPluginDir,
    channel: merged?.channel,
    profile: opts.profile ?? merged?.profile,
    deploymentConfig: opts.config,
  };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface PreflightResult {
  checks: Check[];
  warnings: string[];
  /** The board as read by the credential check, reused so a command reads it once. */
  board: BoardRow[] | null;
  ok: boolean;
}

export interface PreflightOptions {
  /** Install a supervisor job (`start --local|--at-boot`): adds the auto-login / lingering warnings. */
  supervise?: 'local' | 'at-boot';
  /** The channel branch must be checked out in the plugin dir (every restart path pulls it). */
  pull?: boolean;
}

const has = (v: string | undefined): boolean => v !== undefined && v !== '';

async function haveTool(deps: LifecycleDeps, tool: string): Promise<boolean> {
  return (await deps.exec('sh', ['-c', 'command -v "$1"', '_', tool])).code === 0;
}

export async function runPreflight(deps: LifecycleDeps, s: ConductorSettings, opts: PreflightOptions = {}): Promise<PreflightResult> {
  const checks: Check[] = [];
  const warnings: string[] = [];
  const add = (name: string, ok: boolean, detail: string, fix?: string) => checks.push({ name, ok, detail, fix });

  // --- config: harmony conductor config doctor's own logic
  if (s.envFileError) add('env-file', false, s.envFileError, `repair ${s.envFile?.path}`);
  else if (s.envFile) add('env-file', true, `loaded ${s.envFile.path} (values not shown)${s.envFile.legacy ? ' — legacy name, rename it to conductor.env' : ''}`);
  else add('env-file', true, 'no conductor.env: using this shell\'s environment only');
  if (s.secretsError) add('secrets', false, s.secretsError, 'check the host file\'s secrets block, gcloud, and Secret Manager access');
  const doctor = runDoctor(
    { env: s.env as NodeJS.ProcessEnv, existsSync: deps.existsSync, readFileSync: deps.readFileSync },
    { config: s.deploymentConfig },
  );
  const issueLines = (doctor.data.issues as Array<{ text: string }>).map((i) => i.text);
  add('config', doctor.exitCode === 0, doctor.exitCode === 0 ? 'harmony conductor config doctor: ok' : `${issueLines.length} issue(s): ${issueLines.slice(0, 3).join(' | ')}`, 'run `harmony conductor config doctor` and fix what it lists');

  // --- tools, per profile
  const tools = ['git', 'node'];
  if (s.profile === 'gke') tools.push('kubectl');
  else if (s.profile === 'cloud') tools.push('gcloud');
  else if (s.profile) tools.push('kubectl', 'gcloud');
  for (const t of tools) {
    const ok = await haveTool(deps, t);
    add(`tool:${t}`, ok, ok ? `${t} found on PATH` : `${t} is not on PATH`, `install ${t} or fix PATH`);
  }
  if (!s.profile) add('profile', true, 'profile not determined (no config file names one and none was passed): only generic tools were checked');

  // --- credentials, by NAME only
  const tokenOk = has(s.env.HARMONY_API_TOKEN);
  add('cred:HARMONY_API_TOKEN', tokenOk, tokenOk ? 'present' : 'not set', 'name its secret in conductor-host.json ("secrets": { "api_token": "<secret-name>" }) or export HARMONY_API_TOKEN');
  let board: BoardRow[] | null = null;
  if (tokenOk) {
    try {
      board = await deps.readBoard(s.env);
      add('cred:board', true, 'the board is readable with HARMONY_API_TOKEN');
    } catch (err) {
      add('cred:board', false, `the board could not be read: ${err instanceof Error ? err.message : String(err)}`, 'check HARMONY_API_TOKEN and the network');
    }
  } else add('cred:board', false, 'not attempted: HARMONY_API_TOKEN is not set');
  const keyPath = s.env.HARMONY_APP_PRIVATE_KEY_PATH;
  if (has(s.env.HARMONY_APP_PRIVATE_KEY)) add('cred:github-app-key', true, 'HARMONY_APP_PRIVATE_KEY present');
  else if (has(keyPath)) {
    const readable = (() => {
      try {
        deps.readFileSync(keyPath as string);
        return true;
      } catch {
        return false;
      }
    })();
    add('cred:github-app-key', readable, readable ? 'HARMONY_APP_PRIVATE_KEY_PATH points at a readable file' : 'HARMONY_APP_PRIVATE_KEY_PATH names a file that is missing or unreadable', 'fix github_app.private_key_path in conductor-host.json');
  } else add('cred:github-app-key', false, 'neither HARMONY_APP_PRIVATE_KEY_PATH nor HARMONY_APP_PRIVATE_KEY is set', 'set github_app.private_key_path in conductor-host.json');

  // --- reach
  if (s.profile === 'gke') {
    const ns = s.env.HARMONY_GKE_NAMESPACE || 'harmony-legs';
    const secret = s.env.HARMONY_GKE_BASE_SECRET || 'harmony-worker-secrets';
    const args = ['-n', ns, ...(has(s.env.HARMONY_GKE_CONTEXT) ? ['--context', s.env.HARMONY_GKE_CONTEXT as string] : []), 'get', 'secret', secret];
    const r = await deps.exec('kubectl', args, { env: s.env });
    add('reach:gke-base-secret', r.code === 0, r.code === 0 ? `base Secret ${ns}/${secret} exists` : `kubectl cannot read base Secret ${ns}/${secret}`, 'check the kubeconfig context, or run container/gke/setup-cluster.sh');
  } else if (s.profile === 'cloud') {
    const job = s.env.HARMONY_CLOUD_RUN_JOB;
    const region = s.env.HARMONY_CLOUD_RUN_REGION;
    const project = s.env.CLOUDSDK_CORE_PROJECT || 'harmony-conductor';
    if (!has(job) || !has(region)) {
      add('reach:cloud-run-job', false, `${[!has(job) ? 'HARMONY_CLOUD_RUN_JOB' : '', !has(region) ? 'HARMONY_CLOUD_RUN_REGION' : ''].filter(Boolean).join(', ')} not set`, 'set cloud_run.job and gcp.region in the config files');
    } else {
      const r = await deps.exec('gcloud', ['run', 'jobs', 'describe', job as string, `--region=${region}`, `--project=${project}`, '--format=value(name)'], { env: s.env });
      add('reach:cloud-run-job', r.code === 0, r.code === 0 ? `Cloud Run job ${job} exists` : `Cloud Run job ${job} (region ${region}, project ${project}) does not exist or is unreadable`, 'check gcloud auth and the job name');
    }
  }

  // --- the channel branch (restart paths pull it)
  if (opts.pull && s.channel) {
    const r = await deps.exec('git', ['-C', s.pluginDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = r.stdout.trim();
    const ok = r.code === 0 && branch === s.channel;
    add('channel-branch', ok, ok ? `${s.pluginDir} is on ${s.channel}` : r.code === 0 ? `${s.pluginDir} is on branch '${branch}', the config names channel '${s.channel}'` : `${s.pluginDir} is not a git checkout`, `git -C ${s.pluginDir} checkout ${s.channel}`);
  }

  // --- start-at-login warnings
  if (opts.supervise === 'local') {
    if (deps.platform === 'darwin') {
      const r = await deps.exec('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']);
      if (r.code !== 0) warnings.push('macOS automatic login is off: a LaunchAgent starts at LOGIN, so after a reboot the conductor will not run until someone logs in. Turn on automatic login, or use `harmony conductor start --at-boot`.');
    } else if (deps.platform === 'linux') {
      const r = await deps.exec('loginctl', ['show-user', deps.username, '-p', 'Linger']);
      if (/Linger=no/.test(r.stdout)) warnings.push(`lingering is off for ${deps.username}: a systemd user unit starts at login, so after a reboot the conductor will not run until you log in. Run \`sudo loginctl enable-linger ${deps.username}\`.`);
    }
  }

  return { checks, warnings, board, ok: checks.every((c) => c.ok) };
}

export function formatChecks(checks: Check[]): string[] {
  return checks.map((c) => `  [${c.ok ? 'ok  ' : 'FAIL'}] ${c.name}: ${c.detail}${!c.ok && c.fix ? `. Fix: ${c.fix}` : ''}`);
}

export const failedNames = (checks: Check[]): string[] => checks.filter((c) => !c.ok).map((c) => c.name);
