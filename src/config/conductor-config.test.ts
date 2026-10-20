import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyLaunchEnv,
  BUILTIN_PROFILES,
  ConductorConfigError,
  diffRestartRequired,
  evaluateConductorConfig,
  formatConfigIssues,
  HostFileSchema,
  launchEnvFromMerged,
  legacyToConductor,
  loadConductorConfigSync,
  mergeLayers,
  projectToDeploymentConfig,
  resetConductorWarningDedupe,
  resolveConfigRepo,
  validateProjectFileText,
  type ConductorLoadOptions,
} from './conductor-config.js';
import type { DeploymentConfig } from './deployment-config.js';

const H = '/h';
const P = {
  project: '/h/conductor.json',
  host: '/h/conductor-host.json',
  snap: '/h/conductor-snapshot.json',
};

const gkeProject = {
  version: 1,
  channel: 'staging',
  profile: 'gke',
  gcp: { project: 'proj', region: 'us-east1' },
  gke: { cluster: 'cl', location: 'us-east1-b', namespace: 'ns-project' },
  concurrency: { max_workers: 3 },
};
const cloudProject = { version: 1, channel: 'prod', profile: 'cloud', gcp: { project: 'proj' } };
const host = {
  version: 1,
  plugin_dir: '/plug',
  github_app: { app_id: '1', installation_id: '2', private_key_path: '/k.pem' },
};

function fs(files: Record<string, unknown>) {
  const text = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
  return {
    existsSync: (p: string) => p in files,
    readFileSync: (p: string) => {
      if (!(p in files)) throw new Error(`ENOENT ${p}`);
      return text(files[p]);
    },
  };
}

function snapshot(content: unknown) {
  return {
    version: 1,
    source: { repo: 'o/r', ref: 'main', path: '.harmony/conductor.json' },
    etag: 'W/"1"',
    sha: 'abc',
    fetched_at: '2026-01-01T00:00:00.000Z',
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
}

function load(files: Record<string, unknown>, env: NodeJS.ProcessEnv = {}, extra: Partial<ConductorLoadOptions> = {}) {
  return loadConductorConfigSync({
    env: { HARMONY_HOME: H, ...env },
    ...fs(files),
    warn: () => {},
    ...extra,
  });
}

function errorOf(fn: () => unknown): ConductorConfigError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConductorConfigError);
    return e as ConductorConfigError;
  }
  throw new Error('expected a ConductorConfigError');
}

const legacyDep = (over: Partial<DeploymentConfig> = {}): DeploymentConfig => ({ worker_image: 'harmony-build-env', ...over });

beforeEach(() => resetConductorWarningDedupe());

