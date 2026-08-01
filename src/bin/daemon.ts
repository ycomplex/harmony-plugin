#!/usr/bin/env node
// B-696: the conductor daemon entrypoint.
//
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
// SIGTERM/SIGINT log and exit 0.

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
  updateConduction,
  updateConductionIfHeld,
} from '../tools/conduction-record.js';
import { createHeartbeatKeeper } from '../daemon/heartbeat.js';
import { loadDaemonConfig } from '../daemon/config.js';
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

async function main(): Promise<void> {
  const token = process.env.HARMONY_API_TOKEN;
  if (!token) {
    process.stderr.write(
      'usage: HARMONY_DAEMON_PROFILE=<profile.json> HARMONY_API_TOKEN=<token> node dist/bin/daemon.js\n' +
        'HARMONY_API_TOKEN is not set\n',
    );
    process.exit(1);
  }

  let config;
  try {
    config = loadDaemonConfig(process.env, (p) => readFileSync(p, 'utf8'));
  } catch (err) {
    process.stderr.write(
      'usage: HARMONY_DAEMON_PROFILE=<profile.json> HARMONY_API_TOKEN=<token> node dist/bin/daemon.js\n' +
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

  /** Run a rendered launch/reap command; consume ONLY the exit code. Worker output is discarded
   *  to the log (never parsed — the agent-portability guardrail). */
  const runCommand = (cmd: string): Promise<{ exitCode: number | null }> =>
    new Promise((resolve) => {
      const child = exec(cmd);
      child.stdout?.on('data', (d: unknown) => log(`[worker] ${String(d).trimEnd()}`));
      child.stderr?.on('data', (d: unknown) => log(`[worker!] ${String(d).trimEnd()}`));
      child.on('error', (err) => {
        log(`command failed to spawn: ${err.message}`);
        resolve({ exitCode: null });
      });
      child.on('close', (code) => resolve({ exitCode: code }));
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

  const stop = (signal: string): void => {
    // B-739: a lease must go quiet the MOMENT this process leaves, so it goes stale on schedule
    // and its run stays recoverable by another daemon's takeover.
    keeper.stopAll();
    log(`received ${signal} — exiting (launchd owns restart)`);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

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
