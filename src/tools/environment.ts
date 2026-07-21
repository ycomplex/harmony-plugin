import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Which backend the plugin is talking to, surfaced via get_project so a session can
// confirm its code + DB pairing (the staging-channel dogfood check — see B-488).
export interface EnvironmentInfo {
  supabase_url: string;
  supabase_project_ref: string;
  target: 'prod' | 'staging' | 'custom';
  plugin_version: string | null;
}

// Must mirror src/supabase.ts exactly: env override, else the prod project.
const DEFAULT_SUPABASE_URL = 'https://eioxsunvhakmelhanmnn.supabase.co';

// The two Supabase projects this workspace deploys to; anything else is 'custom'.
const KNOWN_REFS: Record<string, 'prod' | 'staging'> = {
  eioxsunvhakmelhanmnn: 'prod',
  meqkdgncdzromunylyxf: 'staging', // staging.harmony.ad's deployed project
};

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

  return {
    supabase_url,
    supabase_project_ref,
    target: KNOWN_REFS[supabase_project_ref] ?? 'custom',
    plugin_version: resolvePluginVersion(env, moduleUrl),
  };
}
