// B-1170 board requirement: the two files ALONE must produce the environment the launch scripts read,
// and the launch profile the daemon boots from. These tests write a project file + host file into a temp
// dir, load them with a CLEAN env (only HARMONY_CONDUCTOR_* path overrides plus isolation from the real
// ~/.harmony), apply the launch env onto an empty env object, and spawn a real (harmless) child with that
// object as its whole environment to see exactly what a launch script would see.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadDaemonConfig, selectNamedProfile } from '../daemon/config.js';
import {
  applyLaunchEnv,
  BUILTIN_PROFILES,
  launchEnvFromMerged,
  loadConductorConfigSync,
  resetConductorWarningDedupe,
} from './conductor-config.js';
import { loadDeploymentConfig } from './deployment-config.js';

const BASH = ['/bin/bash', '/usr/bin/bash'].find((p) => existsSync(p)) ?? '/bin/sh';

let dir: string;
let cleanEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  resetConductorWarningDedupe();
  dir = mkdtempSync(join(tmpdir(), 'conductor-launch-'));
  cleanEnv = {
    HARMONY_CONDUCTOR_PROJECT_FILE: join(dir, 'conductor.json'),
    HARMONY_CONDUCTOR_HOST_FILE: join(dir, 'conductor-host.json'),
    // isolation from the real machine: nothing under the real ~/.harmony may be read
    HARMONY_HOME: join(dir, 'home'),
    HARMONY_DEPLOYMENT_CONFIG: join(dir, 'no-such-deployment.json'),
  };
});

const hostFile = {
  version: 1,
  plugin_dir: '/opt/harmony-plugin',
  github_app: { app_id: '1', installation_id: '2', private_key_path: '/etc/app.pem' },
  gcloud: { account: 'daemon@proj.iam.gserviceaccount.com' },
};
const gkeProject = {
  version: 1,
  channel: 'staging',
  profile: 'gke',
  gcp: { project: 'proj', region: 'us-east1' },
  gke: { cluster: 'leg-pool', location: 'us-east1-b', namespace: 'harmony-legs', registry: 'us-east1-docker.pkg.dev/proj/harmony', ticket_disk: 'ticket-disk-pvc' },
  images: { worker: 'harmony-build-env' },
  concurrency: { max_workers: 5 },
};
const cloudProject = {
  version: 1,
  channel: 'prod',
  profile: 'cloud',
  gcp: { project: 'proj', region: 'us-central1' },
  cloud_run: { job: 'harmony-worker' },
};
const put = (project: unknown, host: unknown = hostFile) => {
  writeFileSync(cleanEnv.HARMONY_CONDUCTOR_PROJECT_FILE as string, JSON.stringify(project));
  writeFileSync(cleanEnv.HARMONY_CONDUCTOR_HOST_FILE as string, JSON.stringify(host));
};

/** Spawn a child whose ENTIRE environment is `env`, and print the named variables, '|'-separated. */
function childSees(env: NodeJS.ProcessEnv, names: string[]): string[] {
  const script = `printf '%s' ${names.map((n) => `"$${n}"`).join(' "|" ')}`;
  const r = spawnSync(BASH, ['-c', script], { env: env as NodeJS.ProcessEnv, encoding: 'utf8' });
  expect(r.status).toBe(0);
  return r.stdout.split('|');
}

function launchEnvFor(project: unknown, target: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  put(project);
  const loaded = loadConductorConfigSync({ env: cleanEnv, warn: () => {} });
  expect(loaded).not.toBeNull();
  applyLaunchEnv(target, launchEnvFromMerged(loaded!.merged), new Set());
  return target;
}

describe('launch env from the two files alone', () => {
  it('gke: a child sees the namespace, derived context, ticket disk and registry from the files', () => {
    const env = launchEnvFor(gkeProject);
    expect(childSees(env, ['HARMONY_GKE_NAMESPACE', 'HARMONY_GKE_CONTEXT', 'HARMONY_GKE_TICKET_DISK', 'HARMONY_GKE_REGISTRY'])).toEqual([
      'harmony-legs',
      'gke_proj_us-east1-b_leg-pool',
      'ticket-disk-pvc',
      'us-east1-docker.pkg.dev/proj/harmony',
    ]);
    expect(childSees(env, ['HARMONY_GKE_IMAGE', 'CLOUDSDK_CORE_PROJECT', 'CLOUDSDK_CORE_ACCOUNT'])).toEqual([
      'harmony-build-env',
      'proj',
      'daemon@proj.iam.gserviceaccount.com',
    ]);
  });

  it('the host file reaches the launch scripts: plugin dir and GitHub App identity', () => {
    const env = launchEnvFor(gkeProject);
    expect(childSees(env, ['HARMONY_PLUGIN_DIR', 'HARMONY_APP_ID', 'HARMONY_APP_INSTALLATION_ID', 'HARMONY_APP_PRIVATE_KEY_PATH'])).toEqual([
      '/opt/harmony-plugin',
      '1',
      '2',
      '/etc/app.pem',
    ]);
  });

  it('cloud: a child sees the Cloud Run region/job and the gcloud project/account', () => {
    const env = launchEnvFor(cloudProject);
    expect(childSees(env, ['HARMONY_CLOUD_RUN_REGION', 'HARMONY_CLOUD_RUN_JOB', 'CLOUDSDK_CORE_PROJECT', 'CLOUDSDK_CORE_ACCOUNT'])).toEqual([
      'us-central1',
      'harmony-worker',
      'proj',
      'daemon@proj.iam.gserviceaccount.com',
    ]);
  });

  it('an explicit env value beats the file; the rest still comes from the files', () => {
    const env = launchEnvFor(gkeProject, { HARMONY_GKE_NAMESPACE: 'explicit-ns' });
    expect(childSees(env, ['HARMONY_GKE_NAMESPACE', 'HARMONY_GKE_TICKET_DISK'])).toEqual(['explicit-ns', 'ticket-disk-pvc']);
  });
});

describe('the daemon resolves its profile from the two files alone', () => {
  const boot = (project: unknown, name: string) => {
    put(project);
    const deployment = loadDeploymentConfig({ env: cleanEnv });
    expect(deployment).not.toBeNull();
    const profile = selectNamedProfile(deployment, name);
    expect(profile).not.toBeNull();
    return loadDaemonConfig({}, () => {
      throw new Error('no profile file may be read on the named route');
    }, { profileOverride: profile! });
  };

  it('gke: launch/reap/probe equal the built-in template (and the shipped example) and max_workers comes from the file', () => {
    const config = boot(gkeProject, 'gke');
    expect(config.profile.launch).toBe(BUILTIN_PROFILES.gke.launch);
    expect(config.profile.reap).toBe(BUILTIN_PROFILES.gke.reap);
    expect(config.profile.probe).toBe(BUILTIN_PROFILES.gke.probe);
    expect(config.maxConcurrentWorkers).toBe(5);
    const example = JSON.parse(readFileSync(join(__dirname, '../../container/gke/daemon-profile.gke.example.json'), 'utf8'));
    expect(config.profile.launch).toBe(example.launch);
  });

  it('cloud: the built-in cloud template, with the built-in cap when the file sets none', () => {
    const config = boot(cloudProject, 'cloud');
    expect(config.profile.launch).toBe(BUILTIN_PROFILES.cloud.launch);
    expect(config.maxConcurrentWorkers).toBe(BUILTIN_PROFILES.cloud.maxConcurrentWorkers);
  });
});
