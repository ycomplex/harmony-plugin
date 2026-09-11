const SUPABASE_URL = process.env.HARMONY_SUPABASE_URL ?? 'https://eioxsunvhakmelhanmnn.supabase.co';
const SUPABASE_ANON_KEY = process.env.HARMONY_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpb3hzdW52aGFrbWVsaGFubW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDY3NjksImV4cCI6MjA5MDIyMjc2OX0.SdbpfqRhcB21qWs6XnD6Lsj6AGX2b6tOGV3pg2iJjsw';

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

  constructor(apiToken: string) {
    this.apiToken = apiToken;
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
      res = await fetch(`${SUPABASE_URL}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
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
    this.accessToken = data.access_token;
    this.projectId = data.project_id;
    this.expiresAt = Date.now() + data.expires_in * 1000;

    // Extract user ID from JWT payload (sub claim)
    const payloadB64 = data.access_token.split('.')[1];
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    this.userId = payload.sub;
  }
}
