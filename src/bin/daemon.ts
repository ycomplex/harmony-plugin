#!/usr/bin/env node
// B-696: the conductor daemon entrypoint.
//
// Two ways to select the launch profile (B-800 — see src/daemon/config.ts for the full
// precedence rule; deployment-config route wins whenever it fully resolves, else falls back to
// the legacy route unchanged):
//
//     # (1) B-800, preferred: NAMED from a deployment config's `profiles` section. --config
//     #     mirrors the `harmony config get` CLI's own --config flag; HARMONY_DEPLOYMENT_CONFIG
//     #     works too (resolveDeploymentConfigPath's normal precedence), and --config omitted
//     #     defaults to ~/.harmony/deployment.json.
//     HARMONY_API_TOKEN=<token> node dist/bin/daemon.js --config <deployment.json> --profile <name>
//
//     # (2) legacy, unchanged: a standalone profile JSON file.
//     HARMONY_DAEMON_PROFILE=<profile.json> HARMONY_API_TOKEN=<token> node dist/bin/daemon.js
//
// Watches every active conduction's ticket row and fires a fresh one-shot `harmony-conduct` worker
// whenever the ball returns to the agent; classifies each worker exit purely from exit code +
// ticket row; parks-and-flags anything off the happy path. The loop itself is the pure DI'd core
// in src/daemon/scheduler.ts — this file only wires the REAL deps.
//
// Pinning (mirrors src/bin/poll.ts, B-532 AC2): auth + project are captured ONCE at launch
// directly from HARMONY_API_TOKEN. We deliberately do NOT use getAuthenticatedContext() — it reads
// ~/.harmony/config.json's active-project pointer and mutates process.env, so a mid-run `harmony`
// project switch would repoint the daemon. HarmonyAuth from the token + one getProjectId() read
// makes the daemon immune.
//
// Credentials (two-envelope rule, B-694): this process's env carries ONLY HARMONY_API_TOKEN
// (ticket reads + conduction writes). Worker credentials (git, CLAUDE_CODE_OAUTH_TOKEN) live only
// in the launch profile's --env-file and never enter the daemon.
//
// Supervision: launchd (container/launchd/com.ycomplex.harmony-daemon.plist) owns restart —
// SIGTERM/SIGINT stamp a clean-shutdown marker on every row this instance holds (B-761 — lets a
// same-host successor adopt them immediately instead of waiting out the full stale window), log,
// and exit 0.

import { appendFileSync, readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';

import { HarmonyAuth } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getTask } from '../tools/tasks.js';
import { getProject } from '../tools/project.js';
import { listSubtasks } from '../tools/decomposition.js';
import {
  listConductions,
  takeoverConduction,
  stealConduction,
  updateConduction,
  updateConductionIfHeld,
  markCleanShutdown,
} from '../tools/conduction-record.js';
import { createHeartbeatKeeper } from '../daemon/heartbeat.js';
import { loadDaemonConfig, selectNamedProfile } from '../daemon/config.js';
import { renderQuietReapOutcome } from '../daemon/quiet-reap.js';
import { loadDeploymentConfig, resolveDeploymentConfigPath } from '../config/deployment-config.js';
import {
  PersistentAuthFailure,
  PersistentReapFailure,
  runScheduler,
  type DaemonTask,
  type SchedulerDeps,
} from '../daemon/scheduler.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** B-800: minimal argv parsing for the two flags this entrypoint adds — `--config <path>` (mirrors
 *  the `harmony config get` CLI's own flag, src/cli/commands/config.ts) and `--profile <name>`.
 *  Both optional; omitting `--profile` skips the deployment-config route entirely (falls straight
 *  through to the legacy HARMONY_DAEMON_PROFILE route in src/daemon/config.ts). No external argv
 *  parser — this entrypoint has exactly two flags and commander is not otherwise a daemon dep. */
function parseDaemonArgs(argv: string[]): { config?: string; profile?: string } {
  const args: { config?: string; profile?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config') args.config = argv[++i];
    else if (argv[i] === '--profile') args.profile = argv[++i];
  }
  return args;
}

/** B-761: bound the clean-shutdown marker write so a hung write can never block the deliberate
 *  exit below it — best-effort, logs on EVERY outcome (success, timeout, or operational error;
 *  never throws). REOPEN FIX: the success path used to log nothing at all — only the timeout and
 *  error paths did — so a routine, successful clean-shutdown marker write was invisible in the log;
 *  it now logs one line stating how many held rows got the marker. */
