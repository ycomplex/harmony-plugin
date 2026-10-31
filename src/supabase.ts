import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from './auth.js';

export async function createAuthenticatedClient(auth: HarmonyAuth): Promise<SupabaseClient> {
  // Fail fast at construction: a bad token errors loudly HERE, not on the first query.
  await auth.getAccessToken();

  // B-696: the accessToken CALLBACK (supported since supabase-js 2.x; verified in 2.98.0) is asked
  // per request, so HarmonyAuth's cache-and-re-exchange keeps a long-lived client authenticated. A
  // static `global.headers.Authorization` would freeze the JWT at construction (the daemon-zombie
  // class) — and supabase-js treats the two as mutually exclusive, so the header must be GONE.
  // B-1025: the pair comes from the auth instance, resolved for THIS call. It used to be read
  // from module-level constants captured at import, before any CLI command had run — so the
  // project's stored URL and the login flag never reached the client.
  return createClient(auth.getSupabaseUrl(), auth.getSupabaseAnonKey(), {
    accessToken: () => auth.getAccessToken(),
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
