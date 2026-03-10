const SUPABASE_URL = 'https://lhgljwwetammvsngmbic.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxoZ2xqd3dldGFtbXZzbmdtYmljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxOTEwNDAsImV4cCI6MjA4Nzc2NzA0MH0.-UDqB58fweVwbfQMT6hUMo9nrpcj2ZfKzTvBhv2NeLc';

interface TokenExchangeResult {
  access_token: string;
  expires_in: number;
  project_id: string;
}

export class HarmonyAuth {
  private apiToken: string;
  private accessToken: string | null = null;
  private projectId: string | null = null;
  private expiresAt: number = 0;

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

  getProjectId(): string {
    if (!this.projectId) throw new Error('Not authenticated yet. Call getAccessToken() first.');
    return this.projectId;
  }

  private async exchange(): Promise<void> {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ token: this.apiToken }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `Token exchange failed (${res.status})`);
    }

    const data: TokenExchangeResult = await res.json();
    this.accessToken = data.access_token;
    this.projectId = data.project_id;
    this.expiresAt = Date.now() + data.expires_in * 1000;
  }
}
