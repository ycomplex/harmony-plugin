// B-696 cross-file drift guard: the shipped launch-profile template must speak the container
// ENTRYPOINT's mode contract. provision.sh dispatches on its FIRST argument (`shell | headless
// <prompt>`), so the token right after the image name in the launch template MUST be one of
// provision.sh's real modes — the original template passed `claude` there, which provision.sh
// rejects as an unknown mode. Both files are read from disk so either side drifting breaks CI.

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

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

/** B-761 reopen fix: the local-docker reap template now dispatches to this dedicated wrapper
 *  script rather than an inline `docker rm -f ...; rm -f ...` (the old `;`-joined inline template
 *  always exited 0, discarding docker's own "container not found" signal — see the script's own
 *  header). Declared here (rather than down by its own describe block) so the credential-contract
 *  test below can also reference it. */
const dockerReapScriptPath = fileURLToPath(
  new URL('../../container/docker-worker-reap.sh', import.meta.url),
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
    expect(envFile).toBeDefined();
    // B-761 reopen fix: the reap template now dispatches to a dedicated wrapper script rather than
    // an inline `rm -f` — confirm both that the profile points at the wrapper, and that the
    // wrapper's own body deletes the SAME per-run env-file the launch template minted (the
    // wrapper's $TICKET/$CONDUCTION_ID shell variables are the runtime form of the launch
    // template's {ticket}/{conduction_id} placeholders).
    expect(profile.reap).toContain('docker-worker-reap.sh');
    const dockerReapScript = readFileSync(dockerReapScriptPath, 'utf8');
    expect(dockerReapScript).toContain('rm -f "$ENV_FILE"');
    expect(dockerReapScript).toContain('$HOME/.harmony-conductions/$TICKET/$CONDUCTION_ID');
    expect(dockerReapScript).toContain('run.env');
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// B-761 reopen fix — docker-worker-reap.sh: EXECUTED miss-vs-kill exit-code contract.
//
// The old inline docker reap template (`docker rm -f ...; rm -f $ENV_FILE`) always exited 0
// because the trailing `rm -f` almost always succeeds — a genuinely-missing container's real
// `docker rm -f` exit code (1, with "No such container" on stderr) never surfaced. This wrapper
// re-derives a real three-way exit-code contract (0 = kill, 3 = routine miss, 1 = genuine
// unexpected error). Prose-pinned regex assertions against the script's TEXT alone are not trusted
// for this kind of exit-code-derivation logic (mirrors the write_exec_env_file() / release_lock()
// EXECUTED-test precedent above) — this block actually RUNS the real script against a stubbed
// `docker` on PATH and asserts the real process exit code.
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe('docker-worker-reap.sh: EXECUTED miss-vs-kill exit-code contract (B-761 reopen fix)', () => {
  /** Run the REAL docker-worker-reap.sh with a stubbed `docker` on PATH whose body is `dockerFakeBody`
   *  (a fake docker binary, so no real container runtime is required to run this test). Returns the
   *  real process's exit status + captured stderr — never throws on a nonzero exit. */
  function runDockerReap(dockerFakeBody: string): { status: number | null; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'b761-docker-reap-'));
    const fakeBinDir = join(dir, 'bin');
    mkdirSync(fakeBinDir);
    writeFileSync(join(fakeBinDir, 'docker'), `#!/usr/bin/env bash\n${dockerFakeBody}\n`, {
      mode: 0o700,
    });
    const homeDir = join(dir, 'home');
    mkdirSync(homeDir);

    try {
      execFileSync('bash', [dockerReapScriptPath, 'cond-test-1', 'B-761'], {
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, HOME: homeDir },
      });
      return { status: 0, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stderr: Buffer | string };
      return { status: e.status, stderr: e.stderr.toString() };
    }
  }

  it('exits 0 when docker itself exits 0 (a real container was found and removed — the kill case)', () => {
    const result = runDockerReap('exit 0');
    expect(result.status).toBe(0);
  });

  it('exits 3 when docker exits nonzero with "No such container" in its output (the routine miss)', () => {
    const result = runDockerReap(
      'echo "Error response from daemon: No such container: harmony-worker-cond-test-1" >&2\nexit 1',
    );
    expect(result.status).toBe(3);
  });

  it('exits 1 and prints the captured output to stderr on a genuine, unexpected docker error — NOT swallowed into 0 or 3', () => {
    const result = runDockerReap('echo "Cannot connect to the Docker daemon" >&2\nexit 1');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot connect to the Docker daemon');
  });
});

