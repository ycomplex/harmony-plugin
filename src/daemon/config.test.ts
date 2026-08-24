import { describe, it, expect } from 'vitest';
import { loadDaemonConfig, renderTemplate, selectNamedProfile } from './config.js';
import { loadDeploymentConfig } from '../config/deployment-config.js';
import type { DeploymentConfig } from '../config/deployment-config.js';

const PROFILE_JSON = JSON.stringify({
  launch: "docker run --rm --name harmony-worker-{conduction_id} img worker '{ticket}'",
  reap: 'docker rm -f harmony-worker-{conduction_id}',
});

function envWith(overrides: Record<string, string | undefined> = {}) {
  return { HARMONY_DAEMON_PROFILE: '/etc/harmony/profile.json', ...overrides };
}

const readProfile = (p: string) => {
  if (p !== '/etc/harmony/profile.json') throw new Error(`unexpected path ${p}`);
  return PROFILE_JSON;
};

describe('loadDaemonConfig', () => {
  it('applies the design defaults: poll 25s, heartbeat 30s, stale 5min', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.pollMs).toBe(25000);
    expect(cfg.heartbeatMs).toBe(30000);
    expect(cfg.staleMs).toBe(300000);
  });

  it('reads the cadence knobs from env when set', () => {
    const cfg = loadDaemonConfig(
      envWith({
        HARMONY_DAEMON_POLL_MS: '10000',
        HARMONY_DAEMON_HEARTBEAT_MS: '15000',
        HARMONY_DAEMON_STALE_MS: '60000',
      }),
      readProfile,
    );
    expect(cfg.pollMs).toBe(10000);
    expect(cfg.heartbeatMs).toBe(15000);
    expect(cfg.staleMs).toBe(60000);
  });

  // B-739: the worker deadline is deliberately GENEROUS — it catches a hung worker, it does not
  // police a slow one. The 32.6-minute stall that motivated the ticket recovered on its own, so a
  // deadline anywhere near normal build times would destroy healthy runs.
  it('defaults the worker deadline to 90 minutes, well above a normal long build', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.workerTimeoutMs).toBe(5_400_000);
  });

  it('reads HARMONY_DAEMON_WORKER_TIMEOUT_MS from env when set', () => {
    const cfg = loadDaemonConfig(
      envWith({ HARMONY_DAEMON_WORKER_TIMEOUT_MS: '600000' }),
      readProfile,
    );
    expect(cfg.workerTimeoutMs).toBe(600_000);
  });

  it('rejects a non-positive worker deadline (a zero deadline would reap every worker instantly)', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_WORKER_TIMEOUT_MS: '0' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_WORKER_TIMEOUT_MS/);
  });

  it('parses the profile JSON from the HARMONY_DAEMON_PROFILE path', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.profile.launch).toContain('harmony-worker-{conduction_id}');
    expect(cfg.profile.reap).toBe('docker rm -f harmony-worker-{conduction_id}');
  });

  it('throws when HARMONY_DAEMON_PROFILE is missing, naming the env var (no baked default command)', () => {
    expect(() => loadDaemonConfig({}, readProfile)).toThrow(/HARMONY_DAEMON_PROFILE/);
  });

  it('treats an EMPTY env value as unset (the B-694 empty-env-value shadow class)', () => {
    expect(() => loadDaemonConfig({ HARMONY_DAEMON_PROFILE: '' }, readProfile)).toThrow(
      /HARMONY_DAEMON_PROFILE/,
    );
    const cfg = loadDaemonConfig(envWith({ HARMONY_DAEMON_POLL_MS: '' }), readProfile);
    expect(cfg.pollMs).toBe(25000);
  });

  it('throws loudly when the profile JSON lacks a launch or reap template', () => {
    expect(() => loadDaemonConfig(envWith(), () => JSON.stringify({ launch: 'x' }))).toThrow(/reap/);
    expect(() => loadDaemonConfig(envWith(), () => JSON.stringify({ reap: 'x' }))).toThrow(/launch/);
  });

  it('throws loudly on a non-numeric cadence knob', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_POLL_MS: 'soon' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_POLL_MS/);
  });

  it('applies the B-713 retry defaults: cap 2, backoff 15s', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.retryCap).toBe(2);
    expect(cfg.retryBackoffMs).toBe(15000);
  });

  it('reads the B-713 retry knobs from env when set', () => {
    const cfg = loadDaemonConfig(
      envWith({
        HARMONY_DAEMON_RETRY_CAP: '4',
        HARMONY_DAEMON_RETRY_BACKOFF_MS: '5000',
      }),
      readProfile,
    );
    expect(cfg.retryCap).toBe(4);
    expect(cfg.retryBackoffMs).toBe(5000);
  });

  it('accepts HARMONY_DAEMON_RETRY_CAP=0 (disables retry)', () => {
    const cfg = loadDaemonConfig(envWith({ HARMONY_DAEMON_RETRY_CAP: '0' }), readProfile);
    expect(cfg.retryCap).toBe(0);
  });

  it('throws loudly on non-numeric retry knobs', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_RETRY_CAP: 'soon' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_RETRY_CAP/);
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_RETRY_BACKOFF_MS: 'a-bit' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_RETRY_BACKOFF_MS/);
  });

  it('throws loudly on a negative retry cap', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_RETRY_CAP: '-1' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_RETRY_CAP/);
  });

  it('B-717: defaults maxConcurrentWorkers to 3 and readyAgeMs to 10 minutes', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.maxConcurrentWorkers).toBe(3);
    expect(cfg.readyAgeMs).toBe(600_000);
  });

  it('B-717: HARMONY_DAEMON_MAX_CONCURRENT_WORKERS overrides the default', () => {
    const cfg = loadDaemonConfig(envWith({ HARMONY_DAEMON_MAX_CONCURRENT_WORKERS: '5' }), readProfile);
    expect(cfg.maxConcurrentWorkers).toBe(5);
  });

  it('B-717: a profile-level maxConcurrentWorkers is read as the per-profile default, below the env var', () => {
    const profileWithCap = JSON.stringify({
      launch: 'launch {conduction_id} {ticket}',
      reap: 'reap {conduction_id}',
      maxConcurrentWorkers: 2,
    });
    const readWithCap = (p: string) => {
      if (p !== '/etc/harmony/profile.json') throw new Error(`unexpected path ${p}`);
      return profileWithCap;
    };
    expect(loadDaemonConfig(envWith(), readWithCap).maxConcurrentWorkers).toBe(2);
    // The env var still wins over the profile's own default.
    expect(
      loadDaemonConfig(envWith({ HARMONY_DAEMON_MAX_CONCURRENT_WORKERS: '7' }), readWithCap)
        .maxConcurrentWorkers,
    ).toBe(7);
  });

  it('B-717: rejects a non-integer or negative maxConcurrentWorkers', () => {
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_MAX_CONCURRENT_WORKERS: 'many' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_MAX_CONCURRENT_WORKERS/);
    expect(() =>
      loadDaemonConfig(envWith({ HARMONY_DAEMON_MAX_CONCURRENT_WORKERS: '-1' }), readProfile),
    ).toThrow(/HARMONY_DAEMON_MAX_CONCURRENT_WORKERS/);
  });

  it('B-717: HARMONY_DAEMON_READY_AGE_MS overrides the 10-minute default', () => {
    const cfg = loadDaemonConfig(envWith({ HARMONY_DAEMON_READY_AGE_MS: '120000' }), readProfile);
    expect(cfg.readyAgeMs).toBe(120_000);
  });

  it('B-717: reads an optional "probe" template from the profile JSON when present', () => {
    const probeProfile = JSON.stringify({
      launch: 'launch {conduction_id} {ticket}',
      reap: 'reap {conduction_id}',
      probe: 'probe {conduction_id}',
    });
    const readWithProbe = (p: string) => {
      if (p !== '/etc/harmony/profile.json') throw new Error(`unexpected path ${p}`);
      return probeProfile;
    };
    expect(loadDaemonConfig(envWith(), readWithProbe).profile.probe).toBe('probe {conduction_id}');
    // Absent by default — reconciliation is opt-in per profile.
    expect(loadDaemonConfig(envWith(), readProfile).profile.probe).toBeUndefined();
  });

  it('B-717: rejects an empty-string "probe" template', () => {
    const badProfile = JSON.stringify({
      launch: 'launch {conduction_id} {ticket}',
      reap: 'reap {conduction_id}',
      probe: '',
    });
    const readBad = () => badProfile;
    expect(() => loadDaemonConfig(envWith(), readBad)).toThrow(/probe/);
  });

  it('carries the optional log path from HARMONY_DAEMON_LOG', () => {
    expect(loadDaemonConfig(envWith(), readProfile).logPath).toBeUndefined();
    expect(
      loadDaemonConfig(envWith({ HARMONY_DAEMON_LOG: '/var/log/hd.log' }), readProfile).logPath,
    ).toBe('/var/log/hd.log');
  });
});

