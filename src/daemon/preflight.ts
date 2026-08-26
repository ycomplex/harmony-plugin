// B-801: boot preflight — validate the daemon's whole deployment surface BEFORE any conduction can
// run, so config drift degrades loudly (hard exit) or is at least NAMED (soft audit) instead of
// failing mid-conduction, hours later. Two real incidents motivated this: a missing `gcloud` on
// PATH burned the daemon's full retry ladder before it ever ran a real command (exit 127, the first
// cloud-profile start), and a profile file missing the `probe` key silently disabled mid-leg
// re-attach for two days with zero signal. Both are cases the daemon already HAD the data to catch
// at boot — it just never looked at it closely enough.
//
// Pure + injectable (runCommand/env/log), mirrors src/config/deployment-config.ts's
// LoadDeploymentConfigOptions / src/daemon/config.ts's loadDaemonConfig style — no real PATH/fs
// access happens in this module, so the whole thing is unit-testable with fakes. src/bin/daemon.ts's
// main() is the one real caller: it runs this right after loadDaemonConfig resolves the active
// profile and BEFORE HarmonyAuth/createAuthenticatedClient/runScheduler — nothing ticket-related
// runs until the deployment surface has been validated.
//
// Three checks, all derived from data the daemon already loads — no new I/O surface added here:
//   1. Tool resolution (hard) — every binary a profile's `required_tools` names must resolve on
//      PATH, checked via `command -v <tool>` through the SAME runCommand instance
//      src/bin/daemon.ts wires into SchedulerDeps (reusing the scheduler's existing injectable exec
//      shape rather than adding a second one).
//   2. Env contract (hard) — when the profile mints a worker credential (`requires_app_mint`), the
//      four launcher-host vars that mint depends on must resolve (env var, or the B-800 deployment
//      config's `launcher.github_app`/`launcher.plugin_dir`, whichever the loader already wires —
//      no NEW wiring is added by this check). HARMONY_API_TOKEN is already hard-checked earlier in
//      src/bin/daemon.ts's main() — deliberately not duplicated here.
//   3. Profile capability audit (soft, never throws) — one line per ABSENT optional capability,
//      naming its concrete consequence, so a config gap is visible at boot instead of silent.
//
// Hard misses THROW (mirrors loadDeploymentConfig/loadDaemonConfig's own "malformed config fails
// loud, not silently" convention) — src/bin/daemon.ts's main() catches and process.exit(1)s, the
// same way it already does around loadDaemonConfig.

import type { DaemonConfig, RequiredTools } from './config.js';
import type { DeploymentConfig } from '../config/deployment-config.js';

/** Superset of both LaunchProfile (src/daemon/config.ts, the legacy file-path route) and
 *  LaunchProfileConfig (src/config/deployment-config.ts, the B-800 named-profile route) — either is
 *  structurally assignable here, so callers on both routes can pass their resolved profile straight
 *  through. `gcloud_project` lives ONLY on the deployment-config side (the cloud wrapper scripts
 *  read it there directly via `harmony config get`, never through the daemon's own LaunchProfile) —
 *  src/bin/daemon.ts's main() folds it in from the resolved named profile, when one was used,
 *  before calling this module. */
export interface PreflightProfile {
  launch: string;
  reap: string;
  probe?: string;
  maxConcurrentWorkers?: number;
  required_tools?: RequiredTools;
  requires_app_mint?: boolean;
  schema_version?: number;
  gcloud_project?: string;
}

/** The exact shape src/daemon/scheduler.ts's SchedulerDeps.runCommand already has — reused rather
 *  than adding a second exec path. Preflight calls it as `command -v <tool>`; exit code 0 = found.
 *  This declared type is narrower than the real runCommand's (which also accepts an optional
 *  `quietRender` — B-740) DELIBERATELY: preflight always calls with `{ quiet: true }` alone (never a
 *  `quietRender`), so a passing tool check logs nothing — see quiet-reap.ts's `quietLogLine`. The
 *  narrower type here is still assignable from the real (wider-accepting) runCommand closure. */