describe('B-717 restart reconciliation: both example profiles carry an optional probe template + maxConcurrentWorkers', () => {
  it('daemon-profile.example.json (local-docker) carries probe + maxConcurrentWorkers', () => {
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as {
      probe?: string;
      maxConcurrentWorkers?: number;
    };
    expect(profile.probe).toContain('{conduction_id}');
    expect(profile.probe).toContain('docker ps');
    expect(typeof profile.maxConcurrentWorkers).toBe('number');
    expect(profile.maxConcurrentWorkers).toBeGreaterThan(0);
  });

  it('daemon-profile.cloud.example.json carries probe + maxConcurrentWorkers, pointing at the dedicated probe wrapper', () => {
    const profile = JSON.parse(readFileSync(cloudProfilePath, 'utf8')) as {
      probe?: string;
      maxConcurrentWorkers?: number;
    };
    expect(profile.probe).toContain('cloud-worker-probe.sh');
    expect(profile.probe).toContain('{conduction_id}');
    expect(profile.probe).toContain('{ticket}');
    expect(typeof profile.maxConcurrentWorkers).toBe('number');
    expect(profile.maxConcurrentWorkers).toBeGreaterThan(0);
  });

  it('cloud-worker-probe.sh exists, exits 0 when an incomplete execution is found and non-zero otherwise, and never parses worker stdout', () => {
    const probeScriptPath = fileURLToPath(new URL('../../container/cloud-worker-probe.sh', import.meta.url));
    const script = readFileSync(probeScriptPath, 'utf8');
    expect(script.length).toBeGreaterThan(0);
    expect(script).toContain("metadata.labels.conduction-id=$CONDUCTION_ID AND status.completionTime=''");
    expect(script).toMatch(/exit 0 # found/);
    expect(script).toMatch(/exit 1 # not found/);
  });
});

describe('cloud-worker-launch.sh: exit-code contract (accepted design cf579f0f pt.1, B-717 lock-narrowing)', () => {
  const script = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('fires the execution WITHOUT --wait (B-717 plan-gate correction 1) and does NOT trust the submit exit code for classification', () => {
    expect(script).toContain('gcloud run jobs execute');
    // --wait is gone from the execute call itself — search only that invocation's flag block.
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(script);
    expect(executeMatch).not.toBeNull();
    const executeAt = executeMatch!.index;
    const submitExitAt = script.indexOf('EXECUTE_SUBMIT_EXIT=$?', executeAt);
    expect(submitExitAt).toBeGreaterThan(executeAt);
    const executeInvocation = script.slice(executeAt, submitExitAt);
    expect(executeInvocation).not.toMatch(/--wait\b/);
    // The submit exit code is captured into a variable, never `exit $?` right after it.
    expect(script).toMatch(/EXECUTE_SUBMIT_EXIT=\$\?/);
  });

  it('ALWAYS makes an authoritative describe call (via the post-lock poll loop), regardless of the execute submit exit code', () => {
    expect(script).toContain('gcloud run jobs executions describe');
    // The describe calls must not be gated behind a check of the submit exit code succeeding.
    const firstDescribeAt = script.indexOf('gcloud run jobs executions describe');
    const guard = script.slice(0, firstDescribeAt);
    expect(guard).not.toMatch(/if\s*\[\s*"\$EXECUTE_SUBMIT_EXIT"\s*-eq\s*0\s*\]/);
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

  it('parses the describe result via null-safe --format=json + jq, never the field-shifting --format=value(...) form (B-754-element fix, 2026-08-04)', () => {
    // `--format=value(...)` prints tab/space-separated columns and silently drops a null/absent
    // column instead of an empty field, so `read` shifts the remaining fields left — a FAILED
    // execution (succeededCount null, failedCount=1) would parse as SUCCEEDED=1. Pin the fix: the
    // describe call for SUCCEEDED/FAILED/COMPLETION must use --format=json piped into jq, and must
    // NOT use the value(...) form for this parse.
    const describeAt = script.indexOf('gcloud run jobs executions describe');
    const readEnd = script.indexOf(')', script.indexOf('read -r SUCCEEDED FAILED COMPLETION'));
    const describeBlock = script.slice(describeAt, readEnd);
    expect(describeBlock).not.toMatch(/--format='value\(status\.succeededCount/);
    expect(describeBlock).toContain('--format=json');
    expect(describeBlock).toMatch(/\|\s*jq -r/);
    expect(describeBlock).toMatch(/\.status\.succeededCount \/\/ 0/);
    expect(describeBlock).toMatch(/\.status\.failedCount \/\/ 0/);
    expect(describeBlock).toMatch(/\.status\.completionTime \/\/ ""/);
  });

  it('carries the SMOKE-TEST GAP comment at the parsing site, verbatim marker', () => {
    expect(script).toContain('SMOKE-TEST GAP (accepted design cf579f0f pt.1)');
    expect(script).toContain('status.succeededCount/failedCount/completionTime');
  });

  it('the SMOKE-TEST GAP comment is marked CONFIRMED via live observation, not left hedged', () => {
    expect(script).toContain('CONFIRMED via live observation (2026-08-03)');
    expect(script).not.toContain('status.conditions');
  });
});

describe('cloud-worker-launch.sh + cloud-worker-reap.sh: label-based execute/reap (accepted design cf579f0f pt.2)', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');
  const reapScript = readFileSync(cloudReapScriptPath, 'utf8');

  it('launch labels the JOB DEFINITION with conduction-id via `update --update-labels` (B-754 reopened: `execute` has no `--labels` flag)', () => {
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(updateMatch).not.toBeNull();
    const updateAt = updateMatch!.index;
    const updateEnd = launchScript.indexOf('\n\n', updateAt);
    const updateInvocation = launchScript.slice(updateAt, updateEnd);
    expect(updateInvocation).toMatch(/--update-labels="conduction-id=\$CONDUCTION_ID"/);
  });

  it('never puts a `--labels` flag on the `execute` call — `gcloud run jobs execute` has no such flag (confirmed live, B-754 reopened)', () => {
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(executeMatch).not.toBeNull();
    const executeAt = executeMatch!.index;
    const executeExitAt = launchScript.indexOf('EXECUTE_SUBMIT_EXIT=$?', executeAt);
    const executeInvocation = launchScript.slice(executeAt, executeExitAt);
    expect(executeInvocation).not.toMatch(/--labels=/);
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

  it('the cancel-unblocks-wait comment is marked CONFIRMED via live observation, not left hedged', () => {
    expect(reapScript).toContain('CONFIRMED (2026-08-03)');
    expect(reapScript).toMatch(/unblocked a pending `execute --wait`/);
  });
});

describe('cloud-worker-launch.sh + cloud-worker-reap.sh: per-run env-file + credential handling (accepted design cf579f0f pt.3)', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');
  const reapScript = readFileSync(cloudReapScriptPath, 'utf8');

  it('mints the per-run env-file WITH --base "$HOME/.harmony-container.env" (B-726 followup, 2026-08-04 live probe: the prior no-base form was the root cause of the ack flag never reaching the cloud container)', () => {
    expect(launchScript).toContain('mint-installation-token.mjs');
    expect(launchScript).toContain('--out "$ENV_FILE"');
    // Matches the local docker profile's launch template exactly (daemon-profile.example.json's
    // `launch` field mints WITH --base $HOME/.harmony-container.env) — the --base flag must appear
    // on the mint invocation, immediately before --out.
    expect(launchScript).toMatch(
      /mint-installation-token\.mjs" --base "\$HOME\/\.harmony-container\.env" --out "\$ENV_FILE"/,
    );
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

  it('passes GIT_TOKEN via the `update --env-vars-file` call, never via a nonexistent `execute --update-env-vars-file` flag', () => {
    expect(launchScript).toContain('gcloud run jobs update');
    expect(launchScript).toContain('--env-vars-file="$EXEC_ENV_FILE"');
    // CONFIRMED via a live `gcloud run jobs execute --help` check (2026-08-03): `execute` has no
    // file-based env-vars flag at all, so the (nonexistent) flag USAGE must never appear anywhere in
    // the script — the flag NAME may still appear in prose explaining why it was dropped.
    expect(launchScript).not.toContain('--update-env-vars-file=');
    // No inline KEY=VALUE form anywhere in the script either.
    expect(launchScript).not.toMatch(/--update-env-vars=/);
  });

  it('issues the `update` call and then the `execute` call as two sequential gcloud invocations, in that order, before wait-classification logic runs', () => {
    // Match the REAL invocations (start of line, no leading `#`), not prose mentions of the same
    // words inside comments.
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(updateMatch).not.toBeNull();
    expect(executeMatch).not.toBeNull();
    const updateAt = updateMatch!.index;
    const executeAt = executeMatch!.index;
    const executeExitAt = launchScript.indexOf('EXECUTE_SUBMIT_EXIT=$?');
    const describeAt = launchScript.indexOf('gcloud run jobs executions describe');

    expect(updateAt).toBeGreaterThan(0);
    expect(executeAt).toBeGreaterThan(updateAt); // update strictly before execute
    expect(executeExitAt).toBeGreaterThan(executeAt);
    expect(describeAt).toBeGreaterThan(executeExitAt); // wait-classification logic runs after both

    // The `execute` call itself carries no env-vars flag anymore — the env now rides the job
    // definition the `update` call above just set.
    const executeInvocation = launchScript.slice(executeAt, executeExitAt);
    expect(executeInvocation).not.toMatch(/--env-vars-file/);
    expect(executeInvocation).not.toMatch(/--update-env-vars/);
  });

  it('the exec-env-vars file is deleted immediately after the execute call, not deferred to reap', () => {
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(executeMatch).not.toBeNull();
    const afterExecute = launchScript.slice(executeMatch!.index);
    expect(afterExecute).toMatch(/rm -f "\$EXEC_ENV_FILE"/);
  });

  it('never puts GIT_TOKEN inline on either the `update` or `execute` gcloud command lines', () => {
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(updateMatch).not.toBeNull();
    const updateAt = updateMatch!.index;
    const updateEnd = launchScript.indexOf('\n\n', updateAt);
    const updateInvocation = launchScript.slice(updateAt, updateEnd);
    expect(updateInvocation).not.toMatch(/GIT_TOKEN=/);
    expect(updateInvocation).not.toMatch(/-e\s+GIT_TOKEN/);
    expect(updateInvocation).not.toMatch(/--env\s+GIT_TOKEN/);

    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(executeMatch).not.toBeNull();
    const executeAt = executeMatch!.index;
    const flagBlockEnd = launchScript.indexOf('EXECUTE_SUBMIT_EXIT=$?', executeAt);
    const executeInvocation = launchScript.slice(executeAt, flagBlockEnd);
    expect(executeInvocation).not.toMatch(/GIT_TOKEN=/);
    expect(executeInvocation).not.toMatch(/-e\s+GIT_TOKEN/);
    expect(executeInvocation).not.toMatch(/--env\s+GIT_TOKEN/);
  });

  it('isolates the env-vars-file construction in its own function, with the flag/format gap now CONFIRMED resolved there', () => {
    expect(launchScript).toMatch(/write_exec_env_file\s*\(\)\s*\{/);
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toContain('CONFIRMED (2026-08-03, live `gcloud run jobs execute --help` check)');
    expect(fnBody).toMatch(/has NO file-based env-vars flag at all/);
    // The flag that does not exist must never appear as an actual USAGE (trailing `=`) — mentioning
    // its bare name in prose, to explain why it was dropped, is fine and expected.
    expect(fnBody).not.toContain('--update-env-vars-file=');
  });

  it("conditionally forwards HARMONY_PLUGIN_POSTURE, sourced from the minted env-file rather than the wrapper's own invoking environment (B-726 followup mechanism, re-keyed onto the single posture var by B-803)", () => {
    // `update --env-vars-file` REPLACES the job's entire literal env set (documented at length
    // around this function), so the posture var has no other channel to reach the cloud
    // container's provision.sh ref/target fidelity check (the guard B-726 itself added, now
    // re-keyed by B-803 onto HARMONY_PLUGIN_POSTURE). It must be written ONLY when the wrapper's
    // own environment actually carries it — never unconditionally, so a cloud launch with no
    // posture set still fails closed exactly as provision.sh intends (defaults to "main",
    // unacknowledged).
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toContain('HARMONY_PLUGIN_POSTURE');
    expect(fnBody).toMatch(/if \[ -n "\$\{HARMONY_PLUGIN_POSTURE:-\}" \]; then/);
    const guardMatch = /if \[ -n "\$\{HARMONY_PLUGIN_POSTURE:-\}" \]; then([\s\S]*?)\n\s*fi/.exec(
      fnBody,
    );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![1]).toMatch(
      /printf 'HARMONY_PLUGIN_POSTURE: "%s"\\n' "\$HARMONY_PLUGIN_POSTURE"/,
    );
  });

  it('acquires HARMONY_PLUGIN_POSTURE from the SAME minted $ENV_FILE as GIT_TOKEN, via grep + cut, with no non-empty check (unlike GIT_TOKEN — an unset posture must still fail closed downstream)', () => {
    const gitTokenAt = launchScript.indexOf('GIT_TOKEN="$(grep -m1');
    expect(gitTokenAt).toBeGreaterThanOrEqual(0);
    const postureAt = launchScript.indexOf('HARMONY_PLUGIN_POSTURE="$(grep -m1');
    expect(postureAt).toBeGreaterThanOrEqual(0);
    // The posture acquisition must come from the launch script (step 1), strictly AFTER the
    // GIT_TOKEN acquisition + its non-empty check, and strictly BEFORE write_exec_env_file() is
    // defined — i.e. it is a step-1 local shell variable, not something write_exec_env_file()
    // itself derives.
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    expect(postureAt).toBeGreaterThan(gitTokenAt);
    expect(postureAt).toBeLessThan(fnAt);

    const postureLineEnd = launchScript.indexOf('\n', postureAt);
    const postureLine = launchScript.slice(postureAt, postureLineEnd);
    expect(postureLine).toContain("grep -m1 '^HARMONY_PLUGIN_POSTURE=' \"$ENV_FILE\"");
    expect(postureLine).toContain('cut -d= -f2-');
    // Deliberately no `-z`/non-empty guard on this line (contrast with GIT_TOKEN's immediately
    // preceding `if [ -z "$GIT_TOKEN" ]; then ... exit 1; fi`).
    expect(postureLine).not.toMatch(/-z "\$HARMONY_PLUGIN_POSTURE"/);
  });

  describe('EXECUTED write_exec_env_file() behavior (B-726 followup mechanism, B-803 posture var — prose-pinned contract tests alone are not trusted for this wrapper)', () => {
    // Three consecutive cloud-path defects in this wrapper (the env-file subset gap, the
    // describe-result field-shift, and a missing --base) each passed prose-pinned contract
    // tests (regex assertions against the script's TEXT) and were only caught live. This block
    // actually EXECUTES the real acquisition lines + write_exec_env_file() body, extracted
    // VERBATIM from the live script text (never hand-retyped), so drift in the script's real
    // logic breaks this test too, not just its prose.

    /** Extract the single line in `script` that begins with `marker`, verbatim. */
    function extractLine(script: string, marker: string): string {
      const at = script.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      const end = script.indexOf('\n', at);
      expect(end).toBeGreaterThan(at);
      return script.slice(at, end);
    }

    /** Extract the full `write_exec_env_file() { ... }` function definition, closing brace included. */
    function extractFunctionBody(script: string): string {
      const fnAt = script.indexOf('write_exec_env_file() {');
      expect(fnAt).toBeGreaterThanOrEqual(0);
      const closeAt = script.indexOf('\n}', fnAt);
      expect(closeAt).toBeGreaterThan(fnAt);
      return script.slice(fnAt, closeAt + 2); // include the closing "\n}"
    }

    function runWriteExecEnvFile(fixtureEnvContent: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'b803-write-exec-env-'));
      const envFile = join(dir, 'run.env');
      const outFile = join(dir, 'exec-env-vars.yaml');
      const scriptFile = join(dir, 'harness.sh');

      writeFileSync(envFile, fixtureEnvContent);

      const gitTokenAcquisition = extractLine(launchScript, 'GIT_TOKEN="$(grep -m1');
      const postureAcquisition = extractLine(
        launchScript,
        'HARMONY_PLUGIN_POSTURE="$(grep -m1',
      );
      const fnBody = extractFunctionBody(launchScript);

      const harness = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'CONDUCTION_ID="cond-test-1"',
        'TICKET="B-803"',
        `ENV_FILE="${envFile}"`,
        gitTokenAcquisition,
        postureAcquisition,
        fnBody,
        `write_exec_env_file "${outFile}"`,
        '',
      ].join('\n');

      writeFileSync(scriptFile, harness, { mode: 0o700 });
      execFileSync('bash', [scriptFile]);

      return readFileSync(outFile, 'utf8');
    }

    it('produces HARMONY_PLUGIN_POSTURE: "ack:main" in the output YAML when the fixture minted env-file carries the posture', () => {
      const output = runWriteExecEnvFile(
        ['GIT_TOKEN=ghs_dummytoken', 'HARMONY_PLUGIN_POSTURE=ack:main', ''].join('\n'),
      );
      expect(output).toContain('CONDUCTION_ID: "cond-test-1"');
      expect(output).toContain('TICKET: "B-803"');
      expect(output).toContain('GIT_TOKEN: "ghs_dummytoken"');
      expect(output).toContain('HARMONY_PLUGIN_POSTURE: "ack:main"');
    });

    it('omits the HARMONY_PLUGIN_POSTURE line entirely when the fixture minted env-file does not carry it', () => {
      const output = runWriteExecEnvFile(['GIT_TOKEN=ghs_dummytoken', ''].join('\n'));
      expect(output).toContain('CONDUCTION_ID: "cond-test-1"');
      expect(output).toContain('TICKET: "B-803"');
      expect(output).toContain('GIT_TOKEN: "ghs_dummytoken"');
      expect(output).not.toContain('HARMONY_PLUGIN_POSTURE');
    });
  });

  it('the mint script the cloud template invokes actually exists and is the same shared script', () => {
    expect(readFileSync(mintScriptPath, 'utf8')).toContain('export function composeEnvFile');
  });

  it('documents the inline --update-env-vars merge-override without adopting it for GIT_TOKEN, and softens the token-out-of-spec claim', () => {
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    // Flatten wrapped comment lines (strip the leading `# `/`  # ` continuation) so prose assertions
    // aren't brittle to exactly where a sentence happens to wrap.
    const flat = fnBody.replace(/\n\s*#\s?/g, ' ');
    expect(flat).toMatch(/inline `--update-env-vars` merge-override/);
    expect(flat).toMatch(/merge-override/);
    // Honesty fix (live smoke probe, 2026-08-03): the token lands in the spec either way — the
    // file-based route's benefit is keeping it off argv/process list, not off the spec.
    expect(flat).toMatch(/lands in the job\/execution spec metadata either way/);
    expect(flat).toMatch(/argv\/process list/);
    // still file-based for GIT_TOKEN — the security contract this describe block enforces
    expect(launchScript).toContain('--env-vars-file="$EXEC_ENV_FILE"');
    expect(launchScript).not.toContain('--update-env-vars-file=');
  });
});

describe('cloud-worker-launch.sh: B-717 item 6 — the mkdir lock RESOLVES the update/execute race', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('acquires the lock BEFORE `update` and releases it right after the execution is resolved — not after the build completes', () => {
    const acquireAt = launchScript.indexOf('acquire_lock\n');
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    const resolveCallAt = launchScript.indexOf('EXECUTION_NAME="$(resolve_execution_name');
    const releaseCallAt = launchScript.indexOf('release_lock\n', resolveCallAt);
    const pollLoopAt = launchScript.indexOf('while :; do');

    expect(acquireAt).toBeGreaterThan(0);
    expect(updateMatch).not.toBeNull();
    expect(executeMatch).not.toBeNull();
    expect(resolveCallAt).toBeGreaterThan(0);
    expect(releaseCallAt).toBeGreaterThan(0);
    expect(pollLoopAt).toBeGreaterThan(0);

    expect(updateMatch!.index).toBeGreaterThan(acquireAt); // lock held before update
    expect(executeMatch!.index).toBeGreaterThan(updateMatch!.index); // …and before execute
    expect(resolveCallAt).toBeGreaterThan(executeMatch!.index);
    expect(releaseCallAt).toBeGreaterThan(resolveCallAt); // released once the execution is resolved
    expect(pollLoopAt).toBeGreaterThan(releaseCallAt); // the multi-minute poll runs UNLOCKED
  });

  it('releases via an EXIT trap for crash-safety, in addition to the explicit release call', () => {
    expect(launchScript).toMatch(/trap release_lock EXIT/);
  });

  it('acquisition is a BOUNDED wait that fails loud (treated as dirty) on timeout — no new recovery logic added here', () => {
    const fnAt = launchScript.indexOf('acquire_lock() {');
    expect(fnAt).toBeGreaterThanOrEqual(0);
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toMatch(/LOCK_WAIT_TIMEOUT_S/);
    expect(fnBody).toMatch(/exit 1/);
    expect(fnBody).toMatch(/treating as a dirty exit/);
  });

  it('stamps the lock dir with the holder PID and breaks a stale lock from a dead process', () => {
    const fnAt = launchScript.indexOf('acquire_lock() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toContain('echo $$ > "$LOCK_DIR/pid"');
    expect(fnBody).toMatch(/kill -0 "\$holder_pid"/);
    expect(fnBody).toMatch(/breaking a stale launch lock/);
  });

  it('the lock directory is a SHARED, config-not-constants path (overridable), not per-conduction', () => {
    expect(launchScript).toMatch(/HARMONY_CLOUD_LAUNCH_LOCK_DIR:=/);
    // Not namespaced by {conduction_id}/$CONDUCTION_ID — it must serialize across ALL conductions.
    const lockDirLine = /LOCK_DIR="\$HARMONY_CLOUD_LAUNCH_LOCK_DIR"/.exec(launchScript);
    expect(lockDirLine).not.toBeNull();
  });

  it('never parses `execute`\'s own stdout for the execution name — resolves it via the existing conduction-id label lookup instead', () => {
    const fnAt = launchScript.indexOf('resolve_execution_name() {');
    expect(fnAt).toBeGreaterThanOrEqual(0);
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\nEXECUTION_NAME='));
    expect(fnBody).toContain('metadata.labels.conduction-id=$CONDUCTION_ID');
    expect(fnBody).toMatch(/sort-by="~metadata\.creationTimestamp"/); // takes the newest — B-713 retries reuse the label
    expect(fnBody).toMatch(/limit=1/);
  });

  // B-717 revising-building fix: release_lock() must be PID-ownership-guarded — a process that no
  // longer holds the lock (its own explicit release already fired, or it never held it) must not be
  // able to `rm -rf` a lock directory another process has since (re)acquired. A prose-pin grep on the
  // script text cannot catch this class (a previous reviewer note on this ticket, verbatim), so this
  // test EXECUTES the real acquire_lock/release_lock functions, extracted VERBATIM from the live
  // script text (never hand-retyped, same technique as the write_exec_env_file harness above).
  it('release_lock is PID-ownership-guarded: a non-holder release must not remove a lock another process (re)acquired', () => {
    function extractFunctionBody(marker: string): string {
      const fnAt = launchScript.indexOf(marker);
      expect(fnAt).toBeGreaterThanOrEqual(0);
      const closeAt = launchScript.indexOf('\n}', fnAt);
      expect(closeAt).toBeGreaterThan(fnAt);
      return launchScript.slice(fnAt, closeAt + 2);
    }

    const releaseLockFn = extractFunctionBody('release_lock() {');
    const acquireLockFn = extractFunctionBody('acquire_lock() {');

    const dir = mkdtempSync(join(tmpdir(), 'b717-lock-race-'));
    const lockDir = join(dir, 'launch.lock');
    const scriptFile = join(dir, 'harness.sh');
    const resultFile = join(dir, 'result');
    const decoyPid = '999999';

    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `LOCK_DIR="${lockDir}"`,
      'LOCK_WAIT_TIMEOUT_S=60',
      'LOCK_POLL_S=1',
      releaseLockFn,
      '',
      acquireLockFn,
      '',
      '# 1. Process A (this harness process, PID $$) acquires the lock.',
      'acquire_lock',
      '',
      '# 2. A explicitly releases right after its critical section — matches its own PID stamp.',
      'release_lock',
      'if [ -d "$LOCK_DIR" ]; then',
      `  echo "FAIL: A explicit release left the lock behind" > "${resultFile}"`,
      '  exit 0',
      'fi',
      '',
      '# 3. Process B legitimately acquires the now-free lock. Simulated: bash tests run in one',
      '#    process, so B is honestly faked by stamping the pid file with a PID that is NOT this',
      `#    harness's own $$ (decoy pid ${decoyPid}), the same way acquire_lock itself would stamp it.`,
      'mkdir "$LOCK_DIR"',
      `echo ${decoyPid} > "$LOCK_DIR/pid"`,
      '',
      "# 4. A's EXIT-trap-equivalent release fires again (same $$ as step 2, still not the decoy pid).",
      "#    An ownership-guarded release_lock must leave B's lock untouched.",
      'release_lock',
      '',
      `if [ -d "$LOCK_DIR" ] && [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" = "${decoyPid}" ]; then`,
      `  echo PASS > "${resultFile}"`,
      'else',
      `  echo "FAIL: a non-holder release_lock call removed B's lock" > "${resultFile}"`,
      'fi',
      '',
    ].join('\n');

    writeFileSync(scriptFile, harness, { mode: 0o700 });
    execFileSync('bash', [scriptFile]);

    expect(readFileSync(resultFile, 'utf8').trim()).toBe('PASS');
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

// B-754 fix (2026-08-03): the execution was firing with NO container args at all, so the container
// entrypoint fell into its no-arg "shell" default and exited 0 having done no work (a live-observed
// silent no-progress park). This describe block pins the `--args` fix at the `execute` call site.

describe('cloud-worker-launch.sh: --args carries the worker invocation (B-754 fix)', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('the `execute` call carries an --args= flag whose value invokes headless conduct with the ticket', () => {
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(executeMatch).not.toBeNull();
    const executeAt = executeMatch!.index;
    const executeExitAt = launchScript.indexOf('EXECUTE_SUBMIT_EXIT=$?', executeAt);
    const executeInvocation = launchScript.slice(executeAt, executeExitAt);

    const argsMatch = /--args="([^"]*)"/.exec(executeInvocation);
    expect(argsMatch).not.toBeNull();
    const argsValue = argsMatch![1];
    expect(argsValue).toContain('$TICKET');
    expect(argsValue).toContain('--one-shot');
  });
});

// B-754 fix (2026-08-03): container/provision.sh must fail loud, not silently exit 0 having done
// no work, when it receives NO mode argument AND stdin is not a TTY (the exact shape of a
// mis-provisioned Cloud Run execution before the --args fix above). An explicit `shell` argument,
// or an interactive TTY session with no argument (dogfooding), must still behave as before.

describe('provision.sh: fails loud on no-arg + non-TTY instead of silently defaulting to shell (B-754 fix)', () => {
  const provisionScript = readFileSync(provisionPath, 'utf8');

  it('guards the mode default with a zero-args + non-TTY check BEFORE `MODE="${1:-shell}"`', () => {
    const guardMatch = /\[\s*\$#\s*-eq\s*0\s*\]\s*&&\s*\[\s*!\s*-t\s*0\s*\]/.exec(provisionScript);
    expect(guardMatch).not.toBeNull();
    const guardAt = guardMatch!.index;
    const modeDefaultAt = provisionScript.indexOf('MODE="${1:-shell}"');
    expect(modeDefaultAt).toBeGreaterThan(guardAt);
  });

  it('exits non-zero on that guard clause, rather than always defaulting silently to shell', () => {
    const guardMatch = /\[\s*\$#\s*-eq\s*0\s*\]\s*&&\s*\[\s*!\s*-t\s*0\s*\]/.exec(provisionScript);
    expect(guardMatch).not.toBeNull();
    const guardAt = guardMatch!.index;
    const modeDefaultAt = provisionScript.indexOf('MODE="${1:-shell}"');
    const guardBlock = provisionScript.slice(guardAt, modeDefaultAt);
    expect(guardBlock).toMatch(/exit 1/);
  });
});

// ------------------------------------------------------------------------------------------------
// B-726: container layout mirror (a/a1) — entrypoint.sh clones the meta-repo FIRST, then web+plugin
// INSIDE it, so all three CLAUDE.md levels load exactly as an interactive session's file-ancestry
// discovery would. provision.sh's PLUGIN_DIR/WORKDIR follow suit.

const entrypointPath = fileURLToPath(new URL('../../container/entrypoint.sh', import.meta.url));

describe('entrypoint.sh: nested workspace-mirror clone layout (B-726 (a))', () => {
  const script = readFileSync(entrypointPath, 'utf8');

  it('clones harmony-workspace BEFORE web and plugin', () => {
    const workspaceAt = script.indexOf('clone "$WORKSPACE_REPO"');
    const webAt = script.indexOf('clone "$WEB_REPO"');
    const pluginAt = script.indexOf('clone "$PLUGIN_REPO"');
    expect(workspaceAt).toBeGreaterThan(0);
    expect(webAt).toBeGreaterThan(workspaceAt);
    expect(pluginAt).toBeGreaterThan(workspaceAt);
  });

  it('clones web and plugin INSIDE the workspace checkout, not as siblings', () => {
    expect(script).toMatch(/clone\s+"\$WEB_REPO"\s+"\$WEB_REF"\s+\/workspace\/workspace\/web/);
    expect(script).toMatch(/clone\s+"\$PLUGIN_REPO"\s+"\$PLUGIN_REF"\s+\/workspace\/workspace\/plugin/);
  });

  it('derives PLUGIN_REF from HARMONY_PLUGIN_POSTURE (B-803/B-814), stripping the ack: prefix via the shared plugin_ref_from_posture() helper, and exports it so the exec\'d provision.sh inherits it', () => {
    // B-814: this used to be two flat top-level lines; it is now the shared plugin_ref_from_posture()
    // helper (also used by the repos[] branch's is_plugin entry, see below) called from the fallback.
    expect(script).toMatch(/^plugin_ref_from_posture\(\) \{$/m);
    expect(script).toMatch(/local posture="\$\{HARMONY_PLUGIN_POSTURE:-main\}"/);
    expect(script).toMatch(/printf '%s' "\$\{posture#ack:\}"/);
    expect(script).toMatch(/^export PLUGIN_REF="\$\(plugin_ref_from_posture\)"$/m);
  });

  it('hands off to provision.sh at its new nested location', () => {
    expect(script).toContain('exec /workspace/workspace/plugin/container/provision.sh "$@"');
  });
});

// ------------------------------------------------------------------------------------------------
// B-814: a deployment declares its own `repos` list — entrypoint.sh iterates HARMONY_REPOS_JSON
// (base64-encoded JSON, see scripts/mint-installation-token.mjs / container/cloud-worker-launch.sh
// for why base64) instead of the fixed three-slot WEB_REPO/PLUGIN_REPO/WORKSPACE_REPO clone, when
// that var is set and non-empty. Absent it, AC3 requires byte-for-byte unchanged fallback behavior.
//
// These tests EXECUTE entrypoint.sh for real (bash + jq + base64, all present in the CI image and
// this dev environment) with a fake `git` on PATH that logs every invocation instead of touching the
// network, and with the two `exec .../provision.sh` hand-off lines replaced by an observable
// `echo EXEC_TARGET=...` marker — so the harness never actually execs a real provision.sh (which,
// for the fallback branch's hardcoded absolute /workspace/workspace path, could otherwise
// accidentally touch this very checkout depending on where it happens to be cloned).

/** entrypoint.sh with both `exec .../provision.sh "$@"` hand-offs replaced by an observable marker,
 *  and (for the AC3 fallback test only) the hardcoded `/workspace/workspace` prefix substituted for
 *  an isolated tmpdir so the harness never touches this checkout's own real directory tree. */
function buildRunnableEntrypoint(script: string, workspaceRoot?: string): string {
  let out = workspaceRoot ? script.split('/workspace/workspace').join(workspaceRoot) : script;
  out = out.replace(
    'exec "$PLUGIN_DIR/container/provision.sh" "$@"',
    // `; exit 0` is load-bearing (B-814 CI fix): unlike a real `exec`, this echo does NOT terminate
    // the process, so without an explicit exit the script would fall through past the enclosing `fi`
    // into the fallback three-slot clone below — which clones into the HARDCODED /workspace/workspace
    // path for these tests (no workspaceRoot substitution). That silently no-ops wherever a real
    // /workspace/workspace checkout already exists (e.g. this dev container) but fails hard on a
    // runner where it doesn't (mkdir -p under an unwritable /workspace — the CI-only failure this
    // comment fixes).
    'echo "EXEC_TARGET=$PLUGIN_DIR/container/provision.sh $*"; exit 0',
  );
  const fallbackTarget = `exec ${workspaceRoot ?? '/workspace/workspace'}/plugin/container/provision.sh "$@"`;
  expect(out).toContain(fallbackTarget); // fails loudly if the literal line ever drifts
  out = out.replace(fallbackTarget, 'echo "EXEC_TARGET=FALLBACK $*"; exit 0');
  return out;
}

interface EntrypointResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  gitCalls: string[];
}

function runEntrypoint(
  env: NodeJS.ProcessEnv,
  opts: { args?: string[]; workspaceRoot?: string } = {},
): EntrypointResult {
  const script = readFileSync(entrypointPath, 'utf8');
  const runnable = buildRunnableEntrypoint(script, opts.workspaceRoot);

  const dir = mkdtempSync(join(tmpdir(), 'b814-entrypoint-'));
  const scriptFile = join(dir, 'entrypoint-test.sh');
  writeFileSync(scriptFile, runnable, { mode: 0o700 });

  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const gitCallLog = join(dir, 'git-calls.log');
  writeFileSync(gitCallLog, '');
  writeFileSync(
    join(binDir, 'git'),
    [
      '#!/bin/sh',
      'echo "$*" >> "$GIT_CALL_LOG"',
      'if [ "$1" = "clone" ]; then',
      '  shift; shift; ref="$1"; shift; url="$1"; shift; dst="$1"',
      '  mkdir -p "$dst/.git"',
      'fi',
      '',
    ].join('\n'),
    { mode: 0o700 },
  );

  let stdout: string;
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync('bash', [scriptFile, ...(opts.args ?? ['shell'])], {
      env: { ...process.env, ...env, PATH: `${binDir}:${process.env.PATH}`, GIT_CALL_LOG: gitCallLog },
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number | null };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    exitCode = e.status ?? 1;
  }
  const gitCalls = readFileSync(gitCallLog, 'utf8').split('\n').filter(Boolean);
  return { stdout, stderr, exitCode, gitCalls };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

describe('entrypoint.sh: repos[] clone iteration (B-814)', () => {
  it('AC1: a SINGLE-entry repos list with is_plugin:true clones it and hands off to ITS OWN path — no source edit needed (e.g. Team Health)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b814-ac1-'));
    const pluginPath = join(dir, 'team-health');
    const repos = [{ url: 'https://github.com/example/team-health.git', path: pluginPath, is_plugin: true }];

    const result = runEntrypoint({
      GIT_TOKEN: 'dummy',
      HARMONY_PLUGIN_POSTURE: 'main',
      HARMONY_REPOS_JSON: b64(repos),
    });

    expect(result.exitCode).toBe(0);
    expect(result.gitCalls).toEqual([
      `clone --branch main https://github.com/example/team-health.git ${pluginPath}`,
    ]);
    expect(result.stdout).toContain(`EXEC_TARGET=${pluginPath}/container/provision.sh shell`);
  });

  it('clones the meta_repo_role entry FIRST, then every other entry at its own configured ref — EXCEPT the is_plugin entry, where HARMONY_PLUGIN_POSTURE always wins over that entry\'s own ref', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b814-meta-'));
    const workspacePath = join(dir, 'workspace');
    const webPath = join(dir, 'workspace', 'web');
    const pluginPath = join(dir, 'workspace', 'plugin');
    const repos = [
      { url: 'https://github.com/ycomplex/harmony-workspace.git', path: workspacePath, meta_repo_role: true },
      { url: 'https://github.com/ycomplex/harmony-web.git', path: webPath, ref: 'web-feature-branch' },
      { url: 'https://github.com/ycomplex/harmony-plugin.git', path: pluginPath, is_plugin: true, ref: 'should-be-ignored' },
    ];

    const result = runEntrypoint({
      GIT_TOKEN: 'dummy',
      HARMONY_PLUGIN_POSTURE: 'ack:my-feature-branch',
      HARMONY_REPOS_JSON: b64(repos),
    });

    expect(result.exitCode).toBe(0);
    expect(result.gitCalls).toEqual([
      `clone --branch main https://github.com/ycomplex/harmony-workspace.git ${workspacePath}`,
      `clone --branch web-feature-branch https://github.com/ycomplex/harmony-web.git ${webPath}`,
      `clone --branch my-feature-branch https://github.com/ycomplex/harmony-plugin.git ${pluginPath}`,
    ]);
    expect(result.stdout).toContain(`EXEC_TARGET=${pluginPath}/container/provision.sh shell`);
  });

  it('aborts with a clear message when HARMONY_REPOS_JSON decodes to an empty array', () => {
    const result = runEntrypoint({ GIT_TOKEN: 'dummy', HARMONY_REPOS_JSON: b64([]) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/did not decode to a non-empty JSON array/);
    expect(result.gitCalls).toEqual([]);
  });

  it('aborts with a clear message when HARMONY_REPOS_JSON is not valid base64/JSON', () => {
    const result = runEntrypoint({ GIT_TOKEN: 'dummy', HARMONY_REPOS_JSON: 'not-valid-base64-or-json!!!' });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/did not decode to a non-empty JSON array/);
  });

  it('aborts with a clear message when no entry sets is_plugin:true — provisioning is plugin code, there is no plugin-less route', () => {
    const repos = [{ url: 'https://github.com/x/y.git', path: '/tmp/does-not-matter' }];
    const result = runEntrypoint({ GIT_TOKEN: 'dummy', HARMONY_REPOS_JSON: b64(repos) });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no repos\[\] entry has is_plugin:true/);
    expect(result.gitCalls).toEqual([]);
  });

  it('a non-plugin entry with no ref defaults to "main", same as the fallback WEB_REF/WORKSPACE_REF default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b814-default-ref-'));
    const siblingPath = join(dir, 'sibling');
    const pluginPath = join(dir, 'plugin');
    const repos = [
      { url: 'https://github.com/x/sibling.git', path: siblingPath },
      { url: 'https://github.com/x/plugin.git', path: pluginPath, is_plugin: true },
    ];

    const result = runEntrypoint({
      GIT_TOKEN: 'dummy',
      HARMONY_PLUGIN_POSTURE: 'prod',
      HARMONY_REPOS_JSON: b64(repos),
    });

    expect(result.exitCode).toBe(0);
    expect(result.gitCalls).toEqual([
      `clone --branch main https://github.com/x/sibling.git ${siblingPath}`,
      `clone --branch prod https://github.com/x/plugin.git ${pluginPath}`,
    ]);
  });
});

