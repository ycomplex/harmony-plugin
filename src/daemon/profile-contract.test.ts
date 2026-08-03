// B-696 cross-file drift guard: the shipped launch-profile template must speak the container
// ENTRYPOINT's mode contract. provision.sh dispatches on its FIRST argument (`shell | headless
// <prompt>`), so the token right after the image name in the launch template MUST be one of
// provision.sh's real modes — the original template passed `claude` there, which provision.sh
// rejects as an unknown mode. Both files are read from disk so either side drifting breaks CI.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const profilePath = fileURLToPath(
  new URL('../../container/daemon-profile.example.json', import.meta.url),
);
const provisionPath = fileURLToPath(new URL('../../container/provision.sh', import.meta.url));

const IMAGE_NAME = 'harmony-build-env';

/** The token the container ENTRYPOINT receives as its first argument: the word immediately
 *  following the image name in the docker run command line. */
function modeTokenAfterImage(launch: string): string | undefined {
  const words = launch.split(/\s+/);
  const imageIndex = words.indexOf(IMAGE_NAME);
  expect(imageIndex).toBeGreaterThanOrEqual(0); // the template must still launch the known image
  return words[imageIndex + 1];
}

/** provision.sh's REAL modes: the literal labels of its `case "$MODE" in` dispatch. */
function provisionModes(script: string): string[] {
  const caseBlock = /case\s+"\$MODE"\s+in\n([\s\S]*?)\nesac/.exec(script);
  if (!caseBlock) return [];
  const modes: string[] = [];
  for (const line of caseBlock[1].split('\n')) {
    const label = /^\s*([a-z][a-z0-9_-]*)\)/.exec(line);
    if (label) modes.push(label[1]);
  }
  return modes;
}

describe('daemon-profile.example.json ↔ provision.sh mode contract', () => {
  it('the launch template passes a REAL provision.sh mode as the first arg after the image name', () => {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
    const script = readFileSync(provisionPath, 'utf8');

    const modes = provisionModes(script);
    // Guard the guard: an empty parsed set means the extraction regex drifted off provision.sh's
    // shape — that must fail loudly, not vacuously pass.
    expect(modes.length).toBeGreaterThan(0);
    expect(modes).toContain('headless'); // the daemon's one-shot workers are headless by design

    const modeToken = modeTokenAfterImage(profile.launch);
    expect(modes).toContain(modeToken);
  });
});

// B-724 transcript-persistence contract: the worker's Claude session logs must survive the
// container's --rm. The launch template therefore bind-mounts per-conduction host dirs over the
// worker's ~/.claude/projects and ~/.claude/logs — and must `mkdir -p` those host dirs BEFORE
// `docker run`, because Docker auto-creates missing bind sources root-owned, which the uid-1001
// worker cannot write (probe-proven at the B-724 design gate).

/** The `-v host:container` mappings of the docker run command line. */
function volumeMappings(launch: string): Array<{ host: string; container: string }> {
  const words = launch.split(/\s+/);
  const mappings: Array<{ host: string; container: string }> = [];
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === '-v' || words[i] === '--volume') {
      const [host, container] = words[i + 1].split(':');
      mappings.push({ host, container });
    }
  }
  return mappings;
}

describe('daemon-profile.example.json transcript-mount contract (B-724)', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
  const mounts = volumeMappings(profile.launch);

  it('bind-mounts both Claude session-log locations (projects + logs)', () => {
    const targets = mounts.map((m) => m.container);
    expect(targets).toContain('/home/worker/.claude/projects');
    expect(targets).toContain('/home/worker/.claude/logs');
  });

  it('namespaces every transcript mount host-side by {ticket} AND {conduction_id}', () => {
    for (const m of mounts) {
      expect(m.host).toContain('{ticket}');
      expect(m.host).toContain('{conduction_id}');
    }
  });

  it('pre-creates every mounted host dir (mkdir -p …) BEFORE docker run', () => {
    const dockerRunAt = profile.launch.indexOf('docker run');
    expect(dockerRunAt).toBeGreaterThan(0);
    const preamble = profile.launch.slice(0, dockerRunAt);
    expect(preamble).toMatch(/^mkdir -p /);
    for (const m of mounts) {
      expect(preamble).toContain(m.host);
    }
  });
});

// B-724 reopen (verify-found): Docker creates mount-point PARENTS root-owned inside the
// container, so mounting under ~/.claude breaks any non-mounted sibling writer — the B-719
// declared-agent install (mkdir ~/.claude/agents) died with Permission denied on a live daemon
// leg. The image must therefore pre-create every container-side mount target (and the agents
// dir) worker-owned, so mounts land on pre-existing dirs and the parent stays writable.

const dockerfilePath = fileURLToPath(new URL('../../container/Dockerfile', import.meta.url));

