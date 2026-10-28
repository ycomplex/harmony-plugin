import { redactFigmaMessage } from "./figma-errors.js";
import type { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth, TokenExchangeError } from '../auth.js';
import { createAuthenticatedClient } from '../supabase.js';
import { getActiveProject, ProjectConfig } from './config.js';
import { harmonyEnv } from '../env.js';

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
      project = {
        name: '(env token)',
        token,
        supabaseUrl: harmonyEnv('HARMONY_SUPABASE_URL'),
        supabaseAnonKey: harmonyEnv('HARMONY_SUPABASE_ANON_KEY'),
      };
      usedFallback = true;
    }
  }

  // Set env vars if the project has custom Supabase config
  if (project.supabaseUrl) {
    process.env.HARMONY_SUPABASE_URL = project.supabaseUrl;
  }
  if (project.supabaseAnonKey) {
    process.env.HARMONY_SUPABASE_ANON_KEY = project.supabaseAnonKey;
  }

  if (usedFallback && !fallbackNoticePrinted) {
    console.error('harmony: using HARMONY_API_TOKEN (no active project configured)');
    fallbackNoticePrinted = true;
  }

  const auth = new HarmonyAuth(project.token);
  let client: SupabaseClient;
  try {
    client = await createAuthenticatedClient(auth);
  } catch (err) {
    if (usedFallback) {
      if (err instanceof TokenExchangeError) {
        throw new Error(`HARMONY_API_TOKEN is set but was rejected (HTTP ${err.status}). Check that the token is valid and has not been revoked.`, { cause: err });
      }
      let host = "unknown host";
      try { host = new URL(harmonyEnv('HARMONY_SUPABASE_URL') ?? 'https://eioxsunvhakmelhanmnn.supabase.co').host; } catch { /* malformed URL stays credential-free */ }
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
