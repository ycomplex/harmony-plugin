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
import { listSubtasks } from '../tools/decomposition.js';
import {
  listConductions,
  takeoverConduction,
  updateConduction,
} from '../tools/conduction-record.js';
import { loadDaemonConfig } from '../daemon/config.js';
import { runScheduler, type DaemonTask, type SchedulerDeps } from '../daemon/scheduler.js';

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
    takeoverConduction: (args) => takeoverConduction(client, args),
    runCommand,
    log,
    leaseHolder,
    config,
  };

  const stop = (signal: string): void => {
    log(`received ${signal} — exiting (launchd owns restart)`);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  log(
    `conductor daemon up: lease holder ${leaseHolder}, poll ${config.pollMs}ms, ` +
      `heartbeat ${config.heartbeatMs}ms, stale ${config.staleMs}ms`,
  );
  await runScheduler(deps);
}

main().catch((err) => {
  process.stderr.write(`daemon failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