async function markCleanShutdownBounded(
  client: Awaited<ReturnType<typeof createAuthenticatedClient>>,
  holder: string,
  logFn: (line: string) => void,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([
      markCleanShutdown(client, holder).then((count) => ({ done: true as const, count })),
      timeout,
    ]);
    if (outcome === 'timeout') {
      logFn('clean-shutdown marker write did not finish in time — exiting anyway');
    } else {
      logFn(`clean shutdown: marker stamped on ${outcome.count} held row${outcome.count === 1 ? '' : 's'}`);
    }
  } catch (err) {
    logFn(
      `clean-shutdown marker write failed (${err instanceof Error ? err.message : String(err)}) — exiting anyway`,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** B-761: how long stop() waits for the clean-shutdown marker write before giving up on it — short
 *  enough that a hung write can never meaningfully delay the deliberate exit it precedes. */
const CLEAN_SHUTDOWN_TIMEOUT_MS = 2_000;

async function main(): Promise<void> {
  const token = process.env.HARMONY_API_TOKEN;
  if (!token) {
    process.stderr.write(
      'usage: node dist/bin/daemon.js [--config <deployment-config path>] [--profile <name>] ' +
        '(B-800, or set HARMONY_DAEMON_PROFILE=<profile.json>), plus HARMONY_API_TOKEN=<token>\n' +
        'HARMONY_API_TOKEN is not set\n',
    );
    process.exit(1);
  }

  const daemonArgv = parseDaemonArgs(process.argv.slice(2));

  let config;
  try {
    // B-800: try the deployment-config-by-name route FIRST — it wins whenever it fully resolves
    // (config present AND --profile names a profile that exists in its "profiles" section). A
    // deployment config that exists but is malformed JSON/schema throws here and is NOT caught
    // below the fallback note — that's a real misconfiguration, not an absence, so it must fail
    // loud (same convention as src/config/deployment-config.ts's own loader).
    const deploymentConfig = loadDeploymentConfig({ configPath: daemonArgv.config, env: process.env });
    const namedProfile = selectNamedProfile(deploymentConfig, daemonArgv.profile);
    if (daemonArgv.profile && deploymentConfig && !namedProfile) {
      // Short of a FULL resolution (config present + name given + name found), src/daemon/config.ts
      // falls back to HARMONY_DAEMON_PROFILE unchanged — this note just makes that fallback
      // legible instead of silent, since a typo'd --profile is the likeliest cause.
      process.stderr.write(
        `Note: profile "${daemonArgv.profile}" not found in the deployment config's "profiles" ` +
          `section (${resolveDeploymentConfigPath({ configPath: daemonArgv.config, env: process.env })}) ` +
          '— falling back to HARMONY_DAEMON_PROFILE.\n',
      );
    }
    config = loadDaemonConfig(
      process.env,
      (p) => readFileSync(p, 'utf8'),
      namedProfile ? { profileOverride: namedProfile } : {},
    );
  } catch (err) {
    process.stderr.write(
      'usage: node dist/bin/daemon.js [--config <deployment-config path>] [--profile <name>] ' +
        '(B-800, or set HARMONY_DAEMON_PROFILE=<profile.json>), plus HARMONY_API_TOKEN=<token>\n' +
        `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}\n`;
    process.stdout.write(stamped);
    if (config.logPath) {
      try {
        appendFileSync(config.logPath, stamped);
      } catch {
        // The log file is best-effort; stdout (launchd's StandardOutPath) is the primary sink.
      }
    }
  };

  // Capture auth + project ONCE — the daemon is pinned for its whole lifetime.
  const auth = new HarmonyAuth(token);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();
  // B-723: the project KEY, read once here alongside the id — the daemon's log names tickets by
  // their visual id (e.g. B-723), and that prefix is per-deployment CONFIG, never a baked constant.
  // Deliberately its OWN read: get_task's view:'meta' projection is a pinned 20-key shape and the
  // key is a PROJECT field, not a task one.
  const projectKey = (await getProject(client, projectId)).key as string;

  const leaseHolder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  /** Run a rendered launch/reap/probe command; consume ONLY the exit code. Worker output is
   *  discarded to the log (never parsed — the agent-portability guardrail), UNLESS `opts.quiet` is
   *  set (B-761) — used ONLY for the reap-before-adopt call site in scheduler.ts's
   *  handleWonTakeover, where a nonzero exit is the ROUTINE "container already gone" case, not an
   *  error: raw Docker stderr there reads as scary when it is actually expected. Quiet mode never
   *  streams the raw stdout/stderr lines (still drains them, so a chatty command can't backpressure
   *  the pipe) and instead logs exactly ONE calm line, keyed ONLY on the exit code — see
   *  renderQuietReapOutcome. */
  const runCommand = (cmd: string, opts?: { quiet?: boolean }): Promise<{ exitCode: number | null }> =>
    new Promise((resolve) => {
      const child = exec(cmd);
      if (opts?.quiet) {
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', () => {});
      } else {
        child.stdout?.on('data', (d: unknown) => log(`[worker] ${String(d).trimEnd()}`));
        child.stderr?.on('data', (d: unknown) => log(`[worker!] ${String(d).trimEnd()}`));
      }
      child.on('error', (err) => {
        log(`command failed to spawn: ${err.message}`);
        resolve({ exitCode: null });
      });
      child.on('close', (code) => {
        if (opts?.quiet) log(renderQuietReapOutcome(code));
        resolve({ exitCode: code });
      });
    });

  const deps: SchedulerDeps = {
    now: Date.now,
    sleep,
    listConductions: (args) => listConductions(client, args),
    getTaskMeta: async (taskId) =>
      (await getTask(client, projectId, { task_id: taskId, view: 'meta' })) as unknown as DaemonTask,
    countNonArchivedChildren: async (taskId) => {
      const children = (await listSubtasks(client, projectId, { task_id: taskId })) as Array<{
        archived?: boolean | null;
      }>;
      return children.filter((c) => !c.archived).length;
    },
    updateConduction: (id, patch) => updateConduction(client, id, patch),
    // B-739: every post-claim write is lease-guarded — null means another daemon owns this run.
    updateConductionIfHeld: (id, expectedLeaseHolder, patch) =>
      updateConductionIfHeld(client, id, expectedLeaseHolder, patch),
    // B-739: real timers, unref'd so they can never hold the process open on their own. The
    // heartbeat MUST stay in-process: a wedged event loop has to stop it, so a genuinely dead
    // daemon still goes stale and its run stays recoverable by takeover.
    startInterval: (ms, fn) => {
      const timer = setInterval(fn, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    },
    startTimeout: (ms, fn) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    takeoverConduction: (args) => takeoverConduction(client, args),
    // B-717 item 3: the multi-daemon steal CAS.
    stealConduction: (args) => stealConduction(client, args),
    runCommand,
    log,
    leaseHolder,
    config,
    projectKey,
  };

  const keeper = createHeartbeatKeeper({
    now: Date.now,
    startInterval: deps.startInterval,
    updateConductionIfHeld: (id, patch) => updateConductionIfHeld(client, id, leaseHolder, patch),
    log,
    heartbeatMs: config.heartbeatMs,
  });

  const stop = async (signal: string): Promise<void> => {
    // B-739: a lease must go quiet the MOMENT this process leaves, so it goes stale on schedule
    // and its run stays recoverable by another daemon's takeover.
    keeper.stopAll();
    // B-761: mark every row this process instance still holds as CLEANLY shut down — a same-host
    // successor's takeoverConduction CAS then adopts it immediately instead of waiting out the
    // full staleness window. Best-effort and bounded: the write must never block the deliberate
    // exit below (the fail-safe holds by construction — an unclean death never reaches this line
    // at all, so the marker just stays unset and the stale-window wait is unchanged).
    await markCleanShutdownBounded(client, leaseHolder, log, CLEAN_SHUTDOWN_TIMEOUT_MS);
    log(`received ${signal} — exiting (launchd owns restart)`);
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    void stop('SIGTERM');
  });
  process.on('SIGINT', () => {
    void stop('SIGINT');
  });

  log(
    `conductor daemon up: lease holder ${leaseHolder}, poll ${config.pollMs}ms, ` +
      `heartbeat ${config.heartbeatMs}ms, stale ${config.staleMs}ms, ` +
      `worker timeout ${config.workerTimeoutMs}ms`,
  );
  try {
    await runScheduler(deps, keeper);
  } catch (err) {
    // B-696 backstop: persistent auth failure exits non-zero so launchd restarts the daemon with
    // fresh auth — a restart beats a zombie that heartbeats but can never conduct.
    if (err instanceof PersistentAuthFailure) {
      log(`${err.message} — exiting 1 (launchd restarts with fresh auth)`);
      process.exit(1);
    }
    // B-739 backstop: a worker this daemon ruled overrun could not be reaped, so the pass is still
    // blocked with its deadline spent. Die loudly rather than heartbeat from inside a state we
    // cannot leave. The restart's fresh lease holder lets the stale-lease takeover path — whose
    // first action is REAP-THEN-FIRE — recover the run.
    if (err instanceof PersistentReapFailure) {
      keeper.stopAll();
      log(`${err.message} — exiting 1 (launchd restarts; takeover reclaims the run)`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`daemon failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
