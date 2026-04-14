const SUPABASE_URL = process.env.HARMONY_SUPABASE_URL ?? 'https://eioxsunvhakmelhanmnn.supabase.co';
const SUPABASE_ANON_KEY = process.env.HARMONY_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpb3hzdW52aGFrbWVsaGFubW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDY3NjksImV4cCI6MjA5MDIyMjc2OX0.SdbpfqRhcB21qWs6XnD6Lsj6AGX2b6tOGV3pg2iJjsw';
export class HarmonyAuth {
    apiToken;
    accessToken = null;
    projectId = null;
    userId = null;
    expiresAt = 0;
    constructor(apiToken) {
        this.apiToken = apiToken;
    }
    async getAccessToken() {
        if (this.accessToken && Date.now() < this.expiresAt - 60_000) {
            return this.accessToken;
        }
        await this.exchange();
        return this.accessToken;
    }
    getProjectId() {
        if (!this.projectId)
            throw new Error('Not authenticated yet. Call getAccessToken() first.');
        return this.projectId;
    }
    getUserId() {
        if (!this.userId)
            throw new Error('Not authenticated yet. Call getAccessToken() first.');
        return this.userId;
    }
    async exchange() {
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
        const data = await res.json();
        this.accessToken = data.access_token;
        this.projectId = data.project_id;
        this.expiresAt = Date.now() + data.expires_in * 1000;
        // Extract user ID from JWT payload (sub claim)
        const payloadB64 = data.access_token.split('.')[1];
        const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
        this.userId = payload.sub;
    }
}
//# sourceMappingURL=auth.js.map