describe('renderTemplate', () => {
  it('substitutes BOTH placeholders, every occurrence', () => {
    expect(
      renderTemplate('run --name harmony-worker-{conduction_id} w {ticket} # {conduction_id}', {
        conduction_id: 'cond-1',
        ticket: 'B-696',
      }),
    ).toBe('run --name harmony-worker-cond-1 w B-696 # cond-1');
  });

  it('throws LOUDLY on an unknown {placeholder} — never silently leaves it in the command', () => {
    expect(() =>
      renderTemplate('run {conduction_id} {worker_image}', { conduction_id: 'c', ticket: 't' }),
    ).toThrow(/worker_image/);
  });

  it('leaves non-placeholder shell syntax (e.g. $HOME) untouched', () => {
    expect(renderTemplate('run --env-file $HOME/.env {ticket}', { conduction_id: 'c', ticket: 'B-1' })).toBe(
      'run --env-file $HOME/.env B-1',
    );
  });

  it('B-718: substitutes {run_config_json} when supplied', () => {
    expect(
      renderTemplate("--run-config '{run_config_json}'", {
        conduction_id: 'c',
        ticket: 'B-718',
        run_config_json: '{"session_resume":{"enabled":true}}',
      }),
    ).toBe('--run-config \'{"session_resume":{"enabled":true}}\'');
  });

  it('B-718: throws on {run_config_json} when the caller did not supply it (same unknown-placeholder discipline)', () => {
    expect(() =>
      renderTemplate('run {run_config_json}', { conduction_id: 'c', ticket: 't' }),
    ).toThrow(/run_config_json/);
  });
});

