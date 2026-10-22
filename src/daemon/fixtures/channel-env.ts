// B-1222: real files-only config projection and mint composition, no credentials or cloud calls.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDeploymentConfig, resolveConfigPath } from '../../config/deployment-config.js';
// @ts-expect-error -- dependency-free plain JavaScript mint helpers
import { resolveBaseContent, composeEnvFile } from '../../../scripts/mint-installation-token.mjs';

export function channelEnv(profile: 'cloud' | 'gke', channel = 'staging'): string {
  const dir = mkdtempSync(join(tmpdir(), 'channel-env-'));
  const project = join(dir, 'project.json');
  writeFileSync(project, JSON.stringify({ version: 1, channel, profile, gcp: { project: 'test' }, gke: { cluster: 'test', location: 'us-central1' } }));
  writeFileSync(join(dir, 'conductor-host.json'), JSON.stringify({ version: 1, plugin_dir: '/plugin', github_app: { app_id: '1', installation_id: '2', private_key_path: '/test-key' } }));
  const env = { HARMONY_HOME: dir, HARMONY_CONDUCTOR_PROJECT_FILE: project };
  const configPath = join(dir, 'absent-deployment.json');
  const baseContent = resolveBaseContent({ configPath, env, log: () => {}, cliImpl: (key: string) => {
    const config = loadDeploymentConfig({ configPath, env, warn: () => {} });
    const value = config && resolveConfigPath(config, key);
    return value == null ? { status: 'unset' } : { status: 'ok', stdout: JSON.stringify(value) };
  } });
  return composeEnvFile({ baseContent, token: 'ghs_test' });
}
