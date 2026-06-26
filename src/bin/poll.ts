#!/usr/bin/env node
// B-532: the conductor's bundled background poll script.
//
// Launched by skills/harmony-conduct (§4c) via Bash(run_in_background) after the conductor surfaces a
// brief at a controlled pause:
//
//     node ${CLAUDE_PLUGIN_ROOT}/dist/bin/poll.js <ticket>
//
// It watches one Harmony ticket IN-PROCESS and exits the moment the human acts (a browser accept/defer
// advances workflow_state, a deny Parks it, or a reshape leaves a pending_resolution) — or after a bounded
// ~90-minute window. The conductor's `run_in_background` re-invocation on exit re-reads get_task itself and
// consumes the change per §4c; this script's stdout/exit code are DIAGNOSTIC only (the conductor does not
// trust them as the source of truth).
//
// Read-surface decision (B-532): the watch reads via the IN-PROCESS shared core (`getTask`) — NOT the MCP
// server, NOT the CLI subprocess, NOT the existing committed dist (those self-execute / carry their own
// process lifecycle). This is a NEW entrypoint precisely so the read path is a plain function call.
//
// Pinning (B-532 AC2): auth + project are captured ONCE at launch directly from HARMONY_API_TOKEN. We
// deliberately do NOT use getAuthenticatedContext() (src/cli/auth.ts) — it reads ~/.harmony/config.json's
// active-project pointer and mutates process.env, so a mid-watch `harmony` project switch would repoint the
// watch. Constructing HarmonyAuth from the token and reading getProjectId() once makes the watch immune.

import { HarmonyAuth } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getTask } from '../tools/tasks.js';
import { runPollLoop, WATCH_WINDOW_MS, type Taskish, type PollBaseline } from '../conductor/poll-loop.js';

/** Real setTimeout-based sleep — injected into the otherwise-pure loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exit codes are a DIAGNOSTIC convenience for the conductor reading the background-task completion notice.
const EXIT = {
  changed: 0, // a change was detected — re-read get_task and consume
  timeout: 2, // ~90-min window expired — degrade to persist-and-resume
  error: 1, // could not run (no token / unrecoverable error)
} as const;

async function main(): Promise<number> {
  const ticket = process.argv[2];
  if (!ticket) {
    process.stderr.write('usage: node dist/bin/poll.js <ticket>\n');
    return EXIT.error;
  }

  const token = process.env.HARMONY_API_TOKEN;
  if (!token) {
    process.stderr.write('HARMONY_API_TOKEN is not set\n');
    return EXIT.error;
  }

  // Capture auth + project ONCE — the watch is pinned for its whole lifetime (AC2).
  const auth = new HarmonyAuth(token);
  const client = await createAuthenticatedClient(auth);
  const projectId = auth.getProjectId();

  // Baseline read: the state the watch diffs every poll against.
  const baselineTask = (await getTask(client, projectId, { task_id: ticket })) as Taskish;
  const baseline: PollBaseline = {
    workflowState: baselineTask.workflow_state ?? null,
    pendingResolution: baselineTask.pending_resolution ?? null,
  };

  // Anchor the window to a single launch stamp (B-548): elapsed is always measured against this.
  const launchStamp = Date.now();

  // A transient read error must NOT kill the watch — degrade that poll to "no change" (return the
  // baseline shape) so the loop keeps watching; the bounded window still ends it.
  const readTask = async (): Promise<Taskish> => {
    try {
      return (await getTask(client, projectId, { task_id: ticket })) as Taskish;
    } catch {
      return { workflow_state: baseline.workflowState, pending_resolution: baseline.pendingResolution };
    }
  };

  const result = await runPollLoop({
    readTask,
    now: Date.now,
    sleep,
    launchStamp,
    windowMs: WATCH_WINDOW_MS,
    baseline,
  });

  const elapsedMs = Date.now() - launchStamp;
  const summary =
    result.reason === 'changed'
      ? { ok: true, ticket, reason: result.reason, ...result.detail, elapsed_ms: elapsedMs }
      : { ok: true, ticket, reason: result.reason, elapsed_ms: elapsedMs };
  process.stdout.write(JSON.stringify(summary) + '\n');

  return result.reason === 'changed' ? EXIT.changed : EXIT.timeout;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`poll failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT.error);
  });
