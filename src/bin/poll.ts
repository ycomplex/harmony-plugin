#!/usr/bin/env node
// B-532: the conductor's bundled background poll script.
//
// Launched by skills/harmony-conduct (§4c) via Bash(run_in_background) after the conductor surfaces a
// brief at a controlled pause:
//
//     node ${CLAUDE_PLUGIN_ROOT}/dist/bin/poll.js <ticket>
//
// It watches one Harmony ticket IN-PROCESS and exits the moment the human acts. The canonical exit signal is
// `awaiting_human_input` clearing (true→false); the poll then classifies what the human did — a browser
// accept advances workflow_state, a deny Parks it, a reshape leaves a pending_resolution, an elicitation
// round-submit / force-quit request leaves an unconsumed marker on the active exchange (B-645,
// 'answers-landed'), a non-advancing sub-track accept simply clears the flag (B-611), and an
// accept-with-remark additionally carries the unconsumed remark ALONGSIDE its classification (B-503) — or
// it exits after a bounded ~90-minute window. The
// conductor's `run_in_background` re-invocation on exit re-reads get_task itself and
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
import {
  runPollLoop,
  captureBaseline,
  WATCH_WINDOW_MS,
  type Taskish,
  type PollBaseline,
} from '../conductor/poll-loop.js';

/** Real setTimeout-based sleep — injected into the otherwise-pure loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exit codes are a DIAGNOSTIC convenience for the conductor reading the background-task completion notice.
const EXIT = {
  changed: 0, // a change was detected — re-read get_task and consume
  timeout: 2, // ~90-min window expired — degrade to persist-and-resume
  error: 1, // could not run (no token / unrecoverable error)
  // B-691: armed against a non-pause — the ball was never with the human, so this watch can never
  // fire. Distinct from `timeout` because the conductor's response differs: timeout degrades to
  // persist-and-resume, this files a worker-question elicitation round (harmony-conduct §4c/§4e).
  unwatchable: 3,
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

  // Baseline read: the state the FIRST poll is compared against. active_exchange (B-645) and
  // pending_remark (B-503) are captured so an unconsumed marker already present at launch reads as
  // stale, never as fresh news.
  // B-684: the watch reads via the lean 'meta' view — it consumes only workflow_state /
  // pending_resolution / awaiting_human_input / active_exchange / pending_remark, all of which meta
  // carries.
  // B-691: this seeds the baseline; it does NOT pin it. runPollLoop rolls the baseline forward on
  // every poll, which is what lets a watch armed before its pause was filed still fire.
  const baselineTask = (await getTask(client, projectId, { task_id: ticket, view: 'meta' })) as Taskish;
  const baseline: PollBaseline = captureBaseline(baselineTask);

  // Anchor the window to a single launch stamp (B-548): elapsed is always measured against this.
  // B-691: the launch stamp and the change baseline are SEPARATE concerns and must stay separate —
  // the stamp bounds the ~90-minute window and never moves; the baseline rolls every poll.
  const launchStamp = Date.now();

  // A transient read error must NOT kill the watch. B-691: the degradation now lives INSIDE
  // runPollLoop, which substitutes its own current (rolled) baseline. Doing it here would substitute
  // the LAUNCH baseline, and against a rolled baseline a stale flag value can manufacture a false
  // true→false transition — i.e. a failed read could fire the gate. So this simply propagates.
  const readTask = async (): Promise<Taskish> =>
    (await getTask(client, projectId, { task_id: ticket, view: 'meta' })) as Taskish;

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
      : result.reason === 'unwatchable'
        ? { ok: true, ticket, reason: result.reason, polls: result.polls, elapsed_ms: elapsedMs }
        : { ok: true, ticket, reason: result.reason, elapsed_ms: elapsedMs };
  process.stdout.write(JSON.stringify(summary) + '\n');

  if (result.reason === 'changed') return EXIT.changed;
  if (result.reason === 'unwatchable') return EXIT.unwatchable;
  return EXIT.timeout;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`poll failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT.error);
  });
