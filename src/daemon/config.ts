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

  return {
    pollMs: envMs(env, 'HARMONY_DAEMON_POLL_MS', 25_000),
    heartbeatMs: envMs(env, 'HARMONY_DAEMON_HEARTBEAT_MS', 30_000),
    staleMs: envMs(env, 'HARMONY_DAEMON_STALE_MS', 300_000),
    retryCap: envNonNegativeInt(env, 'HARMONY_DAEMON_RETRY_CAP', 2),
    retryBackoffMs: envNonNegativeInt(env, 'HARMONY_DAEMON_RETRY_BACKOFF_MS', 15_000),
    profile: { launch: profile.launch, reap: profile.reap },
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
