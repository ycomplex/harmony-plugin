import { redactFigmaMessage } from "./figma-errors.js";
import type { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth, TokenExchangeError } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getActiveProject, ProjectConfig } from './config.js';
import { harmonyEnv } from '../env.js';
import { resolveSupabaseTarget } from './resolve-supabase-target.js';

export interface AuthenticatedContext {
  client: SupabaseClient;
  projectId: string;
  userId: string;
}

// B-1070: print the "using HARMONY_API_TOKEN" fallback notice at most once per process — repeated
// CLI calls within the same run (or the same long-lived daemon process) share one config-less
// session and shouldn't re-announce it on every call.
let fallbackNoticePrinted = false;

export async function getAuthenticatedContext(projectConfig?: ProjectConfig): Promise<AuthenticatedContext> {
  let project: ProjectConfig;
  let usedFallback = false;

  if (projectConfig) {
    project = projectConfig;
  } else {
    try {
      project = getActiveProject();
    } catch (configErr) {
      const token = harmonyEnv('HARMONY_API_TOKEN');
      if (!token) {
        throw configErr;
      }
      // B-1025: the pseudo-project carries the TOKEN only. The Supabase pair is resolved by the
      // resolver below, whose environment tier reads the same two variables — so the outcome is
      // unchanged, but the pair now has ONE owner instead of two half-copies.
      project = {
        name: '(env token)',
        token,
      };
      usedFallback = true;
    }
  }

  // B-1025: resolve the Supabase URL + anon key PAIR for THIS call.
  //
  // This used to write the project's stored values into process.env and let the auth module read
  // them back — but the auth module had already captured them at IMPORT time, so the mutation
  // was dead code: every CLI call was exchanged against whatever the ENVIRONMENT said, and a
  // second project's URL silently went to the first project's server (the founder's 2026-09-14
  // 401). The pair is now resolved here, by name, and handed to the auth instance explicitly.
  //
  // The fallback (no configured project) resolves through the environment tier, so it behaves
  // exactly as before.
  const target = resolveSupabaseTarget({
    flags: {},
    project: usedFallback ? undefined : project,
  });

  if (usedFallback && !fallbackNoticePrinted) {
    console.error('harmony: using HARMONY_API_TOKEN (no active project configured)');
    fallbackNoticePrinted = true;
  }

  const auth = new HarmonyAuth(project.token, target.url, target.anonKey);
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
