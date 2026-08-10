import { describe, it, expect, vi } from 'vitest';
import { runBootPreflight, CURRENT_SCHEMA_VERSION, type PreflightProfile } from './preflight.js';
import type { DaemonConfig } from './config.js';
import type { DeploymentConfig } from '../config/deployment-config.js';

// B-801: runBootPreflight is pure + injectable (runCommand/env/log) — every test here fakes ALL
// three, no real PATH/filesystem access anywhere in this file.

function fakeConfig(): DaemonConfig {
  return {
    pollMs: 25_000,
    heartbeatMs: 30_000,
    staleMs: 300_000,
    retryCap: 2,
    retryBackoffMs: 15_000,
    workerTimeoutMs: 5_400_000,
    maxConcurrentWorkers: 3,
    readyAgeMs: 600_000,
    profile: { launch: 'launch {conduction_id}', reap: 'reap {conduction_id}' },
  };
}

function baseProfile(overrides: Partial<PreflightProfile> = {}): PreflightProfile {
  return {
    launch: 'launch {conduction_id}',
    reap: 'reap {conduction_id}',
    probe: 'probe {conduction_id}',
    required_tools: { launch: ['node'], reap: [], probe: [] },
    ...overrides,
  };
}

/** A runCommand fake that reports FOUND for every tool except those named in `missing`. */
function fakeRunCommand(missing: string[] = []) {
  return vi.fn(async (cmd: string) => {
    const tool = cmd.replace(/^command -v /, '');
    return { exitCode: missing.includes(tool) ? 1 : 0 };
  });
}

describe('runBootPreflight — hard tool resolution (check 1)', () => {
  it('resolves every declared tool via `command -v <tool>` and passes when all are found', async () => {
    const runCommand = fakeRunCommand();
    const log = vi.fn();
    await expect(
      runBootPreflight(fakeConfig(), baseProfile({ required_tools: { launch: ['node', 'docker'] } }), {
        runCommand,
        env: {},
        profileName: 'local',
        log,
      }),
    ).resolves.toBeUndefined();
    expect(runCommand).toHaveBeenCalledWith('command -v node', { quiet: true });
    expect(runCommand).toHaveBeenCalledWith('command -v docker', { quiet: true });
  });

  it('throws naming the missing tool AND the template that invokes it, with the launchd-PATH hint', async () => {
    const runCommand = fakeRunCommand(['gcloud']);
    const log = vi.fn();
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ required_tools: { launch: ['node', 'gcloud'] } }),
        { runCommand, env: {}, profileName: 'cloud', log },
      ),
    ).rejects.toThrow(/Missing required tool "gcloud" \(invoked by profile "cloud"'s "launch" template\)/);
  });

  it('appends the static launchd-PATH hint to a missing-tool error', async () => {
    const runCommand = fakeRunCommand(['docker']);
    await expect(
      runBootPreflight(fakeConfig(), baseProfile({ required_tools: { probe: ['docker'] } }), {
        runCommand,
        env: {},
        profileName: 'local',
        log: vi.fn(),
      }),
    ).rejects.toThrow(/launchd inherits a minimal PATH/);
  });

  it('names the correct template (reap vs probe) for the missing tool', async () => {
    const runCommand = fakeRunCommand(['docker']);
    await expect(
      runBootPreflight(fakeConfig(), baseProfile({ required_tools: { reap: ['docker'] } }), {
        runCommand,
        env: {},
        profileName: 'local',
        log: vi.fn(),
      }),
    ).rejects.toThrow(/"reap" template/);
  });

  it('never invokes runCommand at all when required_tools is absent (nothing declared to check)', async () => {
    const runCommand = fakeRunCommand();
    await runBootPreflight(fakeConfig(), baseProfile({ required_tools: undefined }), {
      runCommand,
      env: {},
      profileName: 'local',
      log: vi.fn(),
    });
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('runBootPreflight — hard env-contract check (check 2)', () => {
  const ALL_VARS = {
    HARMONY_APP_ID: '123',
    HARMONY_APP_INSTALLATION_ID: '456',
    HARMONY_APP_PRIVATE_KEY_PATH: '/path/to/key.pem',
    HARMONY_PLUGIN_DIR: '/path/to/plugin',
  };

  it('is skipped entirely when requires_app_mint is not set', async () => {
    await expect(
      runBootPreflight(fakeConfig(), baseProfile({ requires_app_mint: undefined, required_tools: undefined }), {
        runCommand: fakeRunCommand(),
        env: {},
        profileName: 'local',
        log: vi.fn(),
      }),
    ).resolves.toBeUndefined();
  });

  it('passes when requires_app_mint is true and all four env vars resolve', async () => {
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ requires_app_mint: true, required_tools: undefined }),
        { runCommand: fakeRunCommand(), env: ALL_VARS, profileName: 'local', log: vi.fn() },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws naming the missing variable and the container/README.md section, on a miss', async () => {
    const { HARMONY_APP_ID: _drop, ...rest } = ALL_VARS;
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ requires_app_mint: true, required_tools: undefined }),
        { runCommand: fakeRunCommand(), env: rest, profileName: 'local', log: vi.fn() },
      ),
    ).rejects.toThrow(
      /Missing required launcher-host config "HARMONY_APP_ID" — see container\/README\.md § The credential envelopes\./,
    );
  });

  it('treats an EMPTY env value as unset (B-694 shadow class)', async () => {
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ requires_app_mint: true, required_tools: undefined }),
        {
          runCommand: fakeRunCommand(),
          env: { ...ALL_VARS, HARMONY_PLUGIN_DIR: '' },
          profileName: 'local',
          log: vi.fn(),
        },
      ),
    ).rejects.toThrow(/HARMONY_PLUGIN_DIR/);
  });

  it('resolves a missing env var from the deployment config launcher section instead (env OR config)', async () => {
    const { HARMONY_APP_ID: _drop, HARMONY_APP_INSTALLATION_ID: _drop2, HARMONY_APP_PRIVATE_KEY_PATH: _drop3, HARMONY_PLUGIN_DIR: _drop4, ...rest } = ALL_VARS;
    const deploymentConfig: DeploymentConfig = {
      launcher: {
        plugin_dir: '/from/config/plugin',
        github_app: { app_id: 'cfg-123', installation_id: 'cfg-456', private_key_path: '/from/config/key.pem' },
      },
    };
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ requires_app_mint: true, required_tools: undefined }),
        { runCommand: fakeRunCommand(), env: rest, deploymentConfig, profileName: 'local', log: vi.fn() },
      ),
    ).resolves.toBeUndefined();
  });

  it('still throws when neither env nor the deployment config resolve a var', async () => {
    const deploymentConfig: DeploymentConfig = { launcher: { plugin_dir: '/from/config/plugin' } };
    await expect(
      runBootPreflight(
        fakeConfig(),
        baseProfile({ requires_app_mint: true, required_tools: undefined }),
        { runCommand: fakeRunCommand(), env: {}, deploymentConfig, profileName: 'local', log: vi.fn() },
      ),
    ).rejects.toThrow(/HARMONY_APP_ID/);
  });

  it('never calls runCommand for the env-contract check (tool resolution and env-contract are independent)', async () => {
    const runCommand = fakeRunCommand();
    await runBootPreflight(
      fakeConfig(),
      baseProfile({ requires_app_mint: true, required_tools: undefined }),
      { runCommand, env: ALL_VARS, profileName: 'local', log: vi.fn() },
    );
    expect(runCommand).not.toHaveBeenCalled();
  });
});

