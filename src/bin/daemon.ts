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
// B-720 (replacement capture): the launcher half of the per-leg output record — the daemon WRITES
// `source='launcher'` rows and never reads one back (the agent-neutrality seam).
import { recordLegOutput } from '../tools/leg-output-record.js';
import { runRecordedWalkDrainPass } from '../daemon/recorded-walk-drain.js';
import { createHeartbeatKeeper } from '../daemon/heartbeat.js';
import { formatDaemonError } from '../daemon/error-format.js';
import { loadDaemonConfig, selectNamedProfile } from '../daemon/config.js';
import { quietLogLine } from '../daemon/quiet-reap.js';
import { runBootPreflight, type PreflightProfile } from '../daemon/preflight.js';
import {
  loadDeploymentConfig,
  resolveDeploymentConfigPath,
  type DeploymentConfig,
  type LaunchProfileConfig,
} from '../config/deployment-config.js';
import {
  PersistentAuthFailure,
  PersistentReapFailure,
  runScheduler,
  WORKER_OUTPUT_TAIL_BYTES,
  type DaemonTask,
  type SchedulerDeps,
} from '../daemon/scheduler.js';
// B-1011: the OPTIONAL hint subscription — a Realtime broadcast that interrupts the poll sleep.
import {
  startHintSubscription,
  type HintChannelLike,
  type HintSubscription,
} from '../daemon/hint-subscription.js';

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
    logFn(`clean-shutdown marker write failed (${formatDaemonError(err)}) — exiting anyway`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** B-761: how long stop() waits for the clean-shutdown marker write before giving up on it — short
 *  enough that a hung write can never meaningfully delay the deliberate exit it precedes. */
const CLEAN_SHUTDOWN_TIMEOUT_MS = 2_000;

/** B-1011: how long stop() waits for the hint channel to unsubscribe. Shorter than the marker
 *  write's budget on purpose — a websocket teardown is local and best-effort, and unlike the
 *  clean-shutdown marker nothing downstream depends on it happening at all. */
const HINT_CLOSE_TIMEOUT_MS = 1_000;

/** B-1011: bound the hint channel's unsubscribe — same shape as markCleanShutdownBounded above
 *  (a race against an UNREF'd timer, a log line on every outcome, never throws), for the same
 *  reason: a hung socket teardown must never delay the deliberate exit that follows it. */
async function closeHintsBounded(
  hints: HintSubscription,
  logFn: (line: string) => void,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([hints.close().then(() => 'closed' as const), timeout]);
    logFn(
      outcome === 'timeout'
        ? 'hint channel did not unsubscribe in time — exiting anyway'
        : 'hint channel unsubscribed',
    );
  } catch (err) {
    logFn(`hint channel unsubscribe failed (${formatDaemonError(err)}) — exiting anyway`);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  // B-800: hoisted out of the try block below so the boot preflight (which needs the SAME already-
  // loaded deployment config + resolved named profile) can read them without a second load — no new
  // I/O surface. Both stay null on the legacy HARMONY_DAEMON_PROFILE route.
  let deploymentConfig: DeploymentConfig | null = null;
  let namedProfile: LaunchProfileConfig | null = null;
  try {
    // B-800: try the deployment-config-by-name route FIRST — it wins whenever it fully resolves
    // (config present AND --profile names a profile that exists in its "profiles" section). A
    // deployment config that exists but is malformed JSON/schema throws here and is NOT caught
    // below the fallback note — that's a real misconfiguration, not an absence, so it must fail
    // loud (same convention as src/config/deployment-config.ts's own loader).
    deploymentConfig = loadDeploymentConfig({ configPath: daemonArgv.config, env: process.env });
    namedProfile = selectNamedProfile(deploymentConfig, daemonArgv.profile);
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

  /** Run a rendered launch/reap/probe command; consume ONLY the exit code. Worker output is
   *  discarded to the log (never parsed — the agent-portability guardrail), UNLESS `opts.quiet` is
   *  set (B-761) — quiet mode never streams the raw stdout/stderr lines (still drains them, so a
   *  chatty command can't backpressure the pipe).
   *
   *  B-740 REOPEN FIX: `opts.quiet` ALONE renders NOTHING on close — src/daemon/preflight.ts's boot
   *  tool-check (`command -v <tool>`) passes exactly `{ quiet: true }` on EVERY boot, and a passing
   *  check must never look like a reap outcome (the exact bug this reopen fixes: the old two-way
   *  quiet flag unconditionally called renderQuietReapOutcome, so every tool found on PATH logged
   *  "reaped a live worker" on every boot). A caller now OPTS IN to a rendered line by ALSO supplying
   *  `opts.quietRender` — today, ONLY the reap-before-adopt call site in scheduler.ts's
   *  handleWonTakeover (`quietRender: renderQuietReapOutcome`), where a nonzero exit is the ROUTINE
   *  "container already gone" case, not an error: raw Docker stderr there reads as scary when it is
   *  actually expected. See quiet-reap.ts's `quietLogLine` (the decision extracted below) for the
   *  regression-tested contract.
   *
   *  B-801: defined HERE (moved up from just above `deps`) so the boot preflight below — which
   *  MUST run before HarmonyAuth/createAuthenticatedClient — can reuse this SAME instance for its
   *  `command -v <tool>` resolution rather than standing up a second exec path; SchedulerDeps below
   *  still gets the identical closure. */
  const runCommand = (
    cmd: string,
    opts?: { quiet?: boolean; quietRender?: (code: number | null) => string },
  ): Promise<{ exitCode: number | null; outputTail: string; outputBytes: number }> =>
    new Promise((resolve) => {
      const child = exec(cmd);
      // B-720: a BOUNDED ring buffer over the same data events the log already sees. Chunks are
      // appended and dropped from the FRONT while the retained bytes exceed WORKER_OUTPUT_TAIL_BYTES,
      // so memory is capped regardless of how chatty the command is (a single oversized chunk is
      // sliced by characters, which can never split a codepoint mid-way). `outputBytes` counts the
      // TOTAL the command emitted, not the retained tail — their difference is exactly the
      // "showing the last N of M" signal the board states to the operator.
      //
      // WHOSE BYTES THESE ARE (B-720's replacement capture — say it plainly): this captures the
      // LAUNCH COMMAND's output. That is the WORKER's output only on the docker profile, whose
      // launch template ends in an attached `docker run`. On the cloud profile — the one production
      // runs — the launch command is a Cloud Run control-plane client (container/
      // cloud-worker-launch.sh) and the worker's stdout goes to Cloud Logging, never through this
      // process. So this buffer is stored as `source='launcher'` and shown under its own
      // "Launcher diagnostics" label (src/daemon/scheduler.ts's flushLaunchOutput); the worker
      // records its OWN output from inside the container, via `harmony leg-output record`.
      const chunks: string[] = [];
      let tailBytes = 0;
      let outputBytes = 0;
      const capture = (chunk: string): void => {
        const size = Buffer.byteLength(chunk, 'utf8');
        outputBytes += size;
        chunks.push(chunk);
        tailBytes += size;
        while (chunks.length > 1 && tailBytes > WORKER_OUTPUT_TAIL_BYTES) {
          tailBytes -= Buffer.byteLength(chunks[0], 'utf8');
          chunks.shift();
        }
        if (chunks.length === 1 && tailBytes > WORKER_OUTPUT_TAIL_BYTES) {
          chunks[0] = chunks[0].slice(-WORKER_OUTPUT_TAIL_BYTES);
          tailBytes = Buffer.byteLength(chunks[0], 'utf8');
        }
      };
      if (opts?.quiet) {
        // Quiet suppresses the LOG lines, not the capture: it still drains both pipes (a chatty
        // command must never backpressure), and the tail it accumulates is simply unused by the
        // reap/probe/preflight call sites that pass `quiet`.
        child.stdout?.on('data', (d: unknown) => capture(String(d)));
        child.stderr?.on('data', (d: unknown) => capture(String(d)));
      } else {
        child.stdout?.on('data', (d: unknown) => {
          capture(String(d));
          log(`[worker] ${String(d).trimEnd()}`);
        });
        child.stderr?.on('data', (d: unknown) => {
          capture(String(d));
          log(`[worker!] ${String(d).trimEnd()}`);
        });
      }
      child.on('error', (err) => {
        log(`command failed to spawn: ${err.message}`);
        resolve({ exitCode: null, outputTail: chunks.join(''), outputBytes });
      });
      child.on('close', (code) => {
        const line = quietLogLine(code, opts);
        if (line !== null) log(line);
        resolve({ exitCode: code, outputTail: chunks.join(''), outputBytes });
      });
    });

  // B-792: probe a ref (branch name) across every configured repo's remote — a NEW exec (captures
  // stdout, unlike runCommand above which discards it), because this reads one CLI's structured
  // ref/SHA output, never the LLM worker's stdout — the agent-portability guardrail runCommand
  // exists to enforce is unaffected. Feature-detects on `deploymentConfig.repos` (absent/empty ⇒
  // this daemon process has no single checked-out repo with an "origin" remote to probe — return
  // null, consistent with every other `repos`-optional consumer in this file). Tries each configured
  // repo's `url` in order and returns the FIRST non-empty SHA found (a `git ls-remote` miss returns
  // empty stdout, not an error — that reads as "not in this repo, try the next", not a failure).
  // NEVER throws: any spawn/exec error for any one repo is swallowed and the loop moves on, because
  // this is best-effort repo-progress detection that must never crash the daemon.
  const probeOneRepo = (url: string, ref: string): Promise<string | null> =>
    new Promise((resolve) => {
      // Quoted defensively even though url/ref come from trusted deployment config, not user input.
      exec(`git ls-remote ${JSON.stringify(url)} ${JSON.stringify(ref)}`, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const sha = stdout.trim().split(/\s+/)[0];
        resolve(sha && sha.length > 0 ? sha : null);
      });
    });

  const probeRef = async (ref: string): Promise<string | null> => {
    const repos = deploymentConfig?.repos;
    if (!repos || repos.length === 0) return null;
    for (const repo of repos) {
      try {
        const sha = await probeOneRepo(repo.url, ref);
        if (sha) return sha;
      } catch {
        // best-effort — try the next repo.
      }
    }
    return null;
  };

  // B-801: validate the whole deployment surface — tools on PATH, the launcher-host env contract,
  // and an audit of absent optional profile capabilities — BEFORE any conduction can run. Runs
  // right after loadDaemonConfig resolves and before HarmonyAuth/createAuthenticatedClient/
  // runScheduler, exactly per the accepted design. `gcloud_project` is folded in from the resolved
  // named profile (when the B-800 named route was used) since src/daemon/config.ts's DaemonConfig
  // deliberately doesn't carry it — see src/daemon/preflight.ts's PreflightProfile doc comment.
  const preflightProfileName = daemonArgv.profile ?? (process.env.HARMONY_DAEMON_PROFILE || 'unnamed');
  const preflightProfile: PreflightProfile = {
    ...config.profile,
    gcloud_project: namedProfile?.gcloud_project,
  };
  try {
    await runBootPreflight(config, preflightProfile, {
      runCommand,
      env: process.env,
      deploymentConfig,
      profileName: preflightProfileName,
      log,
    });
  } catch (err) {
    log(`boot preflight failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

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

  // B-1011: the daemon's WORKSPACE uuid — B-1010's broadcast topic is `workspace:<uuid>`. ONE
  // authenticated read, pinned for the whole lifetime exactly like projectKey above (same reason:
  // a daemon must never re-resolve its identity mid-run). TOLERANT: a failure here is not a boot
  // failure — it just means no hint channel, i.e. today's 25s poll, which is state (A) of the
  // lifecycle in src/daemon/hints.ts. Same read shape as src/tools/labels.ts's own resolver.
  let workspaceId: string | null = null;
  try {
    const { data, error } = await client
      .from('projects')
      .select('workspace_id')
      .eq('id', projectId)
      .single();
    if (error) throw error;
    workspaceId = (data as { workspace_id: string }).workspace_id;
  } catch (err) {
    log(
      `could not resolve the workspace for hints (${formatDaemonError(err)}) — ` +
        `continuing on the ${config.pollMs}ms poll interval alone`,
    );
  }

  // B-739: real timers, unref'd so they can never hold the process open on their own. Hoisted out
  // of the SchedulerDeps literal below (B-1011) so the hint subscription's debounce window uses the
  // very same injected seam the scheduler does — never a bare global setTimeout.
  const startTimeout = (ms: number, fn: () => void): (() => void) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  };

  // B-1011: the hint channel, created LAZILY — after boot, and without ever awaiting the join, so
  // nothing about startup can block on a socket. With no workspace uuid (or a channel that never
  // subscribes) this is simply absent and runScheduler runs the identical poll loop it always has.
  let realChannel: ReturnType<typeof client.channel> | null = null;
  const hints: HintSubscription | null = workspaceId
    ? startHintSubscription({
        createChannel: (topic) => {
          // The EXISTING authenticated client's own channel — no new dependency and no token
          // plumbing: the realtime socket authenticates through the same accessToken callback
          // src/supabase.ts already passes. `private: true` is required by B-1010's RLS policy.
          realChannel = client.channel(topic, { config: { private: true } });
          return realChannel as unknown as HintChannelLike;
        },
        removeChannel: () => (realChannel ? client.removeChannel(realChannel) : Promise.resolve()),
        workspaceId,
        leaseHolder,
        debounceMs: config.hintDebounceMs,
        startTimeout,
        log,
        // B-1045: recover from a post-subscribed CHANNEL_ERROR whose token has expired — same
        // HarmonyAuth instance SchedulerDeps.forceRefresh already reuses, same client the
        // `.channel()`/`.removeChannel()` calls above already use.
        forceRefresh: () => auth.forceRefresh(),
        setAuth: () => client.realtime.setAuth(),
        pollMs: config.pollMs,
      })
    : null;

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
    startTimeout,
    // B-1011: OPTIONAL. Present only when the workspace uuid resolved and a channel was created;
    // absent otherwise, which leaves the scheduler's sleep the literal line it has always been.
    hints: hints?.source,
    takeoverConduction: (args) => takeoverConduction(client, args),
    // B-717 item 3: the multi-daemon steal CAS.
    stealConduction: (args) => stealConduction(client, args),
    // B-845: single-flight, bound to the daemon's ONE lifetime HarmonyAuth instance — lets a CAS
    // write self-heal a mid-tick PGRST303 without a second exchange per concurrent caller.
    forceRefresh: () => auth.forceRefresh(),
    runCommand,
    // B-720 (replacement capture): the launcher-diagnostics write. Never throws (see
    // src/tools/leg-output-record.ts) — a settlement must never depend on it, before or after
    // harmony-web's conduction_leg_output migration is promoted.
    recordLegOutput: (args) => recordLegOutput(client, args),
    probeRef,
    log,
    leaseHolder,
    config,
    projectKey,
    // B-929 lever 2: the deployment's worker image, resolved ONCE here and carried for the daemon's
    // lifetime (same pin-at-boot discipline as projectKey above). `deploymentConfig` is null on every
    // machine with no ~/.harmony/deployment.json, which leaves this undefined and lets
    // templateVars fall back to the schema default — never a throw, never a launch blocked.
    workerImage: deploymentConfig?.worker_image,
    // B-1062: the recorded-walk drain, ONE request per pass, running the SAME zero-worker-leg
    // gate-walk core `harmony record` uses (src/tools/record-walk.ts) directly in-process. Attributed
    // to this daemon's own authenticated service-account user id — see recorded-walk-drain.ts's own
    // header for the tolerant-absence contract (the table may not exist yet).
    drainRecordedWalkRequests: async () => {
      await runRecordedWalkDrainPass({ client, projectId, userId: auth.getUserId(), log });
    },
  };

  const keeper = createHeartbeatKeeper({
    now: Date.now,
    startInterval: deps.startInterval,
    updateConductionIfHeld: (id, patch) => updateConductionIfHeld(client, id, leaseHolder, patch),
    log,
    heartbeatMs: config.heartbeatMs,
    // B-845: same single lifetime HarmonyAuth instance as SchedulerDeps.forceRefresh above.
    forceRefresh: () => auth.forceRefresh(),
    sleep,
  });

  const stop = async (signal: string): Promise<void> => {
    // B-739: a lease must go quiet the MOMENT this process leaves, so it goes stale on schedule
    // and its run stays recoverable by another daemon's takeover.
    keeper.stopAll();
    // B-1011: drop the hint channel next — after the leases go quiet (a lease must go quiet the
    // moment this process leaves, and nothing about the socket may delay that) and BEFORE the
    // clean-shutdown marker write, so the daemon is not still taking wakes it can never act on
    // while it stamps its final rows. Bounded and best-effort, exactly like the write below.
    if (hints) await closeHintsBounded(hints, log, HINT_CLOSE_TIMEOUT_MS);
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
      `worker timeout ${config.workerTimeoutMs}ms, ` +
      // B-1011: "requested" — the channel is created lazily and its join has NOT been awaited at
      // this point. Whether it actually subscribed is reported by its own status line.
      `hints ${hints ? `requested (${config.hintDebounceMs}ms debounce)` : 'off'}`,
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
  process.stderr.write(
    `daemon failed: ${formatDaemonError(err, { endpoint: '/functions/v1/auth-token' })}\n`,
  );
  process.exit(1);
});
