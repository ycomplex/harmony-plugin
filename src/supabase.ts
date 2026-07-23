import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from './auth.js';

const SUPABASE_URL = process.env.HARMONY_SUPABASE_URL ?? 'https://eioxsunvhakmelhanmnn.supabase.co';
const SUPABASE_ANON_KEY = process.env.HARMONY_SUPABASE_ANON_KEY ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpb3hzdW52aGFrbWVsaGFubW5uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2NDY3NjksImV4cCI6MjA5MDIyMjc2OX0.SdbpfqRhcB21qWs6XnD6Lsj6AGX2b6tOGV3pg2iJjsw';

export async function createAuthenticatedClient(auth: HarmonyAuth): Promise<SupabaseClient> {
  // Fail fast at construction: a bad token errors loudly HERE, not on the first query.
  await auth.getAccessToken();

  // B-696: the accessToken CALLBACK (supported since supabase-js 2.x; verified in 2.98.0) is asked
  // per request, so HarmonyAuth's cache-and-re-exchange keeps a long-lived client authenticated. A
  // static `global.headers.Authorization` would freeze the JWT at construction (the daemon-zombie
  // class) — and supabase-js treats the two as mutually exclusive, so the header must be GONE.
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    accessToken: () => auth.getAccessToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