// B-800: selecting a launch profile BY NAME from an already-loaded deployment config, and the
// fallback-to-file-path precedence loadDaemonConfig applies around it.
describe('selectNamedProfile', () => {
  const deploymentConfig: DeploymentConfig = {
    profiles: {
      local: { launch: 'docker run local {conduction_id}', reap: 'docker rm -f local-{conduction_id}' },
      cloud: {
        launch: 'cloud-worker-launch.sh {conduction_id} {ticket}',
        reap: 'cloud-worker-reap.sh {conduction_id} {ticket}',
        maxConcurrentWorkers: 2,
      },
    },
  };

  it('returns the named profile when the config carries it', () => {
    expect(selectNamedProfile(deploymentConfig, 'cloud')).toEqual(
      deploymentConfig.profiles!.cloud,
    );
  });

  it('returns null when no profileName is given', () => {
    expect(selectNamedProfile(deploymentConfig, undefined)).toBeNull();
  });

  it('returns null when the deployment config is null (no file present)', () => {
    expect(selectNamedProfile(null, 'cloud')).toBeNull();
  });

  it('returns null when the named profile is not in the config\'s "profiles" section', () => {
    expect(selectNamedProfile(deploymentConfig, 'nonexistent')).toBeNull();
  });

  it('returns null when the config has no "profiles" section at all', () => {
    expect(selectNamedProfile({ launcher: { plugin_dir: '/x' } }, 'cloud')).toBeNull();
  });
});

describe('loadDaemonConfig — B-800 profileOverride precedence', () => {
  it('uses profileOverride directly, never touching HARMONY_DAEMON_PROFILE or readFile', () => {
    const explodingReadFile = () => {
      throw new Error('readFile must not be called when profileOverride is given');
    };
    const cfg = loadDaemonConfig(
      { HARMONY_DAEMON_PROFILE: '/should/not/be/read.json' },
      explodingReadFile,
      { profileOverride: { launch: 'named-launch {conduction_id}', reap: 'named-reap {conduction_id}' } },
    );
    expect(cfg.profile.launch).toBe('named-launch {conduction_id}');
    expect(cfg.profile.reap).toBe('named-reap {conduction_id}');
  });

  it('wins over HARMONY_DAEMON_PROFILE even when the env var is ALSO set to a valid path', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile, {
      profileOverride: { launch: 'override-launch', reap: 'override-reap' },
    });
    expect(cfg.profile.launch).toBe('override-launch');
    expect(cfg.profile.reap).toBe('override-reap');
  });

  it('falls back to the unchanged HARMONY_DAEMON_PROFILE file-path route when no override is given', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile);
    expect(cfg.profile.launch).toContain('harmony-worker-{conduction_id}');
  });

  it('falls back to the file-path route when opts is the empty default (no profileOverride key at all)', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile, {});
    expect(cfg.profile.reap).toBe('docker rm -f harmony-worker-{conduction_id}');
  });

  it('still errors, with an adapted message naming BOTH routes, when neither resolves', () => {
    expect(() => loadDaemonConfig({}, readProfile)).toThrow(/HARMONY_DAEMON_PROFILE/);
    expect(() => loadDaemonConfig({}, readProfile)).toThrow(/--profile/);
  });

  it('carries the override\'s own maxConcurrentWorkers through the same env-var > profile > default precedence', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile, {
      profileOverride: { launch: 'l', reap: 'r', maxConcurrentWorkers: 4 },
    });
    expect(cfg.maxConcurrentWorkers).toBe(4);

    const cfgEnvWins = loadDaemonConfig(
      envWith({ HARMONY_DAEMON_MAX_CONCURRENT_WORKERS: '9' }),
      readProfile,
      { profileOverride: { launch: 'l', reap: 'r', maxConcurrentWorkers: 4 } },
    );
    expect(cfgEnvWins.maxConcurrentWorkers).toBe(9);
  });

  it('carries the override\'s optional probe template through', () => {
    const cfg = loadDaemonConfig(envWith(), readProfile, {
      profileOverride: { launch: 'l', reap: 'r', probe: 'probe {conduction_id}' },
    });
    expect(cfg.profile.probe).toBe('probe {conduction_id}');
  });
});

