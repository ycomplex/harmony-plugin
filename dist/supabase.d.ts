import { SupabaseClient } from '@supabase/supabase-js';
import { HarmonyAuth } from './auth.js';
export declare function createAuthenticatedClient(auth: HarmonyAuth): Promise<SupabaseClient>;
