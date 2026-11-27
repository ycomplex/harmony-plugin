// B-1522: the conduct watch's (src/bin/poll.ts) start-up auth, through the shared B-1501 resolver.
//
// Since B-1501 `/harmony-setup` writes only HARMONY_PROJECT (naming a project stored in
// ~/.harmony/config.json), so a watch that read HARMONY_API_TOKEN alone exited 1 on every current setup.
// This wraps resolveMcpAuth (src/mcp-auth.ts), i.e. the resolver's MCP surface: HARMONY_API_TOKEN, else
// HARMONY_PROJECT naming a stored project, with the stored-pair backend checks. The MCP surface is chosen
// deliberately because it has NO active-project rung: a mid-watch `harmony project switch` cannot repoint
// the watch (B-532 AC2 preserved). poll.ts calls this ONCE at launch and keeps the auth for its lifetime.
//
// It never throws: a resolution failure comes back as { ok: false, message } so poll.ts can print the
// message and exit 1.
import type { HarmonyAuth } from '../auth.js';
import type { HarmonyConfig } from '../cli/config.js';
import { ProjectResolutionError } from '../config/project-resolution.js';
import { resolveMcpAuth } from '../mcp-auth.js';

export type PollAuthResult = { ok: true; auth: HarmonyAuth } | { ok: false; message: string };

export function resolvePollAuth(
  env: NodeJS.ProcessEnv = process.env,
  loadConfig?: () => HarmonyConfig,
): PollAuthResult {
  try {
    const { auth } = resolveMcpAuth(env, loadConfig);
    return { ok: true, auth };
  } catch (err) {
    if (err instanceof ProjectResolutionError) return { ok: false, message: err.message };
    if (err instanceof Error) return { ok: false, message: err.message };
    return { ok: false, message: String(err) };
  }
}