export type RunCommand = (
  cmd: string,
  opts?: { quiet?: boolean },
) => Promise<{ exitCode: number | null }>;

export interface RunBootPreflightOpts {
  /** Reuses SchedulerDeps.runCommand's shape — src/bin/daemon.ts moves its `runCommand` closure
   *  definition earlier in main() (right after `log`) so the SAME instance backs both this call and
   *  the later SchedulerDeps, rather than standing up a second exec path. */
  runCommand: RunCommand;
  env: Record<string, string | undefined>;
  /** The already-loaded deployment config (or null) — src/bin/daemon.ts already loaded this once to
   *  resolve the named profile; passed straight through, never re-read here. Consulted only by the
   *  env-contract check's launcher.github_app / launcher.plugin_dir fallback resolution. */
  deploymentConfig?: DeploymentConfig | null;
  /** Display name for hard-miss/soft-audit messages: the --profile name on the B-800 named route, or
   *  a caller-chosen label (e.g. the HARMONY_DAEMON_PROFILE path) on the legacy route. */
  profileName: string;
  /** Sink for the soft-audit lines (check 3) — never called for a hard miss (those throw instead). */
  log: (line: string) => void;
}

const LAUNCHD_PATH_HINT =
  "Note: launchd inherits a minimal PATH — add the SDK's bin dir to the plist's " +
  'EnvironmentVariables PATH key.';

/** B-801: bump whenever a NEW optional profile capability ships, and add an entry below naming what
 *  it added — the soft audit (check 3) uses this to flag a profile whose `schema_version` is stale
 *  (a profile file written before an upgrade, never regenerated, silently lacking the new
 *  capability). This ticket IS version 1 — the entry below is this ticket's own two additions, so
 *  the flag is inert today except against a profile that explicitly declares a version below 1; it
 *  is the scaffolding the next optional-capability ticket extends. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Capabilities introduced AT each schema_version, keyed by the version they first shipped in. */
const CAPABILITIES_BY_VERSION: Record<number, string[]> = {
  1: ['required_tools', 'requires_app_mint'],
};

/** Every optional capability added in a version strictly greater than `schemaVersion`, up through
 *  CURRENT_SCHEMA_VERSION — the list a stale-schema_version soft-audit line names. */
function capabilitiesAddedSince(schemaVersion: number): string[] {
  const added: string[] = [];
  for (let v = schemaVersion + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
    added.push(...(CAPABILITIES_BY_VERSION[v] ?? []));
  }
  return added;
}

/** B-694 empty-value shadow class, mirrors src/daemon/config.ts's own (unexported) envValue: an env
 *  var set to '' must behave exactly like unset. */
function resolvedEnv(env: Record<string, string | undefined>, key: string): string | undefined {
  const v = env[key];
  return v == null || v === '' ? undefined : v;
}

const APP_MINT_VARS = [
  'HARMONY_APP_ID',
  'HARMONY_APP_INSTALLATION_ID',
  'HARMONY_APP_PRIVATE_KEY_PATH',
  'HARMONY_PLUGIN_DIR',
] as const;
type AppMintVar = (typeof APP_MINT_VARS)[number];

/** The env-contract check's "RESOLVED value" — env var OR the matching B-800 deployment-config
 *  launcher field, whichever the loader already wires (see container/migrate-to-deployment-config.md
 *  for why these are, today, documented facts on the launcher.* side rather than auto-injected env —
 *  this check honors BOTH sources without adding any new wiring). */
