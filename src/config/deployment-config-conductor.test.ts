import { describe, expect, it } from 'vitest';
import { resetConductorWarningDedupe } from './conductor-config.js';
import { loadDeploymentConfig, loadLegacyDeploymentConfig } from './deployment-config.js';

const legacyPath = '/h/deployment.json';
const legacy = JSON.stringify({ worker_image: 'img', profiles: { cloud: { launch: 'l', reap: 'r', gcloud_project: 'old' } } });
const project = JSON.stringify({ version: 1, channel: 'prod', profile: 'cloud', gcp: { project: 'new' } });
const host = JSON.stringify({ version: 1, plugin_dir: '/p', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k' } });

function opts(files: Record<string, string>, env: NodeJS.ProcessEnv = {}) {
  return {
    env: { HARMONY_HOME: '/h', HARMONY_DEPLOYMENT_CONFIG: legacyPath, ...env },
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => files[p],
    warn: () => {},
  };
}

describe('loadDeploymentConfig with conductor config (B-1170)', () => {
  it('falls through to the legacy loader untouched when no new-file input exists', () => {
    resetConductorWarningDedupe();
    const o = opts({ [legacyPath]: legacy });
    expect(loadDeploymentConfig(o)).toEqual(loadLegacyDeploymentConfig(o));
    expect(loadDeploymentConfig(o)?.profiles?.cloud?.launch).toBe('l');
  });

  it('returns null when neither legacy nor new files exist', () => {
    expect(loadDeploymentConfig(opts({}))).toBeNull();
  });

  it('a malformed legacy file still throws exactly as before when no new files exist', () => {
    expect(() => loadDeploymentConfig(opts({ [legacyPath]: '{ nope' }))).toThrow(/not valid JSON/);
  });

  it('returns the projected config when conductor inputs exist, overlaying the legacy file', () => {
    resetConductorWarningDedupe();
    const cfg = loadDeploymentConfig(opts({ [legacyPath]: legacy, '/h/conductor-snapshot.json': JSON.stringify({ version: 1, source: { repo: 'o/r', ref: 'main', path: '.harmony/conductor.json' }, etag: null, sha: null, fetched_at: 'x', content: project }), '/h/conductor-host.json': host }))!;
    expect(cfg.worker_image).toBe('img');
    expect(cfg.profiles?.cloud?.launch).toContain('cloud-worker-launch.sh');
    expect(cfg.profiles?.cloud?.gcloud_project).toBe('new');
    expect(cfg.launcher?.plugin_dir).toBe('/p');
    expect(cfg.env?.HARMONY_PLUGIN_POSTURE).toBe('prod');
  });
});
