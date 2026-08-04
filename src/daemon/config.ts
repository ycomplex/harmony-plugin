// B-696: daemon configuration + the worker launch profile.
//
// The daemon NEVER bakes in a worker command (agent-portability guardrail — B-711 "config not
// constants"): how a worker is launched and reaped is a pair of command TEMPLATES loaded from the
// profile JSON named by HARMONY_DAEMON_PROFILE. The v1 dogfood profile
// (container/daemon-profile.example.json) launches the B-694 build container; a future agent brand
// swaps the profile file, not this code. Worker credentials (git, CLAUDE_CODE_OAUTH_TOKEN) live
// ONLY in the profile's --env-file — the daemon's own env carries just HARMONY_API_TOKEN.
//
// Pure: env + readFile are parameters, so config loading is unit-testable with no fs/process.

export interface LaunchProfile {
  /** Command template that launches a one-shot worker. Placeholders: {conduction_id}, {ticket}. */
  launch: string;
  /** Command template that force-removes a (possibly dead) worker. Same placeholders. */
  reap: string;
  /** B-717 restart reconciliation: an OPTIONAL command template that exits 0 when a worker for
   *  {conduction_id} is still running (found), non-zero when it is not (settled/absent). A
   *  profile that omits it simply skips reconciliation — a newly-claimed row with a non-null
   *  `leg_started_at` falls back to today's REAP-THEN-FIRE exactly as before this ticket. Same
   *  placeholders as launch/reap; never keys on stdout (the daemon consumes only the exit code). */
  probe?: string;
  /** B-717 item 2: this profile's OWN concurrency ceiling — read as a PER-PROFILE value (config not
   *  constants) because a sane cap differs by launch mechanism: local-docker is bounded by the host
   *  resource ceiling, cloud by the subscription/Cloud Run execution quota (item 4). Overridable by
   *  HARMONY_DAEMON_MAX_CONCURRENT_WORKERS regardless of profile; falls back to 3 when neither the
   *  env var nor the profile sets it. */
  maxConcurrentWorkers?: number;
}

export interface DaemonConfig {
  pollMs: number;
  heartbeatMs: number;
  staleMs: number;
  /** B-713: bounded retry cap for a dirty worker exit before the scheduler parks the conduction.
   *  0 disables retry — reproduces the pre-B-713 park-immediately behavior exactly. */
  retryCap: number;
  /** B-713: backoff between a dirty exit and its retried re-fire, in milliseconds. */
  retryBackoffMs: number;
  /** B-739: the bounded deadline for ONE worker launch. On expiry the launching daemon reaps its
   *  own worker through the profile's reap template — which is also what unblocks the awaited
   *  launch (an exec timeout does neither; verified live). Sized GENEROUSLY on purpose: this
   *  exists to catch a hung worker, not to police a slow one, and a slow-but-progressing run must
   *  never be destroyed by it. Scoped per LAUNCH, so a retried attempt gets its own full deadline. */
  workerTimeoutMs: number;
  /** B-717 item 1/2: the fire-and-track concurrency cap — how many workers this daemon runs at
   *  once. Resolved from HARMONY_DAEMON_MAX_CONCURRENT_WORKERS if set, else the active launch
   *  profile's own `maxConcurrentWorkers`, else 3 (sized for local-docker's host resource ceiling —
   *  see LaunchProfile.maxConcurrentWorkers). */
  maxConcurrentWorkers: number;
  /** B-717 item 2: a ready candidate that has waited this long is promoted one priority tier for
   *  ranking purposes only (aging escalation), so a sustained stream of high-priority arrivals
   *  cannot starve a low-priority ticket indefinitely. */
  readyAgeMs: number;
  profile: LaunchProfile;
  logPath?: string;
}

/** B-694 empty-env-value shadow class: an env var set to '' must behave exactly like unset. */
function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return v == null || v === '' ? undefined : v;
}

function envMs(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = envValue(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number of milliseconds, got: ${raw}`);
  }
  return n;
}

/** B-713: a non-negative INTEGER knob — unlike envMs, 0 is a valid value (it disables retry), but
 *  a fraction or a negative count is nonsensical for "how many times" / "how many milliseconds". */
function envNonNegativeInt(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = envValue(env, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`${key} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

export function loadDaemonConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): DaemonConfig {
  const profilePath = envValue(env, 'HARMONY_DAEMON_PROFILE');
  if (!profilePath) {
    throw new Error(
      'HARMONY_DAEMON_PROFILE is required — the path to the launch-profile JSON ' +
        '({ launch, reap } command templates). There is no baked-in worker command.',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(profilePath));
  } catch (err) {
    throw new Error(
      `could not load the launch profile at ${profilePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const profile = parsed as Partial<LaunchProfile>;
  if (typeof profile.launch !== 'string' || profile.launch.length === 0) {
    throw new Error(`launch profile ${profilePath} is missing the "launch" command template`);
  }
  if (typeof profile.reap !== 'string' || profile.reap.length === 0) {
    throw new Error(`launch profile ${profilePath} is missing the "reap" command template`);
  }
  if (profile.probe !== undefined && (typeof profile.probe !== 'string' || profile.probe.length === 0)) {
    throw new Error(`launch profile ${profilePath}'s "probe" template, when present, must be a non-empty string`);
  }
  if (
    profile.maxConcurrentWorkers !== undefined &&
    (!Number.isInteger(profile.maxConcurrentWorkers) || profile.maxConcurrentWorkers < 0)
  ) {
    throw new Error(
      `launch profile ${profilePath}'s "maxConcurrentWorkers", when present, must be a non-negative integer`,
    );
  }

  return {
    pollMs: envMs(env, 'HARMONY_DAEMON_POLL_MS', 25_000),
    heartbeatMs: envMs(env, 'HARMONY_DAEMON_HEARTBEAT_MS', 30_000),
    staleMs: envMs(env, 'HARMONY_DAEMON_STALE_MS', 300_000),
    retryCap: envNonNegativeInt(env, 'HARMONY_DAEMON_RETRY_CAP', 2),
    retryBackoffMs: envNonNegativeInt(env, 'HARMONY_DAEMON_RETRY_BACKOFF_MS', 15_000),
    workerTimeoutMs: envMs(env, 'HARMONY_DAEMON_WORKER_TIMEOUT_MS', 5_400_000),
    // B-717 item 2: env var > per-profile override > the 3-for-local-docker default.
    maxConcurrentWorkers: envNonNegativeInt(
      env,
      'HARMONY_DAEMON_MAX_CONCURRENT_WORKERS',
      profile.maxConcurrentWorkers ?? 3,
    ),
    readyAgeMs: envMs(env, 'HARMONY_DAEMON_READY_AGE_MS', 600_000),
    profile: { launch: profile.launch, reap: profile.reap, probe: profile.probe, maxConcurrentWorkers: profile.maxConcurrentWorkers },
    logPath: envValue(env, 'HARMONY_DAEMON_LOG'),
  };
}

/** Substitute {conduction_id} / {ticket} into a profile template. An unknown {placeholder} throws
 *  LOUDLY — a template typo must never reach the shell as a literal brace token. Plain shell
 *  syntax ($HOME etc.) passes through untouched. */
export function renderTemplate(
  tpl: string,
  vars: { conduction_id: string; ticket: string },
): string {
  return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    if (name === 'conduction_id') return vars.conduction_id;
    if (name === 'ticket') return vars.ticket;
    throw new Error(
      `unknown placeholder {${name}} in launch-profile template — supported: {conduction_id}, {ticket}`,
    );
  });
}
