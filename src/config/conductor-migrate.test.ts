import { describe, expect, it } from 'vitest';
import { BUILTIN_PROFILES, ConductorConfigError, HostFileSchema, ProjectFileSchema } from './conductor-config.js';
import { buildMigration, nonSecretDrops, SECRET_REASON } from './conductor-migrate.js';
import type { DeploymentConfig } from './deployment-config.js';

const dep: DeploymentConfig = {
  worker_image: 'ghcr.io/x/img:1',
  env: {
    HARMONY_PLUGIN_POSTURE: 'prod',
    HARMONY_API_TOKEN: 'tok-secret-value',
    GIT_TOKEN: 'ghp_secretsecretsecret',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    ANTHROPIC_API_KEY: 'sk-ant',
    HARMONY_SUPABASE_ANON_KEY: 'anon',
    WEB_REF: 'main',
    GIT_USER_NAME: 'n',
  },
  profiles: {
    cloud: { ...BUILTIN_PROFILES.cloud, gcloud_project: 'proj', maxConcurrentWorkers: 4 },
  },
  launcher: {
    plugin_dir: '/plug',
    github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' },
    supabase: { url: 'https://s', anon_key: 'anon2', api_token: 'api' },
    supabase_refs: { abc: 'prod' },
  },
  repos: [{ url: 'u', path: '/p' }],
};