describe('loadConductorConfigSync: input discovery', () => {
  it('returns null when no new-file input exists (env layer alone does not count)', () => {
    expect(load({})).toBeNull();
    expect(load({}, { HARMONY_CONDUCTOR_GKE_NAMESPACE: 'x' })).toBeNull();
  });

  it('loads an explicit project file + host file and projects to a DeploymentConfig', () => {
    const r = load({ [P.project]: gkeProject, [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project })!;
    expect(r.issues).toEqual([]);
    expect(r.merged.gke?.cluster).toBe('cl');
    expect(r.deploymentConfig.profiles?.gke?.maxConcurrentWorkers).toBe(3);
    expect(r.deploymentConfig.launcher?.plugin_dir).toBe('/plug');
    expect(r.deploymentConfig.env?.HARMONY_PLUGIN_POSTURE).toBe('ack:staging');
    expect(r.sources.some((s) => s.startsWith('project:'))).toBe(true);
  });

  it('reads the snapshot content when there is no explicit project file', () => {
    const r = load({ [P.snap]: snapshot(gkeProject), [P.host]: host })!;
    expect(r.merged.profile).toBe('gke');
    expect(r.sources.some((s) => s.startsWith('snapshot:'))).toBe(true);
  });
});

describe('evaluateConductorConfig: per-layer values (round B, additive)', () => {
  it('exposes each contributing layer so the doctor can report cross-layer conflicts', () => {
    const files = {
      [P.snap]: snapshot(gkeProject),
      [P.host]: { ...host, gke: { namespace: 'ns-host' } },
    };
    const ev = evaluateConductorConfig({
      env: { HARMONY_HOME: H, HARMONY_CONDUCTOR_GKE_NAMESPACE: 'ns-env', HARMONY_GKE_CPU: '2' },
      ...fs(files),
      warn: () => {},
    })!;
    expect((ev.layers.project as { gke: { namespace: string } }).gke.namespace).toBe('ns-project');
    expect((ev.layers.host as { gke: { namespace: string } }).gke.namespace).toBe('ns-host');
    expect(ev.layers.env).toEqual({ gke: { namespace: 'ns-env' } });
    expect(ev.layers.legacy).toEqual({ gke: { cpu: '2' } });
  });

  it('a layer that did not contribute is undefined / empty', () => {
    const ev = evaluateConductorConfig({ env: { HARMONY_HOME: H }, ...fs({ [P.host]: host }), warn: () => {} })!;
    expect(ev.layers.project).toBeUndefined();
    expect(ev.layers.env).toEqual({});
  });
});

describe('precedence: legacy < project < host < env', () => {
  it('layers each win over the one below, with a conflict on gke.namespace and concurrency', () => {
    const files = {
      [P.snap]: snapshot(gkeProject),
      [P.host]: { ...host, gke: { namespace: 'ns-host' }, concurrency: { max_workers: 5 } },
    };
    const legacyEnv = { HARMONY_GKE_NAMESPACE: 'ns-legacy', HARMONY_GKE_CPU: '2' };
    // project (ns-project) beats legacy (ns-legacy); host beats project
    const r = load(files, legacyEnv)!;
    expect(r.merged.gke?.namespace).toBe('ns-host');
    expect(r.merged.concurrency?.max_workers).toBe(5);
    expect(r.merged.gke?.cpu).toBe('2'); // legacy only fills what nothing else sets
    // env beats host
    const e = load(files, { ...legacyEnv, HARMONY_CONDUCTOR_GKE_NAMESPACE: 'ns-env', HARMONY_CONDUCTOR_CONCURRENCY_MAX_WORKERS: '9' })!;
    expect(e.merged.gke?.namespace).toBe('ns-env');
    expect(e.merged.concurrency?.max_workers).toBe(9);
  });

  it('project beats legacy deployment.json', () => {
    const dep = legacyDep({
      profiles: { gke: { ...BUILTIN_PROFILES.gke, maxConcurrentWorkers: 7, gcloud_project: 'old-proj' } },
      launcher: { plugin_dir: '/old-plug' },
    });
    const r = load({ [P.snap]: snapshot(gkeProject), [P.host]: { version: 1, github_app: host.github_app } }, {}, { loadLegacy: () => dep })!;
    expect(r.merged.concurrency?.max_workers).toBe(3);
    expect(r.merged.gcp?.project).toBe('proj');
    expect(r.merged.plugin_dir).toBe('/old-plug'); // nothing above supplies it
  });

  it('mergeLayers replaces arrays and merges objects', () => {
    const m = mergeLayers({ agents: ['a', 'b'], gke: { cpu: '1' } }, { agents: ['c'], gke: { memory: '2Gi' } });
    expect(m).toEqual({ agents: ['c'], gke: { cpu: '1', memory: '2Gi' } });
  });
});

describe('validation errors', () => {
  const run = (body: unknown, env: NodeJS.ProcessEnv = {}) =>
    errorOf(() => load({ [P.project]: body, [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project, ...env }));

  it('every issue has file, key and fix and the exact message format', () => {
    const e = run({ ...gkeProject, bogus: 1, gke: { ...gkeProject.gke, cpuu: '1' }, channel: 'dev' });
    expect(e.issues.length).toBeGreaterThanOrEqual(3);
    for (const i of e.issues) {
      expect(i.file).toBe('conductor.json');
      expect(i.key).toBeTruthy();
      expect(i.fix).toBeTruthy();
      expect(formatConfigIssues([i])[0]).toBe(`${i.file} › ${i.key}: ${i.problem.replace(/\.+$/, '')}. Fix: ${i.fix}`);
    }
    expect(e.message.split('\n')).toHaveLength(e.issues.length);
  });

  it('unknown key names the key and lists allowed keys', () => {
    const e = run({ ...gkeProject, bogus: 1 });
    const i = e.issues.find((x) => x.key === 'bogus')!;
    expect(i.problem).toBe('unknown key');
    expect(i.fix).toContain('channel');
    expect(i.fix).toContain('model_policy');
    const nested = run({ ...gkeProject, gke: { ...gkeProject.gke, cpuu: '1' } }).issues.find((x) => x.key === 'gke.cpuu')!;
    expect(nested.fix).toContain('namespace');
  });

  it('enum mismatch lists options', () => {
    const i = run({ ...gkeProject, channel: 'dev' }).issues.find((x) => x.key === 'channel')!;
    expect(i.fix).toContain('"staging"');
    expect(i.fix).toContain('"prod"');
  });

  it('type mismatch gives expected type and an example', () => {
    const i = run({ ...gkeProject, concurrency: { max_workers: 'two' } }).issues.find((x) => x.key === 'concurrency.max_workers')!;
    expect(i.problem).toContain('expected number');
    expect(i.fix).toContain('e.g.');
    const neg = run({ ...gkeProject, concurrency: { max_workers: -1 } });
    expect(neg.issues[0].key).toBe('concurrency.max_workers');
  });

  it('missing required keys and wrong version', () => {
    const e = run({ version: 2, profile: 'gke' });
    const keys = e.issues.map((i) => i.key);
    expect(keys).toContain('version');
    expect(keys).toContain('channel');
  });

  it('JSON syntax errors name the file, (file) and a position', () => {
    const e = errorOf(() => load({ [P.project]: '{\n  "version": 1,\n  "channel": }\n', [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project }));
    expect(e.issues[0].key).toBe('(file)');
    expect(e.issues[0].file).toBe('conductor.json');
    expect(e.issues[0].problem).toMatch(/invalid JSON/);
    expect(e.issues[0].problem).toMatch(/line \d+/);
    expect(e.issues[0].fix).toBe('correct the JSON');
  });

  it('a malformed host file is reported against conductor-host.json; all files report together', () => {
    const e = errorOf(() =>
      load({ [P.project]: { ...gkeProject, bogus: 1 }, [P.host]: { ...host, nope: 1 } }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project }),
    );
    expect(new Set(e.issues.map((i) => i.file))).toEqual(new Set(['conductor.json', 'conductor-host.json']));
  });

  it('a missing explicit project file is an issue, not a silent fallback', () => {
    const e = errorOf(() => load({ [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project }));
    expect(e.issues[0].problem).toMatch(/not found/);
  });

  it('env-layer type errors name the variable', () => {
    const e = errorOf(() => load({ [P.project]: gkeProject, [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project, HARMONY_CONDUCTOR_GKE_POLL_S: 'soon', HARMONY_CONDUCTOR_LOG_SHIPPING: 'maybe', HARMONY_CONDUCTOR_CHANNEL: 'dev' }));
    expect(e.issues.map((i) => i.key).sort()).toEqual(['HARMONY_CONDUCTOR_CHANNEL', 'HARMONY_CONDUCTOR_GKE_POLL_S', 'HARMONY_CONDUCTOR_LOG_SHIPPING']);
    expect(e.issues.every((i) => i.file === 'env')).toBe(true);
  });

  it('validateProjectFileText labels with the given file', () => {
    const v = validateProjectFileText('conductor.json (main)', '{"version":1}');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.issues[0].file).toBe('conductor.json (main)');
  });
});

describe('host secrets block holds names only', () => {
  const bad = ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'sk-ant-123', 'eyJhbGciOi', '-----BEGIN PRIVATE KEY-----', 'a'.repeat(40)];
  it.each(bad)('rejects %s', (value) => {
    const r = HostFileSchema.safeParse({ version: 1, secrets: { token: value } });
    expect(r.success).toBe(false);
  });
  it('accepts secret names, and the error says store it in Secret Manager', () => {
    expect(HostFileSchema.safeParse({ version: 1, secrets: { base: 'harmony-worker-base-env', codex: 'harmony-codex-auth' } }).success).toBe(true);
    const e = errorOf(() => load({ [P.snap]: snapshot(gkeProject), [P.host]: { ...host, secrets: { t: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' } } }));
    expect(e.issues[0].key).toBe('secrets.t');
    expect(e.issues[0].fix).toMatch(/Secret Manager/);
  });
});

describe('semantic requirements after merge', () => {
  it('cloud requires gcp.project', () => {
    const e = errorOf(() => load({ [P.snap]: snapshot({ version: 1, channel: 'prod', profile: 'cloud' }), [P.host]: host }));
    expect(e.issues.map((i) => i.key)).toEqual(['gcp.project']);
    expect(e.issues[0].fix).toContain('.harmony/conductor.json');
  });

  it('gke requires gcp.project, gke.cluster and gke.location', () => {
    const e = errorOf(() => load({ [P.snap]: snapshot({ version: 1, channel: 'staging', profile: 'gke' }), [P.host]: host }));
    expect(e.issues.map((i) => i.key)).toEqual(['gcp.project', 'gke.cluster', 'gke.location']);
  });

  it('cloud is valid without gke keys', () => {
    expect(load({ [P.snap]: snapshot(cloudProject), [P.host]: host })!.merged.profile).toBe('cloud');
  });

  it('host must supply plugin_dir and github_app', () => {
    const e = errorOf(() => load({ [P.snap]: snapshot(cloudProject), [P.host]: { version: 1 } }));
    expect(e.issues.map((i) => i.key)).toEqual(['plugin_dir', 'github_app.app_id', 'github_app.installation_id', 'github_app.private_key_path']);
    expect(e.issues.every((i) => i.file === 'conductor-host.json' && i.fix.includes('~/.harmony/conductor-host.json'))).toBe(true);
  });

  it('is satisfied by legacy deployment.json launcher or legacy HARMONY_* env, with deprecation warnings', () => {
    const dep = legacyDep({ launcher: { plugin_dir: '/old', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k' } } });
    const a = load({ [P.snap]: snapshot(cloudProject), [P.host]: { version: 1 } }, {}, { loadLegacy: () => dep })!;
    expect(a.warnings.some((w) => w.includes('launcher.plugin_dir') && w.includes('plugin_dir'))).toBe(true);
    const b = load({ [P.snap]: snapshot(cloudProject), [P.host]: { version: 1 } }, {
      HARMONY_PLUGIN_DIR: '/p', HARMONY_APP_ID: '1', HARMONY_APP_INSTALLATION_ID: '2', HARMONY_APP_PRIVATE_KEY_PATH: '/k',
    })!;
    expect(b.warnings.filter((w) => w.startsWith('deprecated: env HARMONY_')).length).toBe(4);
    expect(b.issues).toEqual([]);
  });

  it('an inline HARMONY_APP_PRIVATE_KEY satisfies the key requirement', () => {
    const r = load({ [P.snap]: snapshot(cloudProject), [P.host]: { version: 1, plugin_dir: '/p', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k' } } }, { HARMONY_APP_PRIVATE_KEY: 'x' });
    expect(r).not.toBeNull();
  });
});

describe('a remote conductor has no key file (B-1173)', () => {
  const noPath = { version: 1, plugin_dir: '/p', github_app: { app_id: '1', installation_id: '2' } };
  it('a github_app block without private_key_path validates when HARMONY_APP_PRIVATE_KEY is set', () => {
    expect(HostFileSchema.safeParse(noPath).success).toBe(true);
    const r = load({ [P.snap]: snapshot(cloudProject), [P.host]: noPath }, { HARMONY_APP_PRIVATE_KEY: 'x', HARMONY_CONDUCTOR_REMOTE: '1' });
    expect(r).not.toBeNull();
    expect(r!.merged.github_app).toEqual({ app_id: '1', installation_id: '2' });
    expect(launchEnvFromMerged(r!.merged)).not.toHaveProperty('HARMONY_APP_PRIVATE_KEY_PATH');
  });
  it('without the inline key it still fails, and the fix names the secrets entry', () => {
    const e = errorOf(() => load({ [P.snap]: snapshot(cloudProject), [P.host]: noPath }));
    expect(e.issues.map((i) => i.key)).toEqual(['github_app.private_key_path']);
    expect(e.issues[0].fix).toContain('github_app_private_key');
  });
});

describe('legacy layer', () => {
  const dep = legacyDep({
    worker_image: 'ghcr.io/x/img:1',
    profiles: { cloud: { ...BUILTIN_PROFILES.cloud, gcloud_project: 'old', maxConcurrentWorkers: 4, agents: ['claude-code'] } },
    launcher: { plugin_dir: '/lp', github_app: { app_id: '9', installation_id: '8', private_key_path: '/k' } },
    env: { HARMONY_PLUGIN_POSTURE: 'ack:staging' },
  });

  it('maps every deployment.json field with a deprecation warning each', () => {
    const l = legacyToConductor({ deployment: dep, env: {}, profileName: 'cloud' });
    expect(l.layer).toEqual({
      images: { worker: 'ghcr.io/x/img:1' },
      gcp: { project: 'old' },
      concurrency: { max_workers: 4 },
      agents: ['claude-code'],
      plugin_dir: '/lp',
      github_app: { app_id: '9', installation_id: '8', private_key_path: '/k' },
      channel: 'staging',
    });
    for (const old of ['worker_image', 'profiles.cloud.gcloud_project', 'profiles.cloud.maxConcurrentWorkers', 'profiles.cloud.agents', 'launcher.plugin_dir', 'launcher.github_app', 'env.HARMONY_PLUGIN_POSTURE']) {
      expect(l.warnings.some((w) => w.includes(old))).toBe(true);
    }
    expect(l.warnings.every((w) => w.startsWith('deprecated:'))).toBe(true);
  });

  it('maps posture prod, staging and flags unknown values', () => {
    const ch = (p: string) => legacyToConductor({ deployment: legacyDep({ env: { HARMONY_PLUGIN_POSTURE: p } }), env: {} }).layer.channel;
    expect(ch('prod')).toBe('prod');
    expect(ch('staging')).toBe('staging');
    expect(ch('v1.2')).toBeUndefined();
  });

  it('does not map the default worker_image', () => {
    expect(legacyToConductor({ deployment: legacyDep(), env: {} }).layer).toEqual({});
  });

  it('maps all legacy env knobs and warns on each', () => {
    const env = {
      HARMONY_GKE_NAMESPACE: 'n', HARMONY_GKE_CONTEXT: 'c', HARMONY_GKE_BASE_SECRET: 'b', HARMONY_GKE_CODEX_SECRET: 'x',
      HARMONY_GKE_REGISTRY: 'r', HARMONY_GKE_CPU: '1', HARMONY_GKE_MEMORY: '2Gi', HARMONY_GKE_TICKET_DISK: '10Gi',
      HARMONY_GKE_STORAGE_CLASS: 'sc', HARMONY_GKE_DEADLINE_S: '60', HARMONY_GKE_POLL_S: '5', HARMONY_GKE_JOB_TTL_S: '30',
      HARMONY_GKE_IMAGE: 'img', HARMONY_CLOUD_RUN_REGION: 'reg', HARMONY_CLOUD_RUN_JOB: 'job', CLOUDSDK_CORE_PROJECT: 'p',
      CLOUDSDK_CORE_ACCOUNT: 'a@x', HARMONY_PLUGIN_DIR: '/pd', HARMONY_APP_ID: '1', HARMONY_APP_INSTALLATION_ID: '2', HARMONY_APP_PRIVATE_KEY_PATH: '/k',
    };
    const l = legacyToConductor({ deployment: null, env });
    expect(l.envKnobs).toHaveLength(Object.keys(env).length);
    expect(l.layer).toEqual({
      gke: { namespace: 'n', context: 'c', base_secret: 'b', codex_secret: 'x', registry: 'r', cpu: '1', memory: '2Gi', ticket_disk: '10Gi', storage_class: 'sc', deadline_s: 60, poll_s: 5, job_ttl_s: 30 },
      images: { worker: 'img' },
      gcp: { region: 'reg', project: 'p' },
      cloud_run: { job: 'job' },
      gcloud: { account: 'a@x' },
      plugin_dir: '/pd',
      github_app: { app_id: '1', installation_id: '2', private_key_path: '/k' },
    });
    expect(l.warnings).toHaveLength(Object.keys(env).length);
    expect(l.warnings.every((w) => w.startsWith('deprecated: env '))).toBe(true);
  });

  it('ignores env keys we applied ourselves', () => {
    const l = legacyToConductor({ deployment: null, env: { HARMONY_GKE_NAMESPACE: 'ours' }, ignoreEnvKeys: new Set(['HARMONY_GKE_NAMESPACE']) });
    expect(l.used).toBe(false);
  });

  it('warnings go through the warn callback once per message per process', () => {
    const seen: string[] = [];
    const opts = { env: { HARMONY_HOME: H, HARMONY_GKE_CPU: '1' }, ...fs({ [P.snap]: snapshot(gkeProject), [P.host]: host }), warn: (m: string) => seen.push(m) };
    const a = loadConductorConfigSync(opts)!;
    loadConductorConfigSync(opts);
    expect(a.warnings.filter((w) => w.includes('HARMONY_GKE_CPU'))).toHaveLength(1);
    expect(seen.filter((w) => w.includes('HARMONY_GKE_CPU'))).toHaveLength(1);
  });
});

describe('projectToDeploymentConfig', () => {
  it('overlays new-file sections and passes unrelated legacy sections through untouched', () => {
    const legacy = legacyDep({
      env: { WEB_REF: 'main', HARMONY_PLUGIN_POSTURE: 'prod', GIT_USER_NAME: 'n' },
      repos: [{ url: 'u', path: '/p' }],
      launcher: { plugin_dir: '/old', supabase: { url: 'https://s' }, supabase_refs: { abc: 'prod' } },
      profiles: { local: { launch: 'l', reap: 'r' } },
    });
    const merged = mergeLayers({ ...gkeProject, ...host, images: { worker: 'img:2' } });
    const out = projectToDeploymentConfig(merged, legacy);
    expect(out.worker_image).toBe('img:2');
    expect(out.repos).toEqual(legacy.repos);
    expect(out.env).toEqual({ WEB_REF: 'main', GIT_USER_NAME: 'n', HARMONY_PLUGIN_POSTURE: 'ack:staging' });
    expect(out.launcher).toEqual({ plugin_dir: '/plug', github_app: host.github_app, supabase: { url: 'https://s' }, supabase_refs: { abc: 'prod' } });
    expect(out.profiles?.local).toEqual({ launch: 'l', reap: 'r' });
    expect(out.profiles?.gke).toMatchObject({ ...BUILTIN_PROFILES.gke, maxConcurrentWorkers: 3 });
    expect(out.profiles?.gke?.gcloud_project).toBeUndefined();
  });

  it('cloud entry carries gcloud_project; prod channel maps to prod', () => {
    const out = projectToDeploymentConfig(mergeLayers(cloudProject));
    expect(out.profiles?.cloud?.gcloud_project).toBe('proj');
    expect(out.env?.HARMONY_PLUGIN_POSTURE).toBe('prod');
    expect(out.worker_image).toBe('harmony-build-env');
  });

  it('a custom legacy template for the same profile is replaced, with a warning', () => {
    const w: string[] = [];
    const out = projectToDeploymentConfig(mergeLayers(cloudProject), legacyDep({ profiles: { cloud: { launch: 'custom', reap: 'custom' } } }), w);
    expect(out.profiles?.cloud?.launch).toBe(BUILTIN_PROFILES.cloud.launch);
    expect(w).toEqual(['custom launch template in deployment.json profiles.cloud is ignored once conductor.json names profile cloud']);
  });

  it('no warning when the legacy entry equals the built-in template', () => {
    const w: string[] = [];
    projectToDeploymentConfig(mergeLayers(cloudProject), legacyDep({ profiles: { cloud: { ...BUILTIN_PROFILES.cloud } } }), w);
    expect(w).toEqual([]);
  });
});

describe('launchEnvFromMerged / applyLaunchEnv', () => {
  it('builds the launch-script env, deriving the kube context, omitting empties and the registry var', () => {
    const env = launchEnvFromMerged(mergeLayers({ ...gkeProject, gke: { ...gkeProject.gke, poll_s: 5 }, gcloud: { account: 'a@x' }, cloud_run: { job: 'j' } }));
    expect(env).toEqual({
      HARMONY_GKE_NAMESPACE: 'ns-project',
      HARMONY_GKE_CONTEXT: 'gke_proj_us-east1-b_cl',
      HARMONY_GKE_POLL_S: '5',
      HARMONY_CLOUD_RUN_REGION: 'us-east1',
      HARMONY_CLOUD_RUN_JOB: 'j',
      CLOUDSDK_CORE_PROJECT: 'proj',
      CLOUDSDK_CORE_ACCOUNT: 'a@x',
    });
    expect('HARMONY_WORKER_IMAGE_REGISTRY' in env).toBe(false);
    expect('HARMONY_GKE_IMAGE' in env).toBe(false);
  });

  it('exports the host file\'s plugin_dir and App identity for the launch scripts', () => {
    const env = launchEnvFromMerged(mergeLayers(gkeProject, host));
    expect(env).toMatchObject({
      HARMONY_PLUGIN_DIR: '/plug',
      HARMONY_APP_ID: '1',
      HARMONY_APP_INSTALLATION_ID: '2',
      HARMONY_APP_PRIVATE_KEY_PATH: '/k.pem',
    });
  });

  it('explicit gke.context wins; HARMONY_GKE_IMAGE only when images.worker is explicit', () => {
    const env = launchEnvFromMerged(mergeLayers({ ...gkeProject, gke: { ...gkeProject.gke, context: 'my-ctx' }, images: { worker: 'img' } }));
    expect(env.HARMONY_GKE_CONTEXT).toBe('my-ctx');
    expect(env.HARMONY_GKE_IMAGE).toBe('img');
  });

  it('applyLaunchEnv: explicit env wins; a refresh updates only keys we set', () => {
    const target: NodeJS.ProcessEnv = { HARMONY_GKE_CPU: 'operator', EMPTY: '', HARMONY_GKE_MEMORY: '' };
    const applied = new Set<string>();
    const first = applyLaunchEnv(target, { HARMONY_GKE_CPU: '1', HARMONY_GKE_MEMORY: '2Gi', HARMONY_GKE_NAMESPACE: 'a' }, applied);
    expect(first.sort()).toEqual(['HARMONY_GKE_MEMORY', 'HARMONY_GKE_NAMESPACE']);
    expect(target.HARMONY_GKE_CPU).toBe('operator');
    expect([...applied].sort()).toEqual(['HARMONY_GKE_MEMORY', 'HARMONY_GKE_NAMESPACE']);
    const second = applyLaunchEnv(target, { HARMONY_GKE_CPU: '8', HARMONY_GKE_NAMESPACE: 'b', HARMONY_GKE_MEMORY: '2Gi' }, applied);
    expect(second).toEqual(['HARMONY_GKE_NAMESPACE']);
    expect(target.HARMONY_GKE_NAMESPACE).toBe('b');
    expect(target.HARMONY_GKE_CPU).toBe('operator');
  });
});

describe('first-boot rule', () => {
  const dep = legacyDep({ profiles: { cloud: { ...BUILTIN_PROFILES.cloud, gcloud_project: 'old' } }, env: { HARMONY_PLUGIN_POSTURE: 'prod' }, launcher: { plugin_dir: '/lp', github_app: { app_id: '1', installation_id: '2', private_key_path: '/k' } } });

  it('snapshot present: uses it', () => {
    expect(load({ [P.snap]: snapshot(cloudProject), [P.host]: host })!.merged.profile).toBe('cloud');
  });

  it('explicit project file present: uses it', () => {
    expect(load({ [P.project]: cloudProject, [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project })!.merged.channel).toBe('prod');
  });

  it('host only + legacy: runs on legacy with a warning', () => {
    const r = load({ [P.host]: { version: 1 } }, {}, { loadLegacy: () => dep })!;
    expect(r.warnings).toContain('no project file reachable yet; running on legacy files');
    expect(r.merged.profile).toBe('cloud');
    expect(r.merged.gcp?.project).toBe('old');
    expect(r.deploymentConfig.profiles?.cloud).toBeDefined();
  });

  it('host only + legacy env knobs counts as legacy', () => {
    const r = load({ [P.host]: { version: 1, plugin_dir: '/p', github_app: host.github_app } }, {
      HARMONY_CONDUCTOR_PROFILE: 'gke', HARMONY_CONDUCTOR_CHANNEL: 'staging', CLOUDSDK_CORE_PROJECT: 'p', HARMONY_GKE_NAMESPACE: 'n',
      HARMONY_CONDUCTOR_GKE_CLUSTER: 'c', HARMONY_CONDUCTOR_GKE_LOCATION: 'l',
    })!;
    expect(r.warnings).toContain('no project file reachable yet; running on legacy files');
  });

  it('host only + no legacy: throws naming conductor.json with the sync fix', () => {
    const e = errorOf(() => load({ [P.host]: host }));
    expect(e.file).toBe('conductor.json');
    expect(e.key).toBe('(file)');
    expect(e.fix).toBe('run `harmony conductor config sync` or set HARMONY_CONDUCTOR_PROJECT_FILE');
  });

  it('an INVALID project file is not an absence: no legacy fallback', () => {
    const e = errorOf(() => load({ [P.project]: { version: 1 }, [P.host]: host }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project }, { loadLegacy: () => dep }));
    expect(e.issues.some((i) => i.key === 'channel')).toBe(true);
    expect(e.issues.some((i) => i.key === '(file)')).toBe(false);
  });

  it('a corrupt snapshot is ignored with a warning and the first-boot rule applies', () => {
    const r = load({ [P.snap]: 'not json', [P.host]: { version: 1 } }, {}, { loadLegacy: () => dep })!;
    expect(r.warnings.some((w) => w.includes('unreadable or malformed'))).toBe(true);
  });
});

describe('evaluateConductorConfig (doctor mode)', () => {
  it('returns all issues without throwing', () => {
    const ev = evaluateConductorConfig({ env: { HARMONY_HOME: H }, ...fs({ [P.snap]: snapshot({ version: 1, channel: 'staging', profile: 'gke' }), [P.host]: { version: 1 } }), warn: () => {} })!;
    expect(ev.deploymentConfig).toBeNull();
    expect(ev.issues.length).toBeGreaterThan(3);
  });
});

describe('diffRestartRequired', () => {
  it('lists restart-only keys that changed and ignores hot keys', () => {
    const prev = mergeLayers(gkeProject);
    const next = mergeLayers({ ...gkeProject, gke: { ...gkeProject.gke, namespace: 'other' }, images: { worker: 'x' }, concurrency: { max_workers: 9 }, log_shipping: false, model_policy: { default: 'm' } });
    expect(diffRestartRequired(prev, next)).toEqual(['gke.namespace', 'images.worker']);
    expect(diffRestartRequired(prev, prev)).toEqual([]);
  });
});

describe('resolveConfigRepo', () => {
  it('env > host > null', () => {
    expect(resolveConfigRepo({ hostFile: { config_repo: 'a/b' }, env: {} })).toEqual({ repo: 'a/b', ref: 'main' });
    expect(resolveConfigRepo({ hostFile: { config_repo: 'a/b', config_ref: 'x' }, env: { HARMONY_CONDUCTOR_CONFIG_REPO: 'c/d' } })).toEqual({ repo: 'c/d', ref: 'x' });
    expect(resolveConfigRepo({ hostFile: null, env: {} })).toBeNull();
    expect(() => resolveConfigRepo({ env: { HARMONY_CONDUCTOR_CONFIG_REPO: 'nope' } })).toThrow(ConductorConfigError);
  });
});

describe('built-in profiles cannot drift from the example profile JSON files', () => {
  const read = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', p), 'utf8'));
  it('cloud', () => expect(BUILTIN_PROFILES.cloud).toEqual(read('container/daemon-profile.cloud.example.json')));
  it('gke', () => expect(BUILTIN_PROFILES.gke).toEqual(read('container/gke/daemon-profile.gke.example.json')));
});

// B-1183: the project file carries target, supabase_url, repos, agent_flags and per-profile overrides, so a
// conductor runs from the project file + one host file with no deployment.json.
describe('B-1183 project-file keys: schema', () => {
  const text = (extra: Record<string, unknown>) => JSON.stringify({ ...cloudProject, ...extra });
  const issues = (extra: Record<string, unknown>) => {
    const r = validateProjectFileText('conductor.json', text(extra));
    return r.ok ? [] : r.issues;
  };

  it('accepts target, repos, agent_flags and cloud/gke profile blocks', () => {
    const r = validateProjectFileText(
      'conductor.json',
      text({
        target: 'prod',
        repos: [{ url: 'https://github.com/o/w.git', path: '/workspace/w', meta_repo_role: true, ref: 'main' }, { url: 'https://github.com/o/p.git', path: '/workspace/w/p', is_plugin: true }],
        agent_flags: { 'claude-code': '--output-format stream-json' },
        profiles: { cloud: { max_workers: 1 }, gke: { max_workers: 4, agents: ['claude-code'], required_tools: { launch: ['node'] } } },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('accepts supabase_url with target custom', () => {
    expect(validateProjectFileText('conductor.json', text({ target: 'custom', supabase_url: 'https://x.supabase.co' })).ok).toBe(true);
  });

  it.each([{}, { target: 'prod' }, { target: 'staging' }])('refuses supabase_url without target custom (%j)', (t) => {
    const i = issues({ ...t, supabase_url: 'https://x.supabase.co' });
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ key: 'supabase_url', problem: expect.stringContaining('"target": "custom"') });
  });

  it('refuses an agent_flags id that is not wired, naming the allowed ones', () => {
    const i = issues({ agent_flags: { codex: '--x' } });
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ key: 'agent_flags.codex', problem: 'unknown key' });
    expect(i[0].fix).toContain('claude-code');
  });

  it('refuses a profiles key outside cloud and gke (no custom templates)', () => {
    const i = issues({ profiles: { docker: { max_workers: 1 } } });
    expect(i).toHaveLength(1);
    expect(i[0]).toMatchObject({ key: 'profiles.docker', problem: 'unknown key' });
    expect(i[0].fix).toContain('cloud, gke');
  });

  it('refuses a launch template inside a profile block and an invalid target', () => {
    expect(issues({ profiles: { gke: { launch: 'bash x' } } })[0]).toMatchObject({ key: 'profiles.gke.launch', problem: 'unknown key' });
    expect(issues({ target: 'dev' })[0]).toMatchObject({ key: 'target' });
  });

  it('refuses a supabase_url that reaches the merged config without target custom (host file supplies it)', () => {
    const e = errorOf(() => load({ [P.project]: cloudProject, [P.host]: { ...host, supabase_url: 'https://x' } }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project, HARMONY_APP_PRIVATE_KEY: 'k' }));
    expect(e.issues.map((i) => i.key)).toContain('supabase_url');
  });
});

describe('B-1183 project-file keys: projection into the merged DeploymentConfig', () => {
  const full = {
    ...gkeProject,
    target: 'custom',
    supabase_url: 'https://x.supabase.co',
    repos: [{ url: 'https://github.com/o/w.git', path: '/workspace/w', meta_repo_role: true }],
    agent_flags: { 'claude-code': '--verbose' },
    profiles: { cloud: { max_workers: 5, agents: ['claude-code'] }, gke: { required_tools: { launch: ['node', 'kubectl'] } } },
  };

  it('target, supabase_url and agent_flags land in env; repos lands in repos', () => {
    const out = projectToDeploymentConfig(mergeLayers(full));
    expect(out.env).toMatchObject({ HARMONY_PLUGIN_POSTURE: 'ack:staging', HARMONY_TARGET: 'custom', HARMONY_SUPABASE_URL: 'https://x.supabase.co', CLAUDE_HEADLESS_FLAGS: '--verbose' });
    expect(out.repos).toEqual(full.repos);
  });

  it('emits an entry for every listed built-in profile, the top-level profile picking the active one', () => {
    const out = projectToDeploymentConfig(mergeLayers(full));
    expect(Object.keys(out.profiles ?? {}).sort()).toEqual(['cloud', 'gke']);
    expect(out.profiles?.cloud).toMatchObject({ launch: BUILTIN_PROFILES.cloud.launch, maxConcurrentWorkers: 5, agents: ['claude-code'] });
    expect(out.profiles?.gke?.required_tools).toEqual({ ...BUILTIN_PROFILES.gke.required_tools, launch: ['node', 'kubectl'] });
  });

  it('the top-level concurrency applies to the active profile when its block is silent, never to the other', () => {
    const out = projectToDeploymentConfig(mergeLayers(full));
    expect(out.profiles?.gke?.maxConcurrentWorkers).toBe(3);
    expect(out.profiles?.cloud?.maxConcurrentWorkers).toBe(5);
    const blockWins = projectToDeploymentConfig(mergeLayers({ ...full, profiles: { gke: { max_workers: 9 } } }));
    expect(blockWins.profiles?.gke?.maxConcurrentWorkers).toBe(9);
    expect(blockWins.profiles?.cloud?.maxConcurrentWorkers).toBeUndefined();
  });

  it('a project with none of the new keys projects exactly as before (only the active profile, no repos, posture only)', () => {
    const out = projectToDeploymentConfig(mergeLayers(cloudProject));
    expect(Object.keys(out.profiles ?? {})).toEqual(['cloud']);
    expect(out.repos).toBeUndefined();
    expect(out.env).toEqual({ HARMONY_PLUGIN_POSTURE: 'prod' });
  });

  it('flows through the loader: a files-only host (no deployment.json) serves the keys', () => {
    const r = load({ [P.project]: full, [P.host]: { ...host, plugin_dir: '/plug' } }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project, HARMONY_APP_PRIVATE_KEY: 'k' });
    expect(r?.deploymentConfig.env?.HARMONY_TARGET).toBe('custom');
    expect(r?.deploymentConfig.repos).toEqual(full.repos);
    expect(r?.deploymentConfig.profiles?.cloud).toBeDefined();
  });

  it('project < host: a host override of target wins', () => {
    const r = load({ [P.project]: { ...full, target: 'custom' }, [P.host]: { ...host, target: 'custom', supabase_url: 'https://host' } }, { HARMONY_CONDUCTOR_PROJECT_FILE: P.project, HARMONY_APP_PRIVATE_KEY: 'k' });
    expect(r?.deploymentConfig.env?.HARMONY_SUPABASE_URL).toBe('https://host');
  });
});
