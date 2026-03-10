import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from './auth.js';

const SUPABASE_URL = 'https://lhgljwwetammvsngmbic.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxoZ2xqd3dldGFtbXZzbmdtYmljIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxOTEwNDAsImV4cCI6MjA4Nzc2NzA0MH0.-UDqB58fweVwbfQMT6hUMo9nrpcj2ZfKzTvBhv2NeLc';

export async function createAuthenticatedClient(auth: HarmonyAuth): Promise<SupabaseClient> {
  const accessToken = await auth.getAccessToken();

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