describe('runBootPreflight — soft profile-capability audit (check 3, never throws)', () => {
  it('logs the probe-absent consequence when the profile has no probe template', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ probe: undefined }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('mid-leg re-attach disabled; takeovers will reap-and-refire running workers'),
    );
  });

  it('does NOT log the probe line when a probe template is present', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ probe: 'probe {conduction_id}' }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('mid-leg re-attach disabled'));
  });

  it('logs the required_tools-absent consequence when the whole block is missing', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ required_tools: undefined }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('tool-on-PATH preflight skipped for this profile'),
    );
  });

  it('does NOT log the required_tools line when the block is present (even if empty)', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ required_tools: {} }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('tool-on-PATH preflight skipped'));
  });

  it('logs the gcloud_project fallback consequence when required_tools names gcloud anywhere and gcloud_project is absent', async () => {
    const log = vi.fn();
    await runBootPreflight(
      fakeConfig(),
      baseProfile({ required_tools: { probe: ['gcloud'] }, gcloud_project: undefined }),
      { runCommand: fakeRunCommand(), env: {}, profileName: 'cloud', log },
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('cloud-worker-*.sh falls back to its own CLOUDSDK_CORE_PROJECT default'),
    );
  });

  it('does NOT log the gcloud_project line when gcloud_project is set', async () => {
    const log = vi.fn();
    await runBootPreflight(
      fakeConfig(),
      baseProfile({ required_tools: { probe: ['gcloud'] }, gcloud_project: 'my-project' }),
      { runCommand: fakeRunCommand(), env: {}, profileName: 'cloud', log },
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('CLOUDSDK_CORE_PROJECT'));
  });

  it('does NOT log the gcloud_project line when required_tools never names gcloud, even with gcloud_project absent', async () => {
    const log = vi.fn();
    await runBootPreflight(
      fakeConfig(),
      baseProfile({ required_tools: { launch: ['node', 'docker'] }, gcloud_project: undefined }),
      { runCommand: fakeRunCommand(), env: {}, profileName: 'local', log },
    );
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('CLOUDSDK_CORE_PROJECT'));
  });

  it('logs a stale-schema_version line naming the capabilities added since, when schema_version is behind current', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ schema_version: 0 }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/schema_version \(0\) is behind the current schema version \(1\)/),
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('required_tools'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('requires_app_mint'));
  });

  it('does NOT log the stale-schema_version line when schema_version is absent (defaults to current)', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ schema_version: undefined }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('is behind the current schema version'));
  });

  it('does NOT log the stale-schema_version line when schema_version equals CURRENT_SCHEMA_VERSION', async () => {
    const log = vi.fn();
    await runBootPreflight(fakeConfig(), baseProfile({ schema_version: CURRENT_SCHEMA_VERSION }), {
      runCommand: fakeRunCommand(),
      env: {},
      profileName: 'local',
      log,
    });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('is behind the current schema version'));
  });

  it('a fully-populated profile logs NOTHING (no absent capability, no stale schema_version)', async () => {
    const log = vi.fn();
    await runBootPreflight(
      fakeConfig(),
      baseProfile({
        probe: 'probe {conduction_id}',
        required_tools: { launch: ['node'], reap: [], probe: [] },
        gcloud_project: undefined,
        schema_version: CURRENT_SCHEMA_VERSION,
      }),
      { runCommand: fakeRunCommand(), env: {}, profileName: 'local', log },
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('never throws for any soft-audit condition, even when everything absent at once', async () => {
    const log = vi.fn();
    await expect(
      runBootPreflight(
        fakeConfig(),
        {
          launch: 'launch {conduction_id}',
          reap: 'reap {conduction_id}',
        },
        { runCommand: fakeRunCommand(), env: {}, profileName: 'bare', log },
      ),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2); // probe absent + required_tools absent (no gcloud named, schema_version defaults to current)
  });
});
