// B-696: daemon configuration + the worker launch profile.
//
// The daemon NEVER bakes in a worker command (agent-portability guardrail — B-711 "config not
// constants"): how a worker is launched and reaped is a pair of command TEMPLATES, resolved one of
// two ways:
//
//   (1) B-800, preferred: NAMED from a deployment config's `profiles` section
//       (src/config/deployment-config.ts, ~/.harmony/deployment.json by default) — selected by the
//       entrypoint (src/bin/daemon.ts) via `--config <path>` / `--profile <name>` argv flags
//       (mirrors the `harmony config get` CLI's `--config` convention), passed in here as
//       `opts.profileOverride`.
//   (2) legacy, unchanged: a STANDALONE profile JSON file named by HARMONY_DAEMON_PROFILE. The v1
//       dogfood profile (container/daemon-profile.example.json) launches the B-694 build container;
//       a future agent brand swaps the profile, not this code.
//
// Precedence (load-bearing — see src/bin/daemon.ts): (1) wins whenever it resolves (a deployment
// config is present AND --profile names a profile that exists in its `profiles` section);
// otherwise this module falls back to (2) exactly as it always has. Existing single-profile
// file-path deployments need zero config changes — this is additive, not a replacement.
//
// Worker credentials (git, CLAUDE_CODE_OAUTH_TOKEN) live ONLY in the profile's --env-file — the
// daemon's own env carries just HARMONY_API_TOKEN.
//
// Pure: env + readFile (+ the optional profileOverride) are parameters, so config loading is
// unit-testable with no fs/process. Resolving a NAMED profile from a deployment config file is I/O
// (src/config/deployment-config.ts's loadDeploymentConfig) and deliberately happens OUTSIDE this
// module, in src/bin/daemon.ts, which passes the already-resolved profile in as profileOverride —
// this module itself never touches the deployment config file or argv.

import type { DeploymentConfig, LaunchProfileConfig } from '../config/deployment-config.js';

/** B-801: declarative, OPTIONAL map of binaries each template invokes — mirrors
 *  src/config/deployment-config.ts's RequiredToolsSchema; kept in lockstep (see
 *  src/config/deployment-config.test.ts / src/daemon/config.test.ts's schema-parity test). */
export interface RequiredTools {
  launch?: string[];
  reap?: string[];
  probe?: string[];
}

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
  /** B-801: see RequiredTools above — src/daemon/preflight.ts's hard tool-resolution check. */
  required_tools?: RequiredTools;
  /** B-801: true when this profile mints a worker credential via mint-installation-token.mjs before
   *  launch — gates src/daemon/preflight.ts's hard env-contract check. Mirrors
   *  src/config/deployment-config.ts's LaunchProfileSchema field of the same name. */
  requires_app_mint?: boolean;
  /** B-801: bumped whenever a NEW optional profile capability ships. Defaults to 1 when absent — see
   *  src/daemon/preflight.ts's CURRENT_SCHEMA_VERSION. Mirrors
   *  src/config/deployment-config.ts's LaunchProfileSchema field of the same name. */
  schema_version?: number;
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

/** B-800: resolve a launch profile BY NAME from an ALREADY-LOADED deployment config's
 *  `profiles` section. Pure — takes the loaded config object (or null), never touches the
 *  filesystem itself, so it's unit-testable with no fs/process; the entrypoint (src/bin/daemon.ts)
 *  does the I/O (src/config/deployment-config.ts's loadDeploymentConfig) and passes the result in.
 *
 *  Returns null — meaning "the by-name route doesn't apply, fall back to HARMONY_DAEMON_PROFILE"
 *  — in every one of these cases: no profileName given, no deployment config loaded (absent file),
 *  the config has no `profiles` section, or `profileName` isn't a key in it. This is the load-
 *  bearing compatibility rule from the B-800 ticket: only a FULLY resolved by-name selection
 *  (config present AND name given AND found) wins; anything short of that degrades to the legacy
 *  route rather than erroring, so an existing single-profile deployment is unaffected by a typo'd
 *  or half-configured --profile flag it doesn't even need to pass. */