function resolveLauncherVar(
  varName: AppMintVar,
  env: Record<string, string | undefined>,
  deploymentConfig: DeploymentConfig | null | undefined,
): string | undefined {
  const fromEnv = resolvedEnv(env, varName);
  if (fromEnv !== undefined) return fromEnv;
  const launcher = deploymentConfig?.launcher;
  switch (varName) {
    case 'HARMONY_APP_ID':
      return launcher?.github_app?.app_id || undefined;
    case 'HARMONY_APP_INSTALLATION_ID':
      return launcher?.github_app?.installation_id || undefined;
    case 'HARMONY_APP_PRIVATE_KEY_PATH':
      return launcher?.github_app?.private_key_path || undefined;
    case 'HARMONY_PLUGIN_DIR':
      return launcher?.plugin_dir || undefined;
  }
}

const TEMPLATE_KEYS = ['launch', 'reap', 'probe'] as const;

/** Validate the daemon's whole deployment surface at boot. Throws on the first HARD miss (tool
 *  resolution or env contract) — src/bin/daemon.ts's main() catches and process.exit(1)s. Never
 *  throws for the soft capability audit; those lines go through `opts.log` and boot continues.
 *
 *  `config` is the already-resolved DaemonConfig (accepted for call-site symmetry with
 *  loadDaemonConfig's return shape / room for a future daemon-wide check) — every check in THIS
 *  ticket derives entirely from `profile`. */
export async function runBootPreflight(
  config: DaemonConfig,
  profile: PreflightProfile,
  opts: RunBootPreflightOpts,
): Promise<void> {
  void config;

  // 1. Tool resolution (hard) ---------------------------------------------------------------------
  for (const templateKey of TEMPLATE_KEYS) {
    const tools = profile.required_tools?.[templateKey] ?? [];
    for (const tool of tools) {
      const result = await opts.runCommand(`command -v ${tool}`, { quiet: true });
      if (result.exitCode !== 0) {
        throw new Error(
          `Missing required tool "${tool}" (invoked by profile "${opts.profileName}"'s ` +
            `"${templateKey}" template) — not found on PATH.\n${LAUNCHD_PATH_HINT}`,
        );
      }
    }
  }

  // 2. Env contract (hard) -------------------------------------------------------------------------
  if (profile.requires_app_mint) {
    for (const varName of APP_MINT_VARS) {
      const value = resolveLauncherVar(varName, opts.env, opts.deploymentConfig);
      if (value === undefined) {
        throw new Error(
          `Missing required launcher-host config "${varName}" — see container/README.md ` +
            '§ The credential envelopes.',
        );
      }
    }
  }

  // 3. Profile capability audit (soft, never throws) -----------------------------------------------
  if (!profile.probe) {
    opts.log(
      `Note: profile "${opts.profileName}" has no "probe" template — mid-leg re-attach disabled; ` +
        'takeovers will reap-and-refire running workers.',
    );
  }
  if (!profile.required_tools) {
    opts.log(
      `Note: profile "${opts.profileName}" has no "required_tools" — tool-on-PATH preflight ` +
        'skipped for this profile; a missing binary will fail mid-conduction instead of at boot.',
    );
  }
  const namesGcloud = TEMPLATE_KEYS.some((k) =>
    (profile.required_tools?.[k] ?? []).includes('gcloud'),
  );
  if (!profile.gcloud_project && namesGcloud) {
    opts.log(
      `Note: profile "${opts.profileName}" has no "gcloud_project" — cloud-worker-*.sh falls back ` +
        'to its own CLOUDSDK_CORE_PROJECT default.',
    );
  }
  const schemaVersion = profile.schema_version ?? CURRENT_SCHEMA_VERSION;
  if (schemaVersion < CURRENT_SCHEMA_VERSION) {
    const added = capabilitiesAddedSince(schemaVersion);
    opts.log(
      `Note: profile "${opts.profileName}"'s schema_version (${schemaVersion}) is behind the ` +
        `current schema version (${CURRENT_SCHEMA_VERSION}) — capabilities added since: ` +
        `${added.join(', ')}.`,
    );
  }
}
