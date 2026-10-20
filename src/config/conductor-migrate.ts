// B-1170 (round A): derive the two new conductor files from TODAY's sources — pure, no I/O. File writing
// belongs to the `harmony conductor config migrate` command (round B).
//
// SPLIT RULE. Machine-specific values (plugin_dir, github_app, gcloud.account, gke.context, and a
// config_repo when HARMONY_CONDUCTOR_CONFIG_REPO is set) go to the HOST file; everything the project owns
// goes to the PROJECT file. Secret VALUES are never copied anywhere: they are listed in `dropped` and stay
// in Secret Manager / the service environment. Anything with no new-schema home is also listed in
// `dropped` with a reason — and migrate never deletes anything, so deployment.json keeps supplying those
// (the loader overlays the new files on top of it; see projectToDeploymentConfig).
//
// B-1183: the project file now has a home for HARMONY_TARGET (`target`), HARMONY_SUPABASE_URL
// (`supabase_url`), CLAUDE_HEADLESS_FLAGS (`agent_flags`), repos[] (`repos`) and every built-in profile
// (`profiles`), and the host file's `secrets` block names the Secret Manager secrets the conductor reads. So
// after migrate, `dropped` holds secret values (they stay where they are) and little else; anything else left
// there — a custom template, docker_host, WEB_REF/WORKSPACE_REF, supabase_refs — means deployment.json is
// STILL NEEDED, which `nonSecretDrops` lets the command say. Secret NAMES are written, never values.

import {
  BUILTIN_PROFILES,
  ConductorConfigError,
  legacyToConductor,
  type BuiltinProfileName,
  type HostFile,
  type ProjectFile,
} from './conductor-config.js';
import type { DeploymentConfig } from './deployment-config.js';

export interface MigrationDrop {
  item: string;
  reason: string;
}

export interface Migration {
  projectFile: ProjectFile;
  hostFile: HostFile;
  dropped: MigrationDrop[];
  warnings: string[];
}

export const DEFAULT_SECRET_NAMES = {
  api_token: 'HARMONY_API_TOKEN',
  github_app_private_key: 'harmony-daemon-app-private-key',
  claude_oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN',
} as const;
export type SecretNameOverrides = Partial<Record<keyof typeof DEFAULT_SECRET_NAMES, string>>;

/** Items in `dropped` that are not secret values: each one means deployment.json is still needed. */
export function nonSecretDrops(dropped: MigrationDrop[]): MigrationDrop[] {
  return dropped.filter((d) => d.reason !== SECRET_REASON);
}

export const SECRET_REASON = 'secret value: stays in Secret Manager / the service environment';
const KEEPS_REASON = 'no conductor.json key; deployment.json keeps supplying it';

const SECRET_ENV_KEYS = ['HARMONY_API_TOKEN', 'GIT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HARMONY_SUPABASE_ANON_KEY'];
const PLAIN_ENV_KEYS = ['GIT_USER_NAME', 'GIT_USER_EMAIL', 'WEB_REF', 'WORKSPACE_REF'];

