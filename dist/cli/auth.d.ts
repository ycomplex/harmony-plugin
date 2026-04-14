import type { SupabaseClient } from '@supabase/supabase-js';
import { ProjectConfig } from './config.js';
export interface AuthenticatedContext {
    client: SupabaseClient;
    projectId: string;
    userId: string;
}
export declare function getAuthenticatedContext(projectConfig?: ProjectConfig): Promise<AuthenticatedContext>;
