import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadDeploymentConfig } from '../config/deployment-config.js';
import {
  getAutoApproveGates,
  getConductionId,
  getOperatorNote,
  getRunConfig,
  resolveRunConfigFromConduction,
  type RunConfig,
} from '../config/run-config.js';

// Which backend the plugin is talking to, surfaced via get_project so a session can
// confirm its code + DB pairing (the staging-channel dogfood check — see B-488).
export interface EnvironmentInfo {
  supabase_url: string;
  supabase_project_ref: string;
  target: 'prod' | 'staging' | 'custom';
  plugin_version: string | null;
  /** B-743: this session's conduction id (HARMONY_CONDUCTION_ID), when running as a conducted
   *  worker leg — `null` outside a conduction (an interactive human session, or an MCP server the
   *  daemon never launched). Read via src/config/run-config.ts's getConductionId — the SAME
   *  accessor the worker-side run_config plumbing already uses, never a re-parsed duplicate. */
  conduction_id: string | null;
  /** B-743: this leg's `run_config.note` (the operator's free-text steering instruction posted
   *  from the Conduct dialog's "Run options" surface), when present — `null` when absent OR when
   *  the run_config payload can't be read/decoded/parsed. Best-effort by construction (matches
   *  this file's non-throwing-by-design posture below): a malformed run_config must never break
   *  get_project, the ONE call every conductor run makes before anything else.
   *
   *  B-892: sourced from the CONDUCTION ROW (`conductions.run_config`, re-read live) when a
   *  `conduction_id` and a Supabase client are both available, so an operator's mid-conduction edit
   *  reaches the next gate boundary; the frozen launch-env payload is the FALLBACK. */
  operator_note: string | null;
  /** B-773: this leg's `run_config.auto_approve_gates` (the operator's per-run, per-gate
   *  auto-approve override — see `src/config/run-config.ts`'s `getAutoApproveGates`), as a plain
   *  string array — `null` when absent/empty OR when the run_config payload can't be read/decoded/
   *  parsed. Same best-effort, degrade-to-null-never-throw convention as `operator_note` above, and
   *  the same B-892 row-first sourcing: this field is re-read at EVERY gate boundary alongside
   *  `conduction_id`/`operator_note` (the conduct loop now calls `get_project` per iteration, not
   *  once per run) and CAN change mid-run — see `skills/harmony-conduct/SKILL.md` §1b. */
  auto_approve_gates: string[] | null;
}

// Must mirror src/supabase.ts exactly: env override, else the prod project.
const DEFAULT_SUPABASE_URL = 'https://eioxsunvhakmelhanmnn.supabase.co';

// The two Supabase projects this workspace deploys to; anything else is 'custom'. B-800: a
// deployment config's launcher.supabase_refs is MERGED OVER these (never replaces them), so the
// two real projects stay recognized with zero config present, and a deployment can add its own.
const KNOWN_REFS: Record<string, 'prod' | 'staging'> = {
  eioxsunvhakmelhanmnn: 'prod',
  meqkdgncdzromunylyxf: 'staging', // staging.harmony.ad's deployed project
};

// B-800: non-throwing by construction — resolveEnvironment must never break get_project over a
// missing/malformed deployment config, so any load failure degrades to "no extra refs" silently.
function resolveKnownRefs(env: NodeJS.ProcessEnv): Record<string, 'prod' | 'staging'> {
  try {
    const deploymentConfig = loadDeploymentConfig({ env });
    const configRefs = deploymentConfig?.launcher?.supabase_refs;
    return configRefs ? { ...KNOWN_REFS, ...configRefs } : KNOWN_REFS;
  } catch {
    return KNOWN_REFS;
  }
}

