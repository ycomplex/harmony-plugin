import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDeploymentConfig } from '../config/deployment-config.js';
import { getConductionId, getOperatorNote, getRunConfig } from '../config/run-config.js';

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
   *  get_project, the ONE call every conductor run makes before anything else. */
  operator_note: string | null;
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

// Non-throwing by design: environment info is diagnostic and must never break get_project.
export function resolveEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  moduleUrl: string = import.meta.url,
): EnvironmentInfo {
  const supabase_url = env.HARMONY_SUPABASE_URL ?? DEFAULT_SUPABASE_URL;

  let supabase_project_ref = '';
  try {
    supabase_project_ref = new URL(supabase_url).hostname.split('.')[0] ?? '';
  } catch {
    // Malformed URL — leave the ref empty and fall through to 'custom'.
  }

  // B-743: best-effort — getRunConfig throws on a malformed HARMONY_RUN_CONFIG_PATH/JSON payload
  // (by design, for its own direct worker-side callers), but THIS accessor must degrade instead:
  // get_project is the first call every conductor run makes, and it must never break over a
  // corrupt run_config the run can't do anything about anyway.
  let operator_note: string | null;
  try {
    operator_note = getOperatorNote(getRunConfig(env)) ?? null;
  } catch {
    operator_note = null;
  }

  return {
    supabase_url,
    supabase_project_ref,
    target: resolveKnownRefs(env)[supabase_project_ref] ?? 'custom',
    plugin_version: resolvePluginVersion(env, moduleUrl),
    conduction_id: getConductionId(env) ?? null,
    operator_note,
  };
}
