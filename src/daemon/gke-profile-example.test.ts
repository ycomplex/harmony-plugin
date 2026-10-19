// B-1161: the real gke example profile parses, validates against the deployment schema and boots the daemon config.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadDaemonConfig, type LaunchProfile } from './config.js';
import { DeploymentConfigSchema } from '../config/deployment-config.js';

const GKE: LaunchProfile & { agents?: string[]; required_tools?: Record<string, string[]> } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../container/gke/daemon-profile.gke.example.json', import.meta.url)), 'utf8'),
);

describe('container/gke/daemon-profile.gke.example.json', () => {
  it('validates through DeploymentConfigSchema as profiles.gke', () => {
    const parsed = DeploymentConfigSchema.parse({ profiles: { gke: GKE } });
    expect(parsed.profiles?.gke.agents).toEqual(['claude-code', 'codex']);
  });

  it('boots through loadDaemonConfig on both routes', () => {
    const viaFile = loadDaemonConfig({ HARMONY_API_TOKEN: 't', HARMONY_DAEMON_PROFILE: '/p.json' }, () => JSON.stringify(GKE));
    const viaOverride = loadDaemonConfig({ HARMONY_API_TOKEN: 't' }, () => '', { profileOverride: GKE });
    for (const c of [viaFile, viaOverride]) {
      expect(c.profile.agents).toEqual(['claude-code', 'codex']);
      expect(c.profile.launch).toContain('{run_config_json}');
    }
  });

  it('lists the GKE auth plugin in every required_tools list', () => {
    expect(GKE.required_tools).toEqual({
      launch: ['node', 'kubectl', 'gke-gcloud-auth-plugin'],
      reap: ['kubectl', 'gke-gcloud-auth-plugin'],
      probe: ['kubectl', 'gke-gcloud-auth-plugin'],
    });
  });

  it('calls the scripts under $HARMONY_PLUGIN_DIR/container/gke/, never a spike dir', () => {
    for (const t of [GKE.launch, GKE.reap, GKE.probe]) {
      expect(t).toContain('$HARMONY_PLUGIN_DIR/container/gke/');
      expect(t).not.toContain('SPIKE');
    }
    expect(GKE.launch).toContain("gke-worker-launch.sh\" {conduction_id} {ticket} '{run_config_json}' '{model}'");
    expect(GKE.reap).toContain('gke-worker-reap.sh');
    expect(GKE.probe).toContain('gke-worker-probe.sh');
  });
});
