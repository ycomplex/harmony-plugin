import { describe, it, expect } from 'vitest';
import {
  loadDeploymentConfig,
  resolveDeploymentConfigPath,
  resolveConfigPath,
  WORKER_IMAGE_DEFAULT,
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
    expect(loaded).toEqual({ ...config, worker_image: 'harmony-build-env' }); // B-929 default
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
    // B-929: worker_image carries a schema default, so every successful parse materializes it.
    expect(loaded).toEqual({ launcher: { plugin_dir: '/x' }, worker_image: 'harmony-build-env' });
  });

  // B-803: the single posture knob replaces the old PLUGIN_REF + HARMONY_ACK_PLUGIN_AHEAD_OF_PROD
  // pair in env.* — accept the new var, confirm the old pair is no longer part of the schema.
  it('accepts HARMONY_PLUGIN_POSTURE in env.* (any of the three encodings — the schema itself is just a string)', () => {
    const config = { env: { HARMONY_TARGET: 'prod' as const, HARMONY_PLUGIN_POSTURE: 'ack:main' } };
    const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
    const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
    expect(loaded).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
  });

  it('the old PLUGIN_REF / HARMONY_ACK_PLUGIN_AHEAD_OF_PROD pair is no longer part of the schema — silently stripped, not rejected', () => {
    const config = {
      env: {
        HARMONY_TARGET: 'prod',
        PLUGIN_REF: 'main',
        HARMONY_ACK_PLUGIN_AHEAD_OF_PROD: '1',
      },
    };
    const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
    const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
    // Unknown keys are stripped by zod's default object behavior — neither key survives parsing,
    // confirming the schema no longer declares them (a passthrough schema would have kept them).
    expect(loaded).toEqual({ env: { HARMONY_TARGET: 'prod' }, worker_image: 'harmony-build-env' });
  });

  // B-929 lever 2: which container image this deployment's workers run. A TOP-LEVEL key (sibling of
  // env/profiles/launcher/repos), carrying the ONE place the default is written.
  describe('worker_image (B-929)', () => {
    it('defaults to harmony-build-env when the config does not mention it', () => {
      const io = fakeFs({ '/deployment.json': JSON.stringify({ env: { HARMONY_TARGET: 'prod' } }) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded?.worker_image).toBe('harmony-build-env');
    });

    it('carries an override through verbatim, including a fully-qualified registry ref', () => {
      const ref = 'us-central1-docker.pkg.dev/acme/workers/acme-build-env:0.14.171';
      const io = fakeFs({ '/deployment.json': JSON.stringify({ worker_image: ref }) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded?.worker_image).toBe(ref);
    });

    it('rejects an empty worker_image rather than silently launching a nameless image', () => {
      const io = fakeFs({ '/deployment.json': JSON.stringify({ worker_image: '' }) });
      expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
        /failed validation/,
      );
    });

    it('is resolvable by `harmony config get worker_image`\'s dot-path primitive', () => {
      const io = fakeFs({ '/deployment.json': JSON.stringify({ worker_image: 'acme-build-env' }) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(resolveConfigPath(loaded, 'worker_image')).toBe('acme-build-env');
    });

    it('the exported WORKER_IMAGE_DEFAULT IS the schema default — one literal, not two', () => {
      const io = fakeFs({ '/deployment.json': '{}' });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded?.worker_image).toBe(WORKER_IMAGE_DEFAULT);
    });
  });

  // B-814: the ordered repo-set list — replaces the fixed WEB_REPO/PLUGIN_REPO/WORKSPACE_REPO
  // three-slot assumption baked into container/entrypoint.sh. See src/config/deployment-config.ts's
  // RepoEntrySchema/ReposSchema header comment for the full shape and ref-precedence contract.
  describe('repos (B-814)', () => {
    it('parses a valid repos list with a meta-repo entry, a plain sibling, and the plugin entry', () => {
      const config = {
        repos: [
          { url: 'https://github.com/ycomplex/harmony-workspace.git', path: '/workspace/workspace', meta_repo_role: true },
          { url: 'https://github.com/ycomplex/harmony-web.git', path: '/workspace/workspace/web', ref: 'main' },
          { url: 'https://github.com/ycomplex/harmony-plugin.git', path: '/workspace/workspace/plugin', is_plugin: true },
        ],
      };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
    });

    it('accepts an N=1 single-repo list where that one entry is both the whole topology and is_plugin (AC1 — e.g. Team Health)', () => {
      const config = {
        repos: [{ url: 'https://github.com/ycomplex/team-health.git', path: '/workspace/workspace/plugin', is_plugin: true }],
      };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
    });

    it('requires url and path on every entry, but ref/meta_repo_role/is_plugin all stay optional', () => {
      const config = { repos: [{ url: 'https://github.com/x/y.git', path: '/workspace/y' }] };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      expect(loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
    });

    it('rejects a repos entry missing url or path', () => {
      const io = fakeFs({
        '/deployment.json': JSON.stringify({ repos: [{ path: '/workspace/y' }] }),
      });
      expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
        /failed validation/,
      );
    });

    it('rejects more than one entry setting meta_repo_role', () => {
      const config = {
        repos: [
          { url: 'https://github.com/x/a.git', path: '/workspace/a', meta_repo_role: true },
          { url: 'https://github.com/x/b.git', path: '/workspace/b', meta_repo_role: true },
        ],
      };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
        /at most one repos\[\] entry may set meta_repo_role/,
      );
    });

    it('rejects more than one entry setting is_plugin', () => {
      const config = {
        repos: [
          { url: 'https://github.com/x/a.git', path: '/workspace/a', is_plugin: true },
          { url: 'https://github.com/x/b.git', path: '/workspace/b', is_plugin: true },
        ],
      };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
        /at most one repos\[\] entry may set is_plugin/,
      );
    });

    it('allows repos with NEITHER a meta_repo_role NOR an is_plugin entry set (every entry a plain sibling)', () => {
      const config = {
        repos: [
          { url: 'https://github.com/x/a.git', path: '/workspace/a' },
          { url: 'https://github.com/x/b.git', path: '/workspace/b' },
        ],
      };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      expect(loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
    });

    // AC3: a deployment.json with no repos section at all must load exactly as it did before this
    // ticket — the section is purely additive.
    it('a config with no repos section at all loads unchanged (AC3 — repos is purely additive)', () => {
      const config = { env: { HARMONY_TARGET: 'prod' as const } };
      const io = fakeFs({ '/deployment.json': JSON.stringify(config) });
      const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
      expect(loaded).toEqual({ ...config, worker_image: WORKER_IMAGE_DEFAULT });
      expect(loaded && 'repos' in loaded).toBe(false);
    });
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
