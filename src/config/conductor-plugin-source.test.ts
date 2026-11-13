// B-1478: .harmony/conductor.json's plugin_source / plugin_release — schema, validation and the env projection.
import { describe, expect, it } from 'vitest';
import {
  HostFileSchema,
  loadConductorConfigSync,
  mergeLayers,
  PLUGIN_RELEASE_NEEDS_BASE_URL,
  pluginReleaseBaseUrlProblem,
  projectToDeploymentConfig,
  validateMerged,
  validateProjectFileText,
} from './conductor-config.js';
import { loadDeploymentConfig } from './deployment-config.js';

const cloudProject = { version: 1, channel: 'prod', profile: 'cloud', gcp: { project: 'proj' } };
const BASE = 'https://abcdefghijklmnop.supabase.co/functions/v1/plugin-download';

const validate = (extra: Record<string, unknown>) => validateProjectFileText('conductor.json', JSON.stringify({ ...cloudProject, ...extra }));
const issueKeys = (extra: Record<string, unknown>) => {
  const r = validate(extra);
  return r.ok ? [] : r.issues.map((i) => `${i.key}: ${i.problem}`);
};

describe('B-1478 plugin_source / plugin_release: schema', () => {
  it('accepts release with a base_url, and clone with or without one', () => {
    expect(validate({ plugin_source: 'release', plugin_release: { base_url: BASE } }).ok).toBe(true);
    expect(validate({ plugin_source: 'clone' }).ok).toBe(true);
    expect(validate({ plugin_source: 'clone', plugin_release: { base_url: BASE } }).ok).toBe(true);
    expect(validate({ plugin_release: { base_url: `${BASE}/` } }).ok).toBe(true);
  });

  it('refuses release without plugin_release.base_url, naming the key', () => {
    expect(issueKeys({ plugin_source: 'release' }).join('\n')).toContain(PLUGIN_RELEASE_NEEDS_BASE_URL);
  });

  it('refuses an unknown plugin_source value', () => {
    expect(validate({ plugin_source: 'zip' }).ok).toBe(false);
  });

  it('plugin_release is strict: exactly one key, base_url', () => {
    expect(validate({ plugin_release: { base_url: BASE, channel: 'prod' } }).ok).toBe(false);
    expect(validate({ plugin_release: {} }).ok).toBe(false);
  });

  it.each([
    ['http://example.test/plugin-download', 'not https'],
    ['https://example.test/plugin download', 'a space'],
    ['https://example.test/x"y', 'a quote'],
    ['https://example.test/x?channel=prod', 'a query'],
    ['https://example.test/x#frag', 'a fragment'],
    ['https://user:pw@example.test/x', 'credentials'],
    ['ftp://example.test/x', 'another scheme'],
    ['', 'empty'],
  ])('refuses a base_url with %s (%s)', (url) => {
    expect(pluginReleaseBaseUrlProblem(url)).not.toBeNull();
    expect(validate({ plugin_source: 'release', plugin_release: { base_url: url } }).ok).toBe(false);
  });

  it('the host file accepts the same keys (it may override a project key)', () => {
    expect(HostFileSchema.safeParse({ version: 1, plugin_source: 'release', plugin_release: { base_url: BASE } }).success).toBe(true);
    expect(HostFileSchema.safeParse({ version: 1, plugin_source: 'nope' }).success).toBe(false);
  });

  it('validateMerged catches release without a base_url reaching the merge from the host file', () => {
    const merged = mergeLayers(cloudProject, { plugin_source: 'release' });
    expect(validateMerged(merged).map((i) => i.key)).toContain('plugin_release.base_url');
    expect(validateMerged(mergeLayers(cloudProject, { plugin_source: 'release', plugin_release: { base_url: BASE } })).map((i) => i.key)).not.toContain('plugin_release.base_url');
  });
});

describe('B-1478 plugin_source / plugin_release: projection into the worker base env', () => {
  it('absent keys put NOTHING new in the env (posture only, exactly as before)', () => {
    const out = projectToDeploymentConfig(mergeLayers(cloudProject));
    expect(out.env).toEqual({ HARMONY_PLUGIN_POSTURE: 'prod' });
  });

  it('release + base_url land as HARMONY_PLUGIN_SOURCE and HARMONY_PLUGIN_RELEASE_URL, beside the posture', () => {
    const out = projectToDeploymentConfig(mergeLayers({ ...cloudProject, channel: 'staging', plugin_source: 'release', plugin_release: { base_url: BASE } }));
    expect(out.env).toEqual({ HARMONY_PLUGIN_POSTURE: 'ack:staging', HARMONY_PLUGIN_SOURCE: 'release', HARMONY_PLUGIN_RELEASE_URL: BASE });
  });

  it('a trailing slash on base_url is dropped in the env', () => {
    const out = projectToDeploymentConfig(mergeLayers({ ...cloudProject, plugin_source: 'release', plugin_release: { base_url: `${BASE}/` } }));
    expect(out.env?.HARMONY_PLUGIN_RELEASE_URL).toBe(BASE);
  });

  it('an explicit clone is carried as such', () => {
    const out = projectToDeploymentConfig(mergeLayers({ ...cloudProject, plugin_source: 'clone' }));
    expect(out.env).toEqual({ HARMONY_PLUGIN_POSTURE: 'prod', HARMONY_PLUGIN_SOURCE: 'clone' });
  });

  it('a host override of plugin_source wins over the project file', () => {
    const out = projectToDeploymentConfig(mergeLayers({ ...cloudProject, plugin_source: 'release', plugin_release: { base_url: BASE } }, { plugin_source: 'clone' }));
    expect(out.env?.HARMONY_PLUGIN_SOURCE).toBe('clone');
  });

  it('flows through the loader from a files-only host', () => {
    const files: Record<string, string> = {
      '/h/conductor.json': JSON.stringify({ ...cloudProject, plugin_source: 'release', plugin_release: { base_url: BASE } }),
      '/h/conductor-host.json': JSON.stringify({ version: 1, plugin_dir: '/plug', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' } }),
    };
    const r = loadConductorConfigSync({
      env: { HARMONY_HOME: '/h', HARMONY_CONDUCTOR_PROJECT_FILE: '/h/conductor.json' },
      existsSync: (p: string) => p in files,
      readFileSync: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p];
      },
      warn: () => {},
    });
    expect(r?.deploymentConfig.env).toMatchObject({ HARMONY_PLUGIN_SOURCE: 'release', HARMONY_PLUGIN_RELEASE_URL: BASE });
  });
});

describe('B-1478: the deployment env schema keeps the two keys (the loader strips unknown env keys)', () => {
  const fakeFs = (files: Record<string, string>) => ({
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p],
  });

  it('round-trips HARMONY_PLUGIN_SOURCE and HARMONY_PLUGIN_RELEASE_URL', () => {
    const env = { HARMONY_PLUGIN_SOURCE: 'release', HARMONY_PLUGIN_RELEASE_URL: BASE };
    const loaded = loadDeploymentConfig({ configPath: '/d.json', env: { HARMONY_HOME: '/h-none' }, ...fakeFs({ '/d.json': JSON.stringify({ env }) }) });
    expect(loaded?.env).toMatchObject(env);
  });

  it('refuses an unknown HARMONY_PLUGIN_SOURCE', () => {
    expect(() => loadDeploymentConfig({ configPath: '/d.json', env: { HARMONY_HOME: '/h-none' }, ...fakeFs({ '/d.json': JSON.stringify({ env: { HARMONY_PLUGIN_SOURCE: 'zip' } }) }) })).toThrow();
  });
});