// B-801 items 1/2/9: required_tools / requires_app_mint / schema_version, mirrored in BOTH schema
// surfaces (src/config/deployment-config.ts's LaunchProfileSchema and this module's own legacy
// file-path validation), kept in lockstep. This is the schema-parity guard against prose drift.
describe('B-801: required_tools / requires_app_mint / schema_version — schema parity across BOTH surfaces', () => {
  const NEW_FIELDS = {
    required_tools: { launch: ['node', 'docker'], reap: ['docker'], probe: ['docker'] },
    requires_app_mint: true,
    schema_version: 1,
  };

  it('the legacy file-path route (src/daemon/config.ts) accepts and carries all three fields through', () => {
    const profileWithNewFields = JSON.stringify({
      launch: 'launch {conduction_id}',
      reap: 'reap {conduction_id}',
      ...NEW_FIELDS,
    });
    const readWithNewFields = (p: string) => {
      if (p !== '/etc/harmony/profile.json') throw new Error(`unexpected path ${p}`);
      return profileWithNewFields;
    };
    const cfg = loadDaemonConfig(envWith(), readWithNewFields);
    expect(cfg.profile.required_tools).toEqual(NEW_FIELDS.required_tools);
    expect(cfg.profile.requires_app_mint).toBe(true);
    expect(cfg.profile.schema_version).toBe(1);
  });

  it('the B-800 named-profile route (src/config/deployment-config.ts) accepts and carries all three fields through', () => {
    const io = {
      existsSync: (p: string) => p === '/deployment.json',
      readFileSync: (p: string) => {
        if (p !== '/deployment.json') throw new Error(`unexpected path ${p}`);
        return JSON.stringify({
          profiles: {
            cloud: { launch: 'launch {conduction_id}', reap: 'reap {conduction_id}', ...NEW_FIELDS },
          },
        });
      },
    };
    const loaded = loadDeploymentConfig({ configPath: '/deployment.json', ...io });
    expect(loaded?.profiles?.cloud.required_tools).toEqual(NEW_FIELDS.required_tools);
    expect(loaded?.profiles?.cloud.requires_app_mint).toBe(true);
    expect(loaded?.profiles?.cloud.schema_version).toBe(1);
  });

  it('the legacy route rejects a malformed required_tools (not an object of string arrays)', () => {
    const badProfile = JSON.stringify({
      launch: 'launch {conduction_id}',
      reap: 'reap {conduction_id}',
      required_tools: { launch: 'docker' }, // should be an array, not a bare string
    });
    expect(() => loadDaemonConfig(envWith(), () => badProfile)).toThrow(/required_tools/);
  });

  it('the legacy route rejects a non-boolean requires_app_mint and a non-positive-integer schema_version', () => {
    expect(() =>
      loadDaemonConfig(
        envWith(),
        () =>
          JSON.stringify({
            launch: 'l {conduction_id}',
            reap: 'r {conduction_id}',
            requires_app_mint: 'yes',
          }),
      ),
    ).toThrow(/requires_app_mint/);
    expect(() =>
      loadDaemonConfig(
        envWith(),
        () =>
          JSON.stringify({ launch: 'l {conduction_id}', reap: 'r {conduction_id}', schema_version: 0 }),
      ),
    ).toThrow(/schema_version/);
  });

  it('the B-800 named-profile route rejects a malformed required_tools/requires_app_mint/schema_version too', () => {
    const io = {
      existsSync: (p: string) => p === '/deployment.json',
      readFileSync: (p: string) =>
        JSON.stringify({
          profiles: {
            cloud: {
              launch: 'launch {conduction_id}',
              reap: 'reap {conduction_id}',
              requires_app_mint: 'yes',
            },
          },
        }),
    };
    expect(() => loadDeploymentConfig({ configPath: '/deployment.json', ...io })).toThrow(
      /failed validation/,
    );
  });
});
