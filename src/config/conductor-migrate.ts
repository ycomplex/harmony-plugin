// B-1170 (round A): derive the two new conductor files from TODAY's sources — pure, no I/O. File writing
// belongs to the `harmony conductor config migrate` command (round B).
//
// SPLIT RULE. Machine-specific values (plugin_dir, github_app, gcloud.account, gke.context, and a
// config_repo when HARMONY_CONDUCTOR_CONFIG_REPO is set) go to the HOST file; everything the project owns
// goes to the PROJECT file. Secret VALUES are never copied anywhere: they are listed in `dropped` and stay
// in Secret Manager / the service environment. Anything with no new-schema home is also listed in
// `dropped` with a reason — and migrate never deletes anything, so deployment.json keeps supplying those
// (the loader overlays the new files on top of it; see projectToDeploymentConfig).

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

const SECRET_REASON = 'secret value: stays in Secret Manager / the service environment';
const KEEPS_REASON = 'no conductor.json key; deployment.json keeps supplying it';

const SECRET_ENV_KEYS = ['HARMONY_API_TOKEN', 'GIT_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'HARMONY_SUPABASE_ANON_KEY'];
const PLAIN_ENV_KEYS = ['HARMONY_TARGET', 'HARMONY_SUPABASE_URL', 'GIT_USER_NAME', 'GIT_USER_EMAIL', 'WEB_REF', 'WORKSPACE_REF', 'CLAUDE_HEADLESS_FLAGS'];

export function buildMigration(input: {
  legacyDeployment: DeploymentConfig | null;
  env: NodeJS.ProcessEnv;
  profileName?: string;
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
  if (dep?.repos) dropped.push({ item: 'deployment.json › repos', reason: KEEPS_REASON });
  if (dep?.launcher?.supabase?.url) dropped.push({ item: 'deployment.json › launcher.supabase.url', reason: KEEPS_REASON });
  if (dep?.launcher?.supabase_refs) dropped.push({ item: 'deployment.json › launcher.supabase_refs', reason: KEEPS_REASON });
  for (const [name, p] of Object.entries(dep?.profiles ?? {})) {
    if (name !== profileName) {
      dropped.push({ item: `deployment.json › profiles.${name}`, reason: `profile ${name} has no conductor.json equivalent; deployment.json keeps supplying it` });
      continue;
    }
    const b = BUILTIN_PROFILES[profileName];
    if (p.launch !== b.launch || p.reap !== b.reap || p.probe !== b.probe) {
      dropped.push({ item: `deployment.json › profiles.${name} custom launch/reap/probe template`, reason: 'conductor.json names a built-in template and ignores a custom one; deployment.json keeps it only until conductor.json takes over' });
    }
    if (p.required_tools && JSON.stringify(p.required_tools) !== JSON.stringify(b.required_tools)) {
      dropped.push({ item: `deployment.json › profiles.${name}.required_tools override`, reason: KEEPS_REASON });
    }
    if (p.docker_host) dropped.push({ item: `deployment.json › profiles.${name}.docker_host`, reason: KEEPS_REASON });
  }

  return { projectFile, hostFile, dropped, warnings };
}
