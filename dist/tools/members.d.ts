import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listMembersTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {};
    };
};
export declare function listMembers(client: SupabaseClient, projectId: string): Promise<{
    user_id: any;
    display_name: any;
    email: any;
    role: any;
}[]>;
/**
 * Resolve an assignee string to a user_id UUID.
 * Accepts: UUID, display name (partial match), or email (exact match).
 * Throws if no match or multiple matches found.
 */
export declare function resolveAssignee(client: SupabaseClient, projectId: string, assignee: string): Promise<string>;