describe('entrypoint.sh: AC3 — HARMONY_REPOS_JSON absent/empty falls back byte-for-byte to the three-slot clone', () => {
  it('clones WORKSPACE_REPO, then WEB_REPO, then PLUGIN_REPO at the same relative layout as before B-814, with no HARMONY_REPOS_JSON set at all', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b814-ac3-'));

    const result = runEntrypoint(
      { GIT_TOKEN: 'dummy', HARMONY_PLUGIN_POSTURE: 'ack:my-branch' },
      { workspaceRoot: dir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.gitCalls).toEqual([
      `clone --branch main https://github.com/ycomplex/harmony-workspace.git ${dir}`,
      `clone --branch main https://github.com/ycomplex/harmony-web.git ${dir}/web`,
      `clone --branch my-branch https://github.com/ycomplex/harmony-plugin.git ${dir}/plugin`,
    ]);
    expect(result.stdout).toContain('EXEC_TARGET=FALLBACK shell');
  });

  it('respects WEB_REPO/PLUGIN_REPO/WORKSPACE_REPO/WEB_REF/WORKSPACE_REF overrides exactly as before, when set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'b814-ac3-override-'));

    const result = runEntrypoint(
      {
        GIT_TOKEN: 'dummy',
        WEB_REPO: 'https://github.com/acme/web-fork.git',
        WEB_REF: 'v2',
        WORKSPACE_REPO: 'https://github.com/acme/workspace-fork.git',
        WORKSPACE_REF: 'v3',
        HARMONY_PLUGIN_POSTURE: 'prod',
      },
      { workspaceRoot: dir },
    );

    expect(result.exitCode).toBe(0);
    expect(result.gitCalls).toEqual([
      `clone --branch v3 https://github.com/acme/workspace-fork.git ${dir}`,
      `clone --branch v2 https://github.com/acme/web-fork.git ${dir}/web`,
      `clone --branch prod https://github.com/ycomplex/harmony-plugin.git ${dir}/plugin`,
    ]);
  });
});