export function buildMigration(input: {
  legacyDeployment: DeploymentConfig | null;
  env: NodeJS.ProcessEnv;
  profileName?: string;
  secretNames?: SecretNameOverrides;
}): Migration {
  const { legacyDeployment: dep, env } = input;
  const dropped: MigrationDrop[] = [];
  const warnings: string[] = [];
  const askProfile = (problem: string) =>
    new ConductorConfigError({ file: 'deployment.json', key: 'profiles', problem, fix: 'pass --profile cloud (or --profile gke)' });

  // --- which profile
  let profile: string | undefined = input.profileName;
  if (!profile) {
    const names = Object.keys(dep?.profiles ?? {});
    if (names.length === 1) profile = names[0];
    else if (names.length === 0) throw askProfile('no profile is defined, so the conductor profile is ambiguous');
    else throw askProfile(`several profiles are defined (${names.join(', ')}), so the conductor profile is ambiguous`);
  }
  if (!(profile in BUILTIN_PROFILES)) {
    throw askProfile(`profile ${JSON.stringify(profile)} has no conductor.json equivalent (only cloud and gke)`);
  }
  const profileName = profile as BuiltinProfileName;

  // --- field mapping (same as the loader's legacy layer)
  const legacy = legacyToConductor({ deployment: dep, env, profileName });
  warnings.push(...legacy.warnings.filter((w) => !w.startsWith('deprecated:')));
  const layer = legacy.layer as {
    channel?: 'staging' | 'prod';
    images?: { worker?: string };
    gcp?: { project?: string; region?: string };
    cloud_run?: { job?: string };
    gke?: Record<string, string | number> & { context?: string };
    concurrency?: { max_workers?: number };
    agents?: string[];
    plugin_dir?: string;
    github_app?: { app_id?: string; installation_id?: string; private_key_path?: string };
    gcloud?: { account?: string };
  };

  let channel = layer.channel;
  if (!channel) {
    channel = 'staging';
    warnings.push('HARMONY_PLUGIN_POSTURE is not set: channel defaults to "staging" (the same default container/provision.sh applies)');
  }

  // --- split
  const gkeProject = { ...(layer.gke ?? {}) };
  const context = gkeProject.context;
  delete gkeProject.context;

  const projectFile: ProjectFile = { version: 1, channel, profile: profileName };
  if (layer.images?.worker) projectFile.images = { worker: layer.images.worker };
  if (layer.gcp) projectFile.gcp = { ...layer.gcp };
  if (layer.cloud_run) projectFile.cloud_run = { ...layer.cloud_run };
  if (Object.keys(gkeProject).length) projectFile.gke = gkeProject as ProjectFile['gke'];
  if (layer.concurrency) projectFile.concurrency = { ...layer.concurrency };
  if (layer.agents) projectFile.agents = [...layer.agents];

  // --- B-1183: the keys that used to be dropped
  const depEnv = dep?.env ?? {};
  if (depEnv.HARMONY_TARGET) projectFile.target = depEnv.HARMONY_TARGET;
  if (depEnv.HARMONY_SUPABASE_URL) {
    if (depEnv.HARMONY_TARGET === 'custom') projectFile.supabase_url = depEnv.HARMONY_SUPABASE_URL;
    else dropped.push({ item: 'deployment.json › env.HARMONY_SUPABASE_URL', reason: `supabase_url is only allowed with target "custom" (this deployment's target is ${depEnv.HARMONY_TARGET ?? 'unset'}); deployment.json keeps supplying it` });
  }
  if (depEnv.CLAUDE_HEADLESS_FLAGS) projectFile.agent_flags = { 'claude-code': depEnv.CLAUDE_HEADLESS_FLAGS };
  if (dep?.repos) projectFile.repos = dep.repos.map((r) => ({ ...r }));
  // Every built-in profile the deployment lists. The active one already has concurrency / agents at the top
  // level (above), so its block carries only a required_tools override; any other carries all three.
  const profilesBlock: NonNullable<ProjectFile['profiles']> = {};
  for (const [name, p] of Object.entries(dep?.profiles ?? {})) {
    if (!(name in BUILTIN_PROFILES)) continue;
    const b = BUILTIN_PROFILES[name as BuiltinProfileName];
    const block: NonNullable<ProjectFile['profiles']>['cloud'] = {};
    if (name !== profileName) {
      if (p.maxConcurrentWorkers !== undefined) block.max_workers = p.maxConcurrentWorkers;
      if (p.agents) block.agents = [...p.agents];
    }
    if (p.required_tools && JSON.stringify(p.required_tools) !== JSON.stringify(b.required_tools)) block.required_tools = { ...p.required_tools };
    profilesBlock[name as BuiltinProfileName] = block; // even an empty block: listing a profile is what makes it available
  }
  if (Object.keys(profilesBlock).length) projectFile.profiles = profilesBlock;
  // gcp.project comes from the ACTIVE profile only; the cloud scripts read profiles.cloud.gcloud_project.
  const otherCloud = profileName !== 'cloud' ? dep?.profiles?.cloud?.gcloud_project : undefined;
  if (otherCloud) {
    if (!projectFile.gcp?.project) projectFile.gcp = { ...(projectFile.gcp ?? {}), project: otherCloud };
    else if (projectFile.gcp.project !== otherCloud) {
      dropped.push({ item: 'deployment.json › profiles.cloud.gcloud_project', reason: `differs from gcp.project (${projectFile.gcp.project}); the project file has one gcp.project, so deployment.json keeps supplying it` });
    }
  }

  const hostFile: HostFile = { version: 1 };
  if (layer.plugin_dir) hostFile.plugin_dir = layer.plugin_dir;
  if (layer.github_app?.app_id && layer.github_app.installation_id && layer.github_app.private_key_path) {
    hostFile.github_app = {
      app_id: layer.github_app.app_id,
      installation_id: layer.github_app.installation_id,
      private_key_path: layer.github_app.private_key_path,
    };
  } else if (layer.github_app) {
    warnings.push('github_app is incomplete (needs app_id, installation_id and private_key_path): not written to the host file');
  }
  if (layer.gcloud?.account) hostFile.gcloud = { account: layer.gcloud.account };
  if (context !== undefined) hostFile.gke = { context: String(context) };
  if (env.HARMONY_CONDUCTOR_CONFIG_REPO) hostFile.config_repo = env.HARMONY_CONDUCTOR_CONFIG_REPO;
  // Secret NAMES only. claude_oauth_token is a record for preflight / docs: the conductor never reads it.
  const names = { ...DEFAULT_SECRET_NAMES, ...Object.fromEntries(Object.entries(input.secretNames ?? {}).filter(([, v]) => v)) };
  hostFile.secrets = { api_token: names.api_token, github_app_private_key: names.github_app_private_key, claude_oauth_token: names.claude_oauth_token };

  // --- dropped: secrets
  for (const k of SECRET_ENV_KEYS) {
    if (dep?.env?.[k as keyof NonNullable<DeploymentConfig['env']>]) dropped.push({ item: `deployment.json › env.${k}`, reason: SECRET_REASON });
  }
  if (dep?.launcher?.supabase?.anon_key) dropped.push({ item: 'deployment.json › launcher.supabase.anon_key', reason: SECRET_REASON });
  if (dep?.launcher?.supabase?.api_token) dropped.push({ item: 'deployment.json › launcher.supabase.api_token', reason: SECRET_REASON });
  if (env.HARMONY_APP_PRIVATE_KEY) dropped.push({ item: 'env HARMONY_APP_PRIVATE_KEY (GitHub App private key contents)', reason: SECRET_REASON });

  // --- dropped: no new-schema home (deployment.json keeps supplying them)
  for (const k of PLAIN_ENV_KEYS) {
    if (dep?.env?.[k as keyof NonNullable<DeploymentConfig['env']>]) dropped.push({ item: `deployment.json › env.${k}`, reason: KEEPS_REASON });
  }
  if (dep?.launcher?.supabase?.url) dropped.push({ item: 'deployment.json › launcher.supabase.url', reason: KEEPS_REASON });
  if (dep?.launcher?.supabase_refs) dropped.push({ item: 'deployment.json › launcher.supabase_refs', reason: KEEPS_REASON });
  for (const [name, p] of Object.entries(dep?.profiles ?? {})) {
    if (!(name in BUILTIN_PROFILES)) {
      dropped.push({ item: `deployment.json › profiles.${name}`, reason: `profile ${name} has no conductor.json equivalent (only cloud and gke); deployment.json keeps supplying it` });
      continue;
    }
    const b = BUILTIN_PROFILES[name as BuiltinProfileName];
    if (p.launch !== b.launch || p.reap !== b.reap || p.probe !== b.probe) {
      dropped.push({ item: `deployment.json › profiles.${name} custom launch/reap/probe template`, reason: 'conductor.json names a built-in template and ignores a custom one; deployment.json keeps it only until conductor.json takes over' });
    }
    if (p.docker_host) dropped.push({ item: `deployment.json › profiles.${name}.docker_host`, reason: KEEPS_REASON });
  }

  return { projectFile, hostFile, dropped, warnings };
}
