import type { SupabaseClient } from '@supabase/supabase-js';
export interface BulkUpdateArgs {
    task_ids: string[];
    status?: string;
    priority?: string;
    assignee_id?: string | null;
    archived?: boolean;
}
export declare const bulkUpdateTasksTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_ids: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            status: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                enum: string[];
                description: string;
            };
            assignee_id: {
                type: string[];
                description: string;
            };
            archived: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function bulkUpdateTasks(client: SupabaseClient, projectId: string, args: BulkUpdateArgs): Promise<any[]>;
