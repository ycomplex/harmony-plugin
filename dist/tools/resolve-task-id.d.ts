import type { SupabaseClient } from '@supabase/supabase-js';
export declare function resolveTaskId(client: SupabaseClient, projectId: string, input: string): Promise<string>;
