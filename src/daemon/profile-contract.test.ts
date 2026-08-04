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
    const executeExitAt = launchScript.indexOf('EXECUTE_EXIT=$?', executeAt);
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
    const executeExitAt = launchScript.indexOf('EXECUTE_EXIT=$?');
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
    const flagBlockEnd = launchScript.indexOf('EXECUTE_EXIT=$?', executeAt);
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

  it("conditionally forwards HARMONY_ACK_PLUGIN_AHEAD_OF_PROD from the wrapper's own environment (B-726 followup: cloud ack channel)", () => {
    // `update --env-vars-file` REPLACES the job's entire literal env set (documented at length
    // around this function), so the ack flag has no other channel to reach the cloud container's
    // provision.sh ref/target fidelity check (the guard B-726 itself added). It must be written
    // ONLY when the wrapper's own environment actually carries it — never unconditionally, so a
    // cloud launch with no ack set still fails closed exactly as provision.sh intends.
    const fnAt = launchScript.indexOf('write_exec_env_file() {');
    const fnBody = launchScript.slice(fnAt, launchScript.indexOf('\n}', fnAt));
    expect(fnBody).toContain('HARMONY_ACK_PLUGIN_AHEAD_OF_PROD');
    expect(fnBody).toMatch(/if \[ -n "\$\{HARMONY_ACK_PLUGIN_AHEAD_OF_PROD:-\}" \]; then/);
    const guardMatch = /if \[ -n "\$\{HARMONY_ACK_PLUGIN_AHEAD_OF_PROD:-\}" \]; then([\s\S]*?)\n\s*fi/.exec(
      fnBody,
    );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![1]).toMatch(
      /printf 'HARMONY_ACK_PLUGIN_AHEAD_OF_PROD: "%s"\\n' "\$HARMONY_ACK_PLUGIN_AHEAD_OF_PROD"/,
    );
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

describe('cloud-worker-launch.sh: B-717 named constraint at the update/execute mutation call sites', () => {
  const launchScript = readFileSync(cloudLaunchScriptPath, 'utf8');

  it('carries the B-717 comment immediately at the `update --env-vars-file` call site', () => {
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(updateMatch).not.toBeNull();
    const updateAt = updateMatch!.index;
    const nearby = launchScript.slice(Math.max(0, updateAt - 1600), updateAt + 200);
    expect(nearby).toContain('B-717 (accepted design cf579f0f pt.3, round-2 feedback');
    expect(nearby).toContain('mutates (replaces) the Cloud Run');
    expect(nearby).toMatch(/JOB DEFINITION itself/);
    expect(nearby).toMatch(/strictly serial today/);
    expect(nearby).toMatch(/STRENGTHENED round 3/);
  });

  it('carries the B-717 comment (or a copy) immediately at the `execute` call site too, describing the two-call sequence', () => {
    const executeMatch = /^gcloud run jobs execute "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(executeMatch).not.toBeNull();
    const executeAt = executeMatch!.index;
    const nearby = launchScript.slice(Math.max(0, executeAt - 1400), executeAt);
    expect(nearby).toContain('B-717 (accepted design cf579f0f pt.3, round-2 feedback');
    expect(nearby).toMatch(/STRENGTHENED round 3/);
    expect(nearby).toMatch(/second of the two non-atomic calls/);
  });

  it('the B-717 comment documents that update-then-execute is now TWO non-atomic calls, strengthening (not relaxing) the constraint', () => {
    const updateMatch = /^gcloud run jobs update "\$HARMONY_CLOUD_RUN_JOB"/m.exec(launchScript);
    expect(updateMatch).not.toBeNull();
    const updateAt = updateMatch!.index;
    const nearby = launchScript.slice(Math.max(0, updateAt - 1600), updateAt + 200);
    expect(nearby).toMatch(/TWO non-atomic gcloud calls/);
    expect(nearby).toMatch(/STRENGTHENS, not relaxes/);
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
    const executeExitAt = launchScript.indexOf('EXECUTE_EXIT=$?', executeAt);
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

  it("exports PLUGIN_REF so the exec'd provision.sh inherits it", () => {
    expect(script).toMatch(/^export PLUGIN_REF=/m);
  });

  it('hands off to provision.sh at its new nested location', () => {
    expect(script).toContain('exec /workspace/workspace/plugin/container/provision.sh "$@"');
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

// B-726 (d): ref/target fidelity — a headless worker must not run a plugin ref ahead of a `prod`
// board target unless the founder has explicitly ack'd that posture.

describe('provision.sh: ref/target fidelity fail-closed check (B-726 (d))', () => {
  const script = readFileSync(provisionPath, 'utf8');

  it('fails closed on prod target + non-prod PLUGIN_REF, scoped to headless mode only', () => {
    const shellAt = script.indexOf('shell)');
    const headlessAt = script.indexOf('headless)');
    expect(shellAt).toBeGreaterThan(0);
    expect(headlessAt).toBeGreaterThan(shellAt);
    const guardAt = script.indexOf('HARMONY_ACK_PLUGIN_AHEAD_OF_PROD', headlessAt);
    expect(guardAt).toBeGreaterThan(headlessAt);
    // The guard must not already appear inside the shell branch.
    const shellBranch = script.slice(shellAt, headlessAt);
    expect(shellBranch).not.toContain('HARMONY_ACK_PLUGIN_AHEAD_OF_PROD');
  });

  it('the fail-closed branch actually exits non-zero', () => {
    const guardMatch =
      /if \[ "\$ACTUAL_TARGET" = "prod" \] && \[ "\$PLUGIN_REF" != "prod" \] && \[ "\$\{HARMONY_ACK_PLUGIN_AHEAD_OF_PROD:-\}" != "1" \]; then([\s\S]*?)\n {4}fi/.exec(
        script,
      );
    expect(guardMatch).not.toBeNull();
    expect(guardMatch![1]).toMatch(/exit 1/);
  });

  it('echoes the ack unconditionally in the environment-confirm banner when active', () => {
    expect(script).toMatch(/echo\s+"Environment confirmed:[^"]*\$AHEAD_OF_PROD_ACK"/);
    expect(script).toContain('plugin_ref=$PLUGIN_REF');
  });
});