describe('provision.sh: PLUGIN_DIR/WORKDIR follow the nested layout (B-726 (a))', () => {
  const script = readFileSync(provisionPath, 'utf8');

  it('PLUGIN_DIR points inside the workspace checkout', () => {
    expect(script).toContain('PLUGIN_DIR=/workspace/workspace/plugin');
  });

  it('WORKDIR defaults inside the workspace checkout', () => {
    expect(script).toContain('WORKDIR="${HARMONY_WORKDIR:-/workspace/workspace}"');
  });

  it('locally excludes .claude/ in the workspace clone without touching the committed .gitignore', () => {
    expect(script).toContain('.git/info/exclude');
    expect(script).toMatch(/echo\s+'\.claude\/'\s*>>/);
  });
});

// B-726 (d) / B-803: ref/target fidelity — a headless worker must not run a plugin ref ahead of a
// `prod` board target unless the founder has explicitly ack'd that posture, now expressed as ONE
// var (HARMONY_PLUGIN_POSTURE: prod | ack:<ref> | bare <ref>) instead of the old PLUGIN_REF +
// HARMONY_ACK_PLUGIN_AHEAD_OF_PROD pair.

describe('provision.sh: HARMONY_PLUGIN_POSTURE parsing + ref/target fidelity fail-closed check (B-726 (d), re-keyed onto ONE var by B-803)', () => {
  const script = readFileSync(provisionPath, 'utf8');

  it('parses HARMONY_PLUGIN_POSTURE into {ref, acked} ONCE, via a case statement on the ack: prefix', () => {
    expect(script).toContain('PLUGIN_POSTURE="${HARMONY_PLUGIN_POSTURE:-main}"');
    expect(script).toMatch(/case "\$PLUGIN_POSTURE" in/);
    expect(script).toMatch(/ack:\*\)/);
    expect(script).toMatch(/PLUGIN_REF="\$\{PLUGIN_POSTURE#ack:\}"/);
    expect(script).toMatch(/AHEAD_OF_PROD_ACKED=1/);
    expect(script).toMatch(/AHEAD_OF_PROD_ACKED=0/);
  });

  it('the old two-var pair no longer has a live USAGE (env read) — only prose may still mention the name for historical context', () => {
    expect(script).not.toMatch(/\$\{HARMONY_ACK_PLUGIN_AHEAD_OF_PROD:?-?\}/); // no live ${...} read anywhere
    expect(script).not.toMatch(/PLUGIN_REF="\$\{PLUGIN_REF:-main\}"/); // the old bare-env-read form
  });

  it('fails closed on prod target + non-prod PLUGIN_REF, scoped to headless mode only', () => {
    const shellAt = script.indexOf('shell)');
    const headlessAt = script.indexOf('headless)');
    expect(shellAt).toBeGreaterThan(0);
    expect(headlessAt).toBeGreaterThan(shellAt);
    const guardAt = script.indexOf('AHEAD_OF_PROD_ACKED', headlessAt);
    expect(guardAt).toBeGreaterThan(headlessAt);
    // The headless-scoped fail-closed guard must not already appear inside the shell branch (the
    // posture PARSING above is shared/unconditional — it's the ENFORCEMENT that is headless-only).
    const shellBranch = script.slice(shellAt, headlessAt);
    expect(shellBranch).not.toMatch(/if \[ "\$ACTUAL_TARGET" = "prod" \] && \[ "\$PLUGIN_REF" != "prod" \]/);
  });

  it('the fail-closed branch actually exits non-zero', () => {
    const guardMatch =
      /if \[ "\$ACTUAL_TARGET" = "prod" \] && \[ "\$PLUGIN_REF" != "prod" \] && \[ "\$AHEAD_OF_PROD_ACKED" != "1" \]; then([\s\S]*?)\n {4}fi/.exec(
        script,
      );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![1]).toMatch(/exit 1/);
  });

  it('echoes the ack unconditionally in the environment-confirm banner when active', () => {
    expect(script).toMatch(/echo\s+"Environment confirmed:[^"]*\$AHEAD_OF_PROD_ACK"/);
    expect(script).toContain('plugin_ref=$PLUGIN_REF');
  });

  it('the banner-active condition and the fail-closed guard key on the SAME derived AHEAD_OF_PROD_ACKED, not two separate env reads', () => {
    const bannerGuard =
      /if \[ "\$ACTUAL_TARGET" = "prod" \] && \[ "\$PLUGIN_REF" != "prod" \] && \[ "\$AHEAD_OF_PROD_ACKED" = "1" \]; then/;
    expect(script).toMatch(bannerGuard);
  });
});

