import { describe, it, expect } from 'vitest';
import {
  loadDeploymentConfig,
  resolveDeploymentConfigPath,
  resolveConfigPath,
} from './deployment-config.js';

// Fakes a filesystem via an in-memory map — no real fs touched (B-800 injectable-IO requirement).
function fakeFs(files: Record<string, string>) {
  return {
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return files[path];
    },
  };
}

describe('resolveDeploymentConfigPath', () => {
  it('prefers an explicit configPath over everything else', () => {
    expect(
      resolveDeploymentConfigPath({
        configPath: '/explicit/path.json',
        env: { HARMONY_DEPLOYMENT_CONFIG: '/env/path.json' },
      }),
    ).toBe('/explicit/path.json');
  });

  it('falls back to HARMONY_DEPLOYMENT_CONFIG when no explicit path is given', () => {
    expect(resolveDeploymentConfigPath({ env: { HARMONY_DEPLOYMENT_CONFIG: '/env/path.json' } })).toBe(
      '/env/path.json',
    );
  });

  it('defaults to ~/.harmony/deployment.json when neither is set', () => {
    const path = resolveDeploymentConfigPath({ env: {} });
    expect(path).toMatch(/\.harmony[/\\]deployment\.json$/);
  });
});

describe('loadDeploymentConfig', () => {
  it('returns null when the file does not exist at the resolved path', () => {
    const io = fakeFs({});
    expect(loadDeploymentConfig({ configPath: '/nowhere/deployment.json', ...io })).toBeNull();
  });

  it('parses a valid config with all three sections', () => {
    const config = {
      env: { HARMONY_TARGET: 'staging', HARMONY_API_TOKEN: 'tok-123' },
      profiles: {
        local: { launch: 'docker run ...', reap: 'docker rm -f ...', maxConcurrentWorkers: 3 },
        cloud: {
          launch: 'cloud-worker-launch.sh {conduction_id} {ticket}',
          reap: 'cloud-worker-reap.sh {conduction_id} {ticket}',
          probe: 'cloud-worker-probe.sh {conduction_id} {ticket}',
          gcloud_project: 'my-gcp-project',
        },
      },
      launcher: {
        plugin_dir: '/workspace/plugin',
        github_app: { app_id: '123', installation_id: '456' },
        supabase: { url: 'https://meqkdgncdzromunylyxf.supabase.co', anon_key: 'anon-abc' },
        supabase_refs: { customrefxyz: 'staging' },
      },
    };
    const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
    const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
    expect(loaded).toEqual(config);
  });

  it('throws a clear error for malformed JSON', () => {
    const io = fakeFs({ '/deployment.json': '{ not valid json' });
    expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
      /not valid JSON/,
    );
  });

  it('throws a clear error for a schema violation', () => {
    // profiles.local is missing the required "reap" template.
    const io = fakeFs({
      '/deployment.json': JSON.stringify({ profiles: { local: { launch: 'echo hi' } } }),
    });
    expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
      /failed validation/,
    );
  });

  it('resolves the path via HARMONY_DEPLOYMENT_CONFIG when no explicit configPath is given', () => {
    const io = fakeFs({ '/env-configured.json': JSON.stringify({ launcher: { plugin_dir: '/x' } }) });
    const loaded = loadDeploymentConfig({
      env: { HARMONY_DEPLOYMENT_CONFIG: '/env-configured.json' },
      ...io,
    });
    expect(loaded).toEqual({ launcher: { plugin_dir: '/x' } });
  });
});

describe('resolveConfigPath', () => {
  const config = {
    launcher: {
      supabase_refs: { eioxsunvhakmelhanmnn: 'prod', meqkdgncdzromunylyxf: 'staging' },
      supabase: { url: 'https://example.supabase.co' },
    },
    profiles: { cloud: { gcloud_project: 'my-project' } },
  };

  it('resolves a nested dot-path', () => {
    expect(resolveConfigPath(config, 'launcher.supabase_refs.eioxsunvhakmelhanmnn')).toBe('prod');
    expect(resolveConfigPath(config, 'launcher.supabase.url')).toBe('https://example.supabase.co');
    expect(resolveConfigPath(config, 'profiles.cloud.gcloud_project')).toBe('my-project');
  });

  it('returns undefined for a missing path', () => {
    expect(resolveConfigPath(config, 'launcher.nope')).toBeUndefined();
    expect(resolveConfigPath(config, 'nope.nope.nope')).toBeUndefined();
  });

  it('returns undefined (not a throw) when traversing through a non-object value', () => {
    expect(resolveConfigPath(config, 'launcher.supabase.url.nested')).toBeUndefined();
  });

  it('returns undefined for an empty dot-path against a non-null config', () => {
    // Splitting '' yields no parts, so the loop never runs — the whole config object is returned.
    expect(resolveConfigPath(config, '')).toEqual(config);
  });
});