export function selectNamedProfile(
  deploymentConfig: DeploymentConfig | null,
  profileName: string | undefined,
): LaunchProfileConfig | null {
  if (!profileName || !deploymentConfig) return null;
  return deploymentConfig.profiles?.[profileName] ?? null;
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

export interface LoadDaemonConfigOptions {
  /** B-800: an already-resolved, already-validated profile — typically a deployment config's
   *  `profiles.<name>` entry (src/config/deployment-config.ts's LaunchProfileSchema, which already
   *  enforces the same shape this module validates below for the file-path route). When set, this
   *  WINS over HARMONY_DAEMON_PROFILE entirely — the file-path route is not even consulted. The
   *  caller (src/bin/daemon.ts) decides precedence; this module just does what it's told. */
  profileOverride?: LaunchProfile;
}

export function loadDaemonConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
  opts: LoadDaemonConfigOptions = {},
): DaemonConfig {
  let profile: Partial<LaunchProfile>;

  if (opts.profileOverride) {
    // B-800: selected by name from a deployment config's `profiles` section — already validated
    // by DeploymentConfigSchema's LaunchProfileSchema (src/config/deployment-config.ts), so no
    // re-validation here. The legacy HARMONY_DAEMON_PROFILE env var is deliberately NOT consulted
    // in this branch, even if set — the caller already established precedence.
    profile = opts.profileOverride;
  } else {
    // Legacy, unchanged: a standalone profile JSON file named by HARMONY_DAEMON_PROFILE.
    const profilePath = envValue(env, 'HARMONY_DAEMON_PROFILE');
    if (!profilePath) {
      throw new Error(
        'No launch profile resolved: select one BY NAME from a deployment config via ' +
          '--config <path> --profile <name> (src/config/deployment-config.ts\'s "profiles" ' +
          'section), or set HARMONY_DAEMON_PROFILE to a standalone launch-profile JSON path ' +
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
    profile = parsed as Partial<LaunchProfile>;
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
    // B-801: mirrors src/config/deployment-config.ts's LaunchProfileSchema validation for the same
    // three optional fields — kept in lockstep (schema-parity test in config.test.ts).
    if (profile.required_tools !== undefined) {
      const rt = profile.required_tools;
      if (typeof rt !== 'object' || rt === null || Array.isArray(rt)) {
        throw new Error(
          `launch profile ${profilePath}'s "required_tools", when present, must be an object of ` +
            '{ launch?, reap?, probe? } string arrays',
        );
      }
      for (const key of ['launch', 'reap', 'probe'] as const) {
        const tools = (rt as Record<string, unknown>)[key];
        if (tools === undefined) continue;
        if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string' || t.length === 0)) {
          throw new Error(
            `launch profile ${profilePath}'s "required_tools.${key}", when present, must be an ` +
              'array of non-empty tool names',
          );
        }
      }
    }
    if (profile.requires_app_mint !== undefined && typeof profile.requires_app_mint !== 'boolean') {
      throw new Error(
        `launch profile ${profilePath}'s "requires_app_mint", when present, must be a boolean`,
      );
    }
    if (
      profile.schema_version !== undefined &&
      (!Number.isInteger(profile.schema_version) || profile.schema_version < 1)
    ) {
      throw new Error(
        `launch profile ${profilePath}'s "schema_version", when present, must be a positive integer`,
      );
    }
  }

  // Both branches above guarantee launch/reap are non-empty strings by this point (validated
  // directly for the file-path route; guaranteed by DeploymentConfigSchema for profileOverride) —
  // this assertion just tells TS what the runtime checks already ensure.
  const validatedProfile = profile as LaunchProfile;

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
      validatedProfile.maxConcurrentWorkers ?? 3,
    ),
    readyAgeMs: envMs(env, 'HARMONY_DAEMON_READY_AGE_MS', 600_000),
    profile: {
      launch: validatedProfile.launch,
      reap: validatedProfile.reap,
      probe: validatedProfile.probe,
      maxConcurrentWorkers: validatedProfile.maxConcurrentWorkers,
      // B-801: carried through so src/daemon/preflight.ts's boot preflight (called with this
      // DaemonConfig's own `profile`) sees them on BOTH the named-profile and legacy file-path
      // routes.
      required_tools: validatedProfile.required_tools,
      requires_app_mint: validatedProfile.requires_app_mint,
      schema_version: validatedProfile.schema_version,
    },
    logPath: envValue(env, 'HARMONY_DAEMON_LOG'),
  };
}

/** Substitute {conduction_id} / {ticket} / {run_config_json} into a profile template. An unknown
 *  {placeholder} throws LOUDLY — a template typo must never reach the shell as a literal brace
 *  token. Plain shell syntax ($HOME etc.) passes through untouched.
 *
 *  B-718: {run_config_json} carries the conduction row's `run_config` payload so a per-conduction
 *  `run_config.session_resume` (and, as of B-743, `run_config.note`) value reaches the worker via
 *  the launch template's `--run-config` argument, replacing the hardcoded `'{}'` every launch
 *  profile used before this ticket. B-743: the value is base64-encoded JSON.stringify output (see
 *  src/daemon/scheduler.ts's runConfigJsonFor) — encoded upstream of every launch template so the
 *  single-quoted shell literal every profile wraps it in only ever sees the base64 alphabet, never
 *  raw JSON text. Optional in `vars`: a caller that never renders a template referencing
 *  {run_config_json} (e.g. the reap/probe templates) need not supply it. */
export function renderTemplate(
  tpl: string,
  vars: { conduction_id: string; ticket: string; run_config_json?: string },
): string {
  return tpl.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    if (name === 'conduction_id') return vars.conduction_id;
    if (name === 'ticket') return vars.ticket;
    if (name === 'run_config_json' && vars.run_config_json !== undefined) return vars.run_config_json;
    throw new Error(
      `unknown placeholder {${name}} in launch-profile template — supported: {conduction_id}, ` +
        `{ticket}, {run_config_json}`,
    );
  });
}