describe('daemon-profile.example.json ↔ Dockerfile mount-parent ownership contract (B-724)', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { launch: string };
  const dockerfile = readFileSync(dockerfilePath, 'utf8');
  const mounts = volumeMappings(profile.launch);

  it('the Dockerfile pre-creates every container-side mount target of the launch template', () => {
    expect(mounts.length).toBeGreaterThan(0); // guard the guard — no mounts means the parse drifted
    for (const m of mounts) {
      expect(dockerfile).toContain(m.container);
    }
  });

  it('the Dockerfile pre-creates the declared-agent install dir and chowns ~/.claude to worker', () => {
    expect(dockerfile).toContain('/home/worker/.claude/agents');
    expect(dockerfile).toMatch(/chown -R worker:worker \/home\/worker\/\.claude/);
  });
});

// B-732 bot-identity credential contract: daemon workers must author PRs as the harmony-daemon
// App, not as the founder. That hinges entirely on WHICH token reaches the container, so the
// launch template must mint a fresh installation token into a PER-RUN env-file and hand THAT to
// docker — never the static founder-PAT file. The reap template must then delete it, so a minted
// credential does not outlive the worker it was minted for.

const mintScriptPath = fileURLToPath(
  new URL('../../scripts/mint-installation-token.mjs', import.meta.url),
);

/** The value of the launch template's `--env-file` flag. */
function envFileArg(launch: string): string | undefined {
  const words = launch.split(/\s+/);
  const at = words.indexOf('--env-file');
  return at >= 0 ? words[at + 1] : undefined;
}

describe('daemon-profile.example.json bot-identity credential contract (B-732)', () => {
  const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
    launch: string;
    reap: string;
  };

  it('mints the installation token BEFORE docker run', () => {
    const dockerRunAt = profile.launch.indexOf('docker run');
    expect(dockerRunAt).toBeGreaterThan(0);
    expect(profile.launch.slice(0, dockerRunAt)).toContain('mint-installation-token.mjs');
  });

  it('hands docker the PER-RUN minted env-file, not the static founder-PAT one', () => {
    const envFile = envFileArg(profile.launch);
    expect(envFile).toBeDefined();
    // Per-run: namespaced by conduction, so concurrent workers never share a token file.
    expect(envFile).toContain('{conduction_id}');
    // The mint's --out and docker's --env-file must be the SAME file, or the worker silently
    // launches with whatever the old file held — the fail-open this ticket exists to close.
    expect(profile.launch).toContain(`--out ${envFile}`);
  });

  it('deletes the minted env-file at reap so the credential does not outlive its worker', () => {
    const envFile = envFileArg(profile.launch);
    expect(profile.reap).toContain('rm -f');
    expect(profile.reap).toContain(envFile as string);
  });

  it('never passes the token inline, where the host process table would expose it', () => {
    expect(profile.launch).not.toMatch(/-e\s+GIT_TOKEN/);
    expect(profile.launch).not.toMatch(/--env\s+GIT_TOKEN/);
    expect(profile.launch).not.toMatch(/GIT_TOKEN=/);
  });

  it('the mint script the template invokes actually exists', () => {
    // Guard the guard: a renamed script would otherwise leave the assertions above passing
    // against a template that fails at launch.
    expect(readFileSync(mintScriptPath, 'utf8')).toContain('export function composeEnvFile');
  });
});

// ------------------------------------------------------------------------------------------------
// B-754: the SECOND, alternative "cloud" launch profile (Cloud Run job execution in place of
// `docker run`). Selected via the SAME HARMONY_DAEMON_PROFILE env var — no new selection mechanism.
// The docker profile above stays completely untouched; these are NEW, additive describe blocks that
// exercise only the new profile + its two wrapper scripts. The daemon's scheduler/classify code is
// deliberately NOT exercised here — the whole point of the wrapper-script design is that the daemon
// never changes, so these tests pin the wrapper scripts' text instead.

const cloudProfilePath = fileURLToPath(
  new URL('../../container/daemon-profile.cloud.example.json', import.meta.url),
);
const cloudLaunchScriptPath = fileURLToPath(
  new URL('../../container/cloud-worker-launch.sh', import.meta.url),
);
const cloudReapScriptPath = fileURLToPath(
  new URL('../../container/cloud-worker-reap.sh', import.meta.url),
);