describe('provision.sh: EXECUTED HARMONY_PLUGIN_POSTURE parsing (B-803 — prose-pinned regex alone is not trusted for parsing logic)', () => {
  const script = readFileSync(provisionPath, 'utf8');

  /** Extract the real parsing block (assignment through the closing `esac`), verbatim. */
  function extractParsingBlock(): string {
    const at = script.indexOf('PLUGIN_POSTURE="${HARMONY_PLUGIN_POSTURE:-main}"');
    expect(at).toBeGreaterThanOrEqual(0);
    const end = script.indexOf('esac', at);
    expect(end).toBeGreaterThan(at);
    return script.slice(at, end + 'esac'.length);
  }

  function runParse(postureEnv: string | undefined): { ref: string; acked: string } {
    const dir = mkdtempSync(join(tmpdir(), 'b803-posture-parse-'));
    const scriptFile = join(dir, 'harness.sh');
    const resultFile = join(dir, 'result');
    const block = extractParsingBlock();
    const harness = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      block,
      `printf '%s %s' "$PLUGIN_REF" "$AHEAD_OF_PROD_ACKED" > "${resultFile}"`,
      '',
    ].join('\n');
    writeFileSync(scriptFile, harness, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (postureEnv === undefined) {
      delete env.HARMONY_PLUGIN_POSTURE;
    } else {
      env.HARMONY_PLUGIN_POSTURE = postureEnv;
    }
    execFileSync('bash', [scriptFile], { env });
    const [ref, acked] = readFileSync(resultFile, 'utf8').split(' ');
    return { ref, acked };
  }

  it('"prod" resolves to ref=prod, unacknowledged', () => {
    expect(runParse('prod')).toEqual({ ref: 'prod', acked: '0' });
  });

  it('"ack:main" resolves to ref=main, acknowledged', () => {
    expect(runParse('ack:main')).toEqual({ ref: 'main', acked: '1' });
  });

  it('a bare "main" (no ack: prefix) resolves to ref=main, UNacknowledged', () => {
    expect(runParse('main')).toEqual({ ref: 'main', acked: '0' });
  });

  it('unset HARMONY_PLUGIN_POSTURE defaults to ref=main, unacknowledged (the daemon\'s historical default posture)', () => {
    expect(runParse(undefined)).toEqual({ ref: 'main', acked: '0' });
  });
});