function readManifestVersion(manifestPath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

// Locate .claude-plugin/plugin.json: prefer $CLAUDE_PLUGIN_ROOT (set by Claude Code for the
// installed plugin), else walk up from the running module — the bundle lives at dist/index.js
// (manifest one level up) or dist/bin/harmony.js (two levels up). Returns null when unreadable.
function resolvePluginVersion(env: NodeJS.ProcessEnv, moduleUrl: string): string | null {
  const root = env.CLAUDE_PLUGIN_ROOT;
  if (root) {
    const version = readManifestVersion(join(root, '.claude-plugin', 'plugin.json'));
    if (version !== null) return version;
  }
  try {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 3; i++) {
      dir = dirname(dir);
      const version = readManifestVersion(join(dir, '.claude-plugin', 'plugin.json'));
      if (version !== null) return version;
    }
  } catch {
    // Non-file module URL or unresolvable path — degrade to null below.
  }
  return null;
}

// B-892: the launch-env run_config payload, or null when there is none / it is unreadable. Split
// out of resolveEnvironment so the row-first precedence below reads as ONE `??` rather than two
// duplicated try/catch blocks. Best-effort — getRunConfig throws on a malformed
// HARMONY_RUN_CONFIG_PATH/JSON payload (by design, for its own direct worker-side callers), but
// THIS path must degrade instead: get_project is the first call every conductor run makes, and it
// must never break over a corrupt run_config the run can't do anything about anyway (B-743).
function readEnvRunConfig(env: NodeJS.ProcessEnv): RunConfig | null {
  try {
    return getRunConfig(env);
  } catch {
    return null;
  }
}

/** Non-throwing by design: environment info is diagnostic and must never break get_project.
 *
 *  B-892 — ASYNC as of this ticket (it was synchronous through B-773). `operator_note` and
 *  `auto_approve_gates` are now resolved from the LIVE `conductions.run_config` row whenever this
 *  session has both a `conduction_id` and a Supabase `client`, so an operator's mid-conduction edit
 *  reaches the running leg at its next gate boundary instead of being frozen at launch. The row is
 *  preferred WHOLE (not merged key-by-key): a successful read of a row whose payload no longer
 *  carries a `note` correctly clears the note, which a per-key merge could never express. The frozen
 *  launch-env payload is the fallback whenever there is no conduction id, no client, or the row is
 *  missing/unreadable/malformed — so every non-conducted caller behaves exactly as before.
 *
 *  `client` is optional and last so existing positional callers (env, moduleUrl) are unchanged. */
export async function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
  client?: SupabaseClient | null,
): Promise<EnvironmentInfo> {
  const supabase_url = env.HARMONY_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;

  let supabase_project_ref = '';
  try {
    supabase_project_ref = new URL(supabase_url).hostname.split('.')[0] ?? '';
  } catch {
    // Malformed URL — leave the ref empty and fall through to 'custom'.
  }

  const conduction_id = getConductionId(env) ?? null;

  // B-892: the row first, the launch env as fallback. resolveRunConfigFromConduction never throws
  // and returns null on ANY failure, so this whole expression preserves the degrade-to-null,
  // never-throw contract get_project depends on.
  const runConfig =
    (await resolveRunConfigFromConduction(client, conduction_id)) ?? readEnvRunConfig(env);

  // B-743 / B-773: same best-effort degrade-to-null convention on the accessors themselves — a
  // malformed run_config must never break get_project.
  let operator_note: string | null = null;
  let auto_approve_gates: string[] | null = null;
  if (runConfig) {
    try {
      operator_note = getOperatorNote(runConfig) ?? null;
    } catch {
      operator_note = null;
    }
    try {
      const gates = Array.from(getAutoApproveGates(runConfig));
      auto_approve_gates = gates.length > 0 ? gates : null;
    } catch {
      auto_approve_gates = null;
    }
  }

  return {
    supabase_url,
    supabase_project_ref,
    target: resolveKnownRefs(env)[supabase_project_ref] ?? 'custom',
    plugin_version: resolvePluginVersion(env, moduleUrl),
    conduction_id,
    operator_note,
    auto_approve_gates,
  };
}