describe('buildMigration', () => {
  it('splits project vs host values and both outputs satisfy their strict schemas', () => {
    const m = buildMigration({
      legacyDeployment: dep,
      env: { CLOUDSDK_CORE_ACCOUNT: 'a@x', HARMONY_CONDUCTOR_CONFIG_REPO: 'o/cfg', HARMONY_GKE_CONTEXT: 'ctx' },
    });
    expect(m.projectFile).toEqual({
      version: 1,
      channel: 'prod',
      profile: 'cloud',
      images: { worker: 'ghcr.io/x/img:1' },
      gcp: { project: 'proj' },
      concurrency: { max_workers: 4 },
      agents: ['claude-code', 'codex'],
      repos: [{ url: 'u', path: '/p' }],
      profiles: { cloud: {} },
      gke: undefined,
    } as any);
    expect(m.hostFile).toEqual({
      version: 1,
      plugin_dir: '/plug',
      github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' },
      gcloud: { account: 'a@x' },
      gke: { context: 'ctx' },
      config_repo: 'o/cfg',
      secrets: { api_token: 'HARMONY_API_TOKEN', github_app_private_key: 'harmony-daemon-app-private-key', claude_oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN' },
    });
    expect(ProjectFileSchema.safeParse(m.projectFile).success).toBe(true);
    expect(HostFileSchema.safeParse(m.hostFile).success).toBe(true);
  });

  it('never copies secret values and lists them in dropped', () => {
    const m = buildMigration({ legacyDeployment: dep, env: { HARMONY_APP_PRIVATE_KEY: '-----BEGIN' } });
    const blob = JSON.stringify([m.projectFile, m.hostFile]);
    for (const v of ['tok-secret-value', 'ghp_secretsecretsecret', 'oauth', 'sk-ant', 'anon', 'anon2', 'api', '-----BEGIN']) {
      expect(blob).not.toContain(`"${v}"`);
    }
    const secrets = m.dropped.filter((d) => d.reason === SECRET_REASON).map((d) => d.item);
    expect(secrets).toEqual(
      expect.arrayContaining([
        'deployment.json › env.HARMONY_API_TOKEN',
        'deployment.json › env.GIT_TOKEN',
        'deployment.json › env.CLAUDE_CODE_OAUTH_TOKEN',
        'deployment.json › env.ANTHROPIC_API_KEY',
        'deployment.json › env.HARMONY_SUPABASE_ANON_KEY',
        'deployment.json › launcher.supabase.anon_key',
        'deployment.json › launcher.supabase.api_token',
      ]),
    );
    expect(secrets.some((s) => s.includes('HARMONY_APP_PRIVATE_KEY'))).toBe(true);
  });

  it('lists items with no new-schema home, with a reason, and other profiles', () => {
    const m = buildMigration({
      legacyDeployment: { ...dep, profiles: { ...dep.profiles, local: { launch: 'l', reap: 'r' } } },
      env: {},
      profileName: 'cloud',
    });
    const items = m.dropped.map((d) => d.item);
    expect(items).toEqual(
      expect.arrayContaining([
        'deployment.json › env.WEB_REF',
        'deployment.json › launcher.supabase.url',
        'deployment.json › launcher.supabase_refs',
        'deployment.json › profiles.local',
      ]),
    );
    expect(m.dropped.every((d) => d.reason.length > 0)).toBe(true);
  });

  it('flags a custom launch template (a required_tools override moves into profiles.<name>.required_tools)', () => {
    const m = buildMigration({
      legacyDeployment: { ...dep, profiles: { cloud: { ...BUILTIN_PROFILES.cloud, launch: 'custom', required_tools: { launch: ['x'] } } } },
      env: {},
    });
    expect(m.dropped.map((d) => d.item)).toEqual(expect.arrayContaining([expect.stringContaining('custom launch/reap/probe template')]));
    expect(m.dropped.map((d) => d.item).join()).not.toContain('required_tools');
    expect(m.projectFile.profiles).toEqual({ cloud: { required_tools: { launch: ['x'] } } });
  });

  it('an ambiguous profile asks for --profile', () => {
    const two = { ...dep, profiles: { cloud: BUILTIN_PROFILES.cloud, gke: BUILTIN_PROFILES.gke } };
    expect(() => buildMigration({ legacyDeployment: two, env: {} })).toThrow(ConductorConfigError);
    try {
      buildMigration({ legacyDeployment: two, env: {} });
    } catch (e) {
      expect((e as ConductorConfigError).fix).toContain('--profile');
    }
    expect(buildMigration({ legacyDeployment: two, env: {}, profileName: 'gke' }).projectFile.profile).toBe('gke');
  });

  it('a non-builtin sole profile and a missing profile are refused', () => {
    expect(() => buildMigration({ legacyDeployment: { ...dep, profiles: { local: { launch: 'l', reap: 'r' } } }, env: {} })).toThrow(/no conductor.json equivalent/);
    expect(() => buildMigration({ legacyDeployment: null, env: {} })).toThrow(ConductorConfigError);
  });

  it('migrates from env knobs alone (gke) and defaults channel to staging with a warning', () => {
    const m = buildMigration({
      legacyDeployment: null,
      env: { HARMONY_GKE_NAMESPACE: 'n', HARMONY_GKE_POLL_S: '5', CLOUDSDK_CORE_PROJECT: 'p', HARMONY_PLUGIN_DIR: '/pd' },
      profileName: 'gke',
    });
    expect(m.projectFile).toMatchObject({ channel: 'staging', profile: 'gke', gcp: { project: 'p' }, gke: { namespace: 'n', poll_s: 5 } });
    expect(m.hostFile.plugin_dir).toBe('/pd');
    expect(m.warnings.some((w) => w.includes('channel defaults to "staging"'))).toBe(true);
  });
});

// B-1183: the Mac mini's deployment.json, before: migrate DROPPED env.HARMONY_TARGET, repos[],
// env.CLAUDE_HEADLESS_FLAGS and profiles.cloud, and wrote no secrets block.
describe('B-1183 buildMigration: the four keys, every built-in profile and the secrets block', () => {
  const mini: DeploymentConfig = {
    worker_image: 'harmony-build-env',
    env: {
      HARMONY_PLUGIN_POSTURE: 'ack:staging',
      HARMONY_TARGET: 'prod',
      CLAUDE_HEADLESS_FLAGS: '--output-format stream-json',
      HARMONY_API_TOKEN: 'tok-secret-value',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret-value',
      GIT_TOKEN: 'ghp_secretsecretsecret',
    },
    repos: [
      { url: 'https://github.com/o/w.git', path: '/workspace/w', meta_repo_role: true },
      { url: 'https://github.com/o/p.git', path: '/workspace/w/p', is_plugin: true },
    ],
    profiles: {
      gke: { ...BUILTIN_PROFILES.gke, maxConcurrentWorkers: 3 },
      cloud: { ...BUILTIN_PROFILES.cloud, gcloud_project: 'proj', maxConcurrentWorkers: 5, agents: ['claude-code'] },
    },
    launcher: { plugin_dir: '/plug', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' } },
  };

  it('fills target, repos, agent_flags and every built-in profile, and drops only secret values', () => {
    const m = buildMigration({ legacyDeployment: mini, env: {}, profileName: 'gke' });
    expect(m.projectFile).toMatchObject({
      profile: 'gke',
      target: 'prod',
      repos: mini.repos,
      agent_flags: { 'claude-code': '--output-format stream-json' },
      concurrency: { max_workers: 3 },
      profiles: { gke: {}, cloud: { max_workers: 5, agents: ['claude-code'] } },
      gcp: { project: 'proj' },
    });
    expect(ProjectFileSchema.safeParse(m.projectFile).success).toBe(true);
    expect(nonSecretDrops(m.dropped)).toEqual([]);
    expect(m.dropped.every((d) => d.reason === SECRET_REASON)).toBe(true);
  });

  it('puts supabase_url in the project file for target custom, and keeps it dropped otherwise', () => {
    const custom = buildMigration({ legacyDeployment: { ...mini, env: { ...mini.env, HARMONY_TARGET: 'custom', HARMONY_SUPABASE_URL: 'https://x.supabase.co' } }, env: {}, profileName: 'gke' });
    expect(custom.projectFile).toMatchObject({ target: 'custom', supabase_url: 'https://x.supabase.co' });
    expect(ProjectFileSchema.safeParse(custom.projectFile).success).toBe(true);
    const prod = buildMigration({ legacyDeployment: { ...mini, env: { ...mini.env, HARMONY_SUPABASE_URL: 'https://x.supabase.co' } }, env: {}, profileName: 'gke' });
    expect(prod.projectFile.supabase_url).toBeUndefined();
    expect(nonSecretDrops(prod.dropped).map((d) => d.item)).toEqual(['deployment.json › env.HARMONY_SUPABASE_URL']);
  });

  it('writes the default secret NAMES, overridable per name, and never a value', () => {
    const d = buildMigration({ legacyDeployment: mini, env: {}, profileName: 'gke' });
    expect(d.hostFile.secrets).toEqual({
      api_token: 'HARMONY_API_TOKEN',
      github_app_private_key: 'harmony-daemon-app-private-key',
      claude_oauth_token: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
    const o = buildMigration({ legacyDeployment: mini, env: {}, profileName: 'gke', secretNames: { api_token: 'my-token', claude_oauth_token: 'my-oauth' } });
    expect(o.hostFile.secrets).toEqual({ api_token: 'my-token', github_app_private_key: 'harmony-daemon-app-private-key', claude_oauth_token: 'my-oauth' });
    expect(HostFileSchema.safeParse(o.hostFile).success).toBe(true);
    const blob = JSON.stringify([o.projectFile, o.hostFile]);
    for (const v of ['tok-secret-value', 'oauth-secret-value', 'ghp_secretsecretsecret']) expect(blob).not.toContain(v);
  });

  it('leaves non-secret items in dropped when something still has no home (custom template, docker_host, refs)', () => {
    const m = buildMigration({
      legacyDeployment: {
        ...mini,
        env: { ...mini.env, WEB_REF: 'main', WORKSPACE_REF: 'main' },
        profiles: { gke: { ...BUILTIN_PROFILES.gke, launch: 'custom', docker_host: { ssh_target: 'h' } } },
        launcher: { ...mini.launcher, supabase_refs: { abc: 'prod' } },
      },
      env: {},
      profileName: 'gke',
    });
    expect(nonSecretDrops(m.dropped).map((d) => d.item)).toEqual(
      expect.arrayContaining([
        'deployment.json › env.WEB_REF',
        'deployment.json › env.WORKSPACE_REF',
        'deployment.json › launcher.supabase_refs',
        'deployment.json › profiles.gke custom launch/reap/probe template',
        'deployment.json › profiles.gke.docker_host',
      ]),
    );
  });
});