describe('daemon-profile.cloud.example.json shape', () => {
  it('is a valid { launch, reap } profile, structurally interchangeable with the docker one', () => {
    const profile = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as {
      launch: string;
      reap: string;
    };
    expect(typeof profile.launch).toBe('string');
    expect(profile.launch.length).toBeGreaterThan(0);
    expect(typeof profile.reap).toBe('string');
    expect(profile.reap.length).toBeGreaterThan(0);
  });

  it('carries the {conduction_id} / {ticket} placeholders on BOTH templates, same as the docker profile', () => {
    const profile = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as {
      launch: string;
      reap: string;
    };
    expect(profile.launch).toContain('{conduction_id}');
    expect(profile.launch).toContain('{ticket}');
    expect(profile.reap).toContain('{conduction_id}');
    expect(profile.reap).toContain('{ticket}');
  });

  it('points launch and reap at the two dedicated cloud wrapper scripts, not an inline docker/gcloud command', () => {
    const profile = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as {
      launch: string;
      reap: string;
    };
    expect(profile.launch).toContain('cloud-worker-launch.sh');
    expect(profile.reap).toContain('cloud-worker-reap.sh');
    // The whole point of the wrapper design: no `docker run` / `gcloud` invocation lives inline in
    // the profile JSON itself — all CLI ambiguity is absorbed inside the wrapper scripts.
    expect(profile.launch).not.toContain('docker run');
    expect(profile.launch).not.toMatch(/\bgcloud\b/);
  });

  it('both referenced wrapper scripts actually exist on disk', () => {
    expect(readFileSync(cloudLaunchScriptPath, 'utf8').length).toBeGreaterThan(0);
    expect(readFileSync(cloudReapScriptPath, 'utf8').length).toBeGreaterThan(0);
  });
});

describe('cloud-worker-launch.sh: exit-code contract (accepted design cf579f0f pt.1)', () => {
  const script = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('fires the execution with --wait but does NOT trust --wait/execute\'s own exit code for classification', () => {
    expect(script).toContain('gcloud run jobs execute');
    expect(script).toContain('--wait');
    // The exit code of the execute call is captured into a variable, never `exit $?` right after it.
    expect(script).toMatch(/EXECUTE_EXIT=\$\?/);
  });

  it('ALWAYS makes an authoritative post-wait describe call, regardless of the execute exit code', () => {
    expect(script).toContain('gcloud run jobs executions describe');
    // The describe call must not be gated behind a check of the execute exit code succeeding.
    const describeAt = script.indexOf('gcloud run jobs executions describe');
    const guard = script.slice(0, describeAt);
    expect(guard).not.toMatch(/if\s*\[\s*"\$EXECUTE_EXIT"\s*-eq\s*0\s*\]/);
  });

  it('parses status.succeededCount/failedCount/completionTime — the documented resource shape — not status.conditions', () => {
    expect(script).toContain('status.succeededCount');
    expect(script).toContain('status.failedCount');
    expect(script).toContain('status.completionTime');
    expect(script).not.toContain('status.conditions');
  });

  it('treats "neither succeeded nor failed yet" as dirty (exit 1), never as a guessed success', () => {
    // succeeded branch exits 0, everything else (including the still-reconciling fallthrough) is 1.
    const exitZeroCount = (script.match(/exit 0/g) ?? []).length;
    expect(exitZeroCount).toBe(1);
    expect(script).toMatch(/treating as dirty/);
  });

  it('carries the SMOKE-TEST GAP comment at the parsing site, verbatim marker', () => {
    expect(script).toContain('SMOKE-TEST GAP (accepted design cf579f0f pt.1)');
    expect(script).toContain('status.succeededCount/failedCount/completionTime');
  });
});

describe('cloud-worker-launch.sh + cloud-worker-reap.sh: label-based execute/reap (accepted design cf579f0f pt.2)', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');
  const reapScript = readFileSync(cloudReapScriptPath, 'utf8');

  it('launch labels the execution with conduction-id at execute time', () => {
    expect(launchScript).toMatch(/--labels="conduction-id=\$CONDUCTION_ID"/);
  });

  it('reap resolves the execution by that SAME conduction-id label — never a caller-assigned name', () => {
    expect(reapScript).toContain('executions list');
    expect(reapScript).toContain('metadata.labels.conduction-id=$CONDUCTION_ID');
  });

  it('reap cancels the resolved execution asynchronously and tolerates "not found" as a no-op', () => {
    expect(reapScript).toContain('executions cancel');
    expect(reapScript).toContain('--async');
    // Tolerance mirrors today's `docker rm -f` no-op-on-absent pattern: `|| true` at the call site.
    const cancelAt = reapScript.indexOf('executions cancel');
    const cancelStatement = reapScript.slice(cancelAt, reapScript.indexOf('\n\n', cancelAt) + 1);
    expect(cancelStatement).toContain('|| true');
  });

  it('carries the CONFIRM AT VERIFY cancel-unblocks-wait comment at the cancel call site', () => {
    expect(reapScript).toContain('CONFIRM AT VERIFY (accepted design cf579f0f pt.2)');
    expect(reapScript).toMatch(/does a pending `execute --wait` actually/);
  });
});

