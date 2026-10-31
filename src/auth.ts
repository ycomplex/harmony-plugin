import { harmonyEnv } from './env.js';

/** B-1025: the built-in Supabase pair, used when no source names one.
 *
 *  These were module-level CONSTANTS until B-1025 — captured at IMPORT time, before any CLI
 *  command ran. That freeze is the defect this ticket fixes: `harmony login --supabase-url …` and
 *  an active project's stored `supabaseUrl` never reached the token exchange, because the module
 *  had already read the environment. The URL is now resolved PER CALL (see getSupabaseUrl()).
 *
 *  The URL literal mirrors `src/tools/environment.ts`'s `DEFAULT_SUPABASE_URL` — deliberately
 *  duplicated, the same tradeoff `src/config/run-config.ts` already documents, so this module
 *  stays free of the heavier environment/run-config import graph. */
export const DEFAULT_SUPABASE_URL = 'https://eioxsunvhakmelhanmnn.supabase.co';

/** B-1025: the built-in anon key. There is no shared export of this literal elsewhere — the
 *  URL was already duplicated in `src/tools/environment.ts` and `src/config/run-config.ts`, and a
 *  third copy lived as a frozen module-level read in the OLD `src/supabase.ts` (both removed in
 *  this ticket). This module is now the single source of truth for the prod baked-in pair, so a
 *  future rotate touches one line. */
export const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpb3hzdW52aGFrbWVsaGFubW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDY3NjksImV4cCI6MjA5MDIyMjc2OX0.SdbpfqRhcB21qWs6XnD6Lsj6AGX2b6tOGV3pg2iJjsw';

interface TokenExchangeResult {
  access_token: string;
  expires_in: number;
  project_id: string;
}

/** Structured token-exchange failure — carries the endpoint, HTTP status, and full response body
 *  so a caller (see src/daemon/error-format.ts) can render more than a flattened message string. */
export class TokenExchangeError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly body: unknown;

  constructor(endpoint: string, status: number, body: unknown) {
    super(`Token exchange failed (${status})`);
    this.name = 'TokenExchangeError';
    this.endpoint = endpoint;
    this.status = status;
    this.body = body;
  }
}

export class HarmonyAuth {
  private apiToken: string;
  private accessToken: string | null = null;
  private projectId: string | null = null;
  private userId: string | null = null;
  private expiresAt: number = 0;
  // B-845: single-flight guard for forceRefresh() — concurrent PGRST303 callers on ONE HarmonyAuth
  // instance must share the SAME in-flight exchange rather than each firing their own fetch(). Set
  // the moment a refresh starts, cleared on BOTH resolution and rejection (via .finally()) so a
  // failed exchange can never poison the next caller into replaying a dead promise forever.
  private inFlightRefresh: Promise<void> | null = null;
  // B-1025: the Supabase pair for THIS auth instance, when the caller resolved one explicitly
  // (the CLI's pair resolver — src/cli/resolve-supabase-target.ts). Undefined means "no explicit
  // pair": the environment (then the built-in default) supplies it, exactly as before B-1025.
  private supabaseUrl?: string;
  private supabaseAnonKey?: string;

  constructor(apiToken: string, supabaseUrl?: string, supabaseAnonKey?: string) {
    this.apiToken = apiToken;
    this.supabaseUrl = supabaseUrl;
    this.supabaseAnonKey = supabaseAnonKey;
  }

  /** B-1025: the Supabase URL for THIS call — an explicit pair wins, then the environment (read
   *  per call, so a later change is honoured), then the built-in default. */
  getSupabaseUrl(): string {
    return this.supabaseUrl ?? harmonyEnv('HARMONY_SUPABASE_URL') ?? DEFAULT_SUPABASE_URL;
  }

  /** B-1025: the Supabase anon key for THIS call — the counterpart of getSupabaseUrl(). */
  getSupabaseAnonKey(): string {
    return this.supabaseAnonKey ?? harmonyEnv('HARMONY_SUPABASE_ANON_KEY') ?? DEFAULT_SUPABASE_ANON_KEY;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
      return this.accessToken;
    }
    await this.exchange();
    return this.accessToken!;
  }

  /** B-845: force a FRESH token exchange, bypassing getAccessToken()'s cache/expiry check entirely
   *  — the caller (src/daemon/write-retry.ts's withWriteRetry) already knows the cached token was
   *  rejected (PGRST303), so replaying getAccessToken()'s cache would just hand back the same dead
   *  token. Single-flight: a second concurrent caller gets the SAME in-flight exchange, never a
   *  second fetch. This method deliberately does NOT call getAccessToken() — see the module-level
   *  design note above. */
  forceRefresh(): Promise<void> {
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.exchange().finally(() => {
        this.inFlightRefresh = null;
      });
    }
    return this.inFlightRefresh;
  }

  getProjectId(): string {
    if (!this.projectId) throw new Error('Not authenticated yet. Call getAccessToken() first.');
    return this.projectId;
  }

  getUserId(): string {
    if (!this.userId) throw new Error('Not authenticated yet. Call getAccessToken() first.');
    return this.userId;
  }

  private async exchange(): Promise<void> {
    const endpoint = '/functions/v1/auth-token';
    let res: Response;
    try {
      res = await fetch(`${this.getSupabaseUrl()}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.getSupabaseAnonKey()}`,
        },
        body: JSON.stringify({ token: this.apiToken }),
      });
    } catch (err) {
      // B-845: a raw fetch() rejection (DNS/ECONNREFUSED/TLS/etc) carries no endpoint of its own —
      // tag it here, mirroring TokenExchangeError's endpoint field, so a caller (formatDaemonError's
      // Rule 2) can render WHICH call failed instead of a bare "TypeError: fetch failed". The
      // original error (and its `.cause` chain) is otherwise untouched and rethrown as-is.
      if (err instanceof Error) {
        (err as Error & { endpoint?: string }).endpoint = endpoint;
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new TokenExchangeError(endpoint, res.status, body);
    }

    const data: TokenExchangeResult = await res.json();

    // Extract user ID from JWT payload (sub claim)
    const payloadB64 = data.access_token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    // B-266: the exchange now mints a `project_id` claim the database honours (RLS confines the JWT
    // to that one project), so the claim — not the response body — is the authoritative project pin.
    // A body that names a different project than the claim is a broken exchange, never something to
    // trust either half of; refuse it before any tool runs. A claim-less JWT (an auth-token function
    // deployed before B-266) keeps the pre-B-266 body pin unchanged, so the plugin works against both.
    const claimedProject = typeof payload.project_id === 'string' ? payload.project_id : null;
    if (claimedProject && data.project_id && claimedProject !== data.project_id) {
      throw new Error(
        `Token exchange returned a JWT scoped to project ${claimedProject} but a body naming project ${data.project_id}; refusing to use either.`,
      );
    }

    this.accessToken = data.access_token;
    this.projectId = claimedProject ?? data.project_id;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    this.userId = payload.sub;
  }
}
