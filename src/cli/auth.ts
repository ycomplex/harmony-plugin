import { redactFigmaMessage } from "./figma-errors.js";
import type { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth, TokenExchangeError } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import type { ProjectConfig } from './config.js';
import { overrideNotice, resolveProject } from '../config/project-resolution.js';
import { resolveSupabaseTarget } from './resolve-supabase-target.js';

export interface AuthenticatedContext {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}

// B-1070: print the "using HARMONY_API_TOKEN" fallback notice at most once per process — repeated
// CLI calls within the same run (or the same long-lived daemon process) share one config-less
// session and shouldn't re-announce it on every call. B-1501: the same once-per-process rule covers
// the override line (an environment token or HARMONY_PROJECT winning over a different active project).
let fallbackNoticePrinted = false;

/** Test hook: let a test see the once-per-process notice again. */
export function resetAuthNoticesForTest(): void {
  fallbackNoticePrinted = false;
}

export async function getAuthenticatedContext(projectConfig?: ProjectConfig): Promise<AuthenticatedContext> {
  let project: ProjectConfig;
  let usedFallback = false;
  let target: { url: string; anonKey: string };
  let expected: { expectedProjectId?: string; expectedLabel?: string } = {};

  if (projectConfig) {
    project = projectConfig;
    target = resolveSupabaseTarget({ flags: {}, project });
  } else {
    // B-1501: ONE resolver for the CLI and the MCP server (src/config/project-resolution.ts):
    // HARMONY_API_TOKEN, then HARMONY_PROJECT, then the active project. Before B-1501 the CLI
    // preferred the active project over the environment; the environment now wins, and says so once.
    //
    // B-1025: the Supabase pair is resolved per call, by name, and handed to the auth instance —
    // never written into process.env (the auth module used to capture it at import).
    const resolved = resolveProject({ surface: 'cli' });
    usedFallback = resolved.source === 'env-token';
    project = resolved.project ?? { name: '(env token)', token: resolved.token };
    target = resolved.target ?? resolveSupabaseTarget({ flags: {}, project: undefined });
    expected = { expectedProjectId: resolved.expectedProjectId, expectedLabel: resolved.expectedLabel };
    if (!fallbackNoticePrinted) {
      const notice = overrideNotice(resolved) ??
        (usedFallback && !resolved.activeProject ? 'harmony: using HARMONY_API_TOKEN (no active project configured)' : null);
      if (notice) {
        console.error(notice);
        fallbackNoticePrinted = true;
      }
    }
  }

  const auth = new HarmonyAuth(project.token, target.url, target.anonKey, expected);
  let client: SupabaseClient;
  try {
    client = await createAuthenticatedClient(auth);
  } catch (err) {
    if (usedFallback) {
      if (err instanceof TokenExchangeError) {
        throw new Error(`HARMONY_API_TOKEN is set but was rejected (HTTP ${err.status}). Check that the token is valid and has not been revoked.`, { cause: err });
      }
      let host = "unknown host";
      // B-1025: the RESOLVED target's URL — the old read of harmonyEnv() was the same freeze
      // that broke the pair, and it reported a host the call may never have reached.
      try { host = new URL(target.url).host; } catch { /* malformed URL stays credential-free */ }
      const cause = err instanceof Error ? err.cause as {code?: unknown; message?: unknown} | undefined : undefined;
      const detail = [cause?.code, cause?.message].filter(v => typeof v === "string").join(": ");
      const message = redactFigmaMessage(err instanceof Error ? err.message : "Network request failed", [project.token]);
      const safeDetail = redactFigmaMessage(detail, [project.token]);
      throw new Error(`Could not reach Harmony to validate HARMONY_API_TOKEN: ${message} (host: ${host}${safeDetail ? "; cause: " + safeDetail : ""})`, { cause: err });
    }
    throw err;
  }
  const projectId = auth.getProjectId();
  const userId = auth.getUserId();

  return { client, projectId, userId };
}