describe('cloud-worker-launch.sh + cloud-worker-reap.sh: per-run env-file + credential handling (accepted design cf579f0f pt.3)', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');
  const reapScript = readFileSync(cloudReapScriptPath, 'utf8');

  it('mints the per-run env-file via the UNCHANGED mint script, WITHOUT --base (no static secrets file to merge)', () => {
    expect(launchScript).toContain('mint-installation-token.mjs');
    expect(launchScript).toContain('--out "$ENV_FILE"');
    expect(launchScript).not.toMatch(/mint-installation-token\.mjs[^\n]*--base/);
  });

  it('namespaces the minted env-file by BOTH {ticket} and {conduction_id} (same discipline as the docker profile)', () => {
    expect(launchScript).toContain('$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID');
  });

  it('reap deletes the SAME per-run minted env-file the launch wrapper wrote', () => {
    expect(reapScript).toContain('rm -f "$ENV_FILE"');
    expect(reapScript).toContain('$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID');
    expect(reapScript).toContain('/run.env');
    expect(launchScript).toContain('/run.env');
  });

  it('passes per-execution values via a FILE-based env-vars input, never inline on the gcloud command line', () => {
    expect(launchScript).toContain('--update-env-vars-file="$EXEC_ENV_FILE"');
    // No inline KEY=VALUE form anywhere near the execute call.
    expect(launchScript).not.toMatch(/--update-env-vars=/);
  });

  it('the exec-env-vars file is deleted immediately after the execute call, not deferred to reap', () => {
    const executeAt = launchScript.indexOf('gcloud run jobs execute');
    const afterExecute = launchScript.slice(executeAt);
    expect(afterExecute).toMatch(/rm -f "\$EXEC_ENV_FILE"/);
  });

  it('never puts GIT_TOKEN inline on the gcloud execute command line itself', () => {
    const executeAt = launchScript.indexOf('gcloud run jobs execute');
    const flagBlockEnd = launchScript.indexOf('EXECUTE_EXIT=$?', executeAt);
    const executeInvocation = launchScript.slice(executeAt, flagBlockEnd);
    expect(executeInvocation).not.toMatch(/GIT_TOKEN=/);
    expect(executeInvocation).not.toMatch(/-e\s+GIT_TOKEN/);
    expect(executeInvocation).not.toMatch(/--env\s+GIT_TOKEN/);
  });

  it('isolates the env-vars-file construction in its own function, with the CONFIRM AT VERIFY flag-name gap flagged there', () => {
    expect(launchScript).toMatch(/write_exec_env_file\s*\(\)\s*\{/);
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toContain('CONFIRM AT VERIFY (accepted design cf579f0f pt.3)');
    expect(fnBody).toMatch(/exact gcloud flag\/format for a FILE-based/);
  });

  it('the mint script the cloud template invokes actually exists and is the same shared script', () => {
    expect(readFileSync(mintScriptPath, 'utf8')).toContain('export function composeEnvFile');
  });
});

describe('cloud-worker-launch.sh: B-717 named constraint at the --update-env-vars mutation site', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('carries the B-717 comment immediately at the --update-env-vars-file call site', () => {
    const flagAt = launchScript.indexOf('--update-env-vars-file=');
    expect(flagAt).toBeGreaterThan(0);
    const nearby = launchScript.slice(flagAt, flagAt + 1200);
    expect(nearby).toContain('B-717 (accepted design cf579f0f pt.3, round-2 feedback)');
    expect(nearby).toContain('mutates the Cloud Run');
    expect(nearby).toMatch(/JOB DEFINITION itself/);
    expect(nearby).toMatch(/strictly serial today/);
  });
});

describe('cloud-worker scripts: config-not-constants (B-711) — no hardcoded live GCP identity', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');
  const reapScript = readFileSync(cloudReapScriptPath, 'utf8');

  it('project/account/region/job are all overridable env vars with := defaults, on both scripts', () => {
    for (const script of [launchScript, reapScript]) {
      expect(script).toMatch(/CLOUDSDK_CORE_PROJECT:=/);
      expect(script).toMatch(/CLOUDSDK_CORE_ACCOUNT:=/);
      expect(script).toMatch(/HARMONY_CLOUD_RUN_REGION:=/);
      expect(script).toMatch(/HARMONY_CLOUD_RUN_JOB:=/);
    }
  });

  it('the example defaults match the already-completed founder GCP setup (accepted design pt.7)', () => {
    expect(launchScript).toContain('harmony-conductor');
    expect(launchScript).toContain('harmony-daemon@harmony-conductor.iam.gserviceaccount.com');
    expect(launchScript).toContain('us-central1');
  });
});
