// B-1501: the MCP server's start-up auth, through the shared resolver (src/config/project-resolution.ts):
// HARMONY_API_TOKEN, else HARMONY_PROJECT naming a stored project. Kept out of src/index.ts so it can be
// tested without starting a server.
import { HarmonyAuth } from './auth.js';
import { resolveProject, type ResolvedProject } from './config/project-resolution.js';
import type { HarmonyConfig } from './cli/config.js';

export function resolveMcpAuth(
  env: NodeJS.ProcessEnv = process.env,
  loadConfig?: () => HarmonyConfig,
): { auth: HarmonyAuth; resolved: ResolvedProject } {
  const resolved = resolveProject({ surface: 'mcp', env, loadConfig });
  // An environment token keeps today's lazy, per-call environment pair (target is null for it).
  const auth = new HarmonyAuth(resolved.token, resolved.target?.url, resolved.target?.anonKey, {
    expectedProjectId: resolved.expectedProjectId,
    expectedLabel: resolved.expectedLabel,
  });
  return { auth, resolved };
}
