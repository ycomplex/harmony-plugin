import type { SupabaseClient } from '@supabase/supabase-js';
export interface QueryTasksArgs {
    status?: string;
    assignee_id?: string;
    epic_id?: string;
    cycle_id?: string;
    milestone_id?: string;
    priority?: string;
    label_ids?: string[];
    due_date_from?: string;
    due_date_to?: string;
    stale_days?: number;
    archived?: boolean;
    sort_by?: 'position' | 'due_date' | 'priority' | 'updated_at';
    limit?: number;
    offset?: number;
}
export declare const queryTasksTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            status: {
                type: string;
                description: string;
            };
            assignee_id: {
                type: string;
                description: string;
            };
            epic_id: {
                type: string;
                description: string;
            };
            cycle_id: {
                type: string;
                description: string;
            };
            milestone_id: {
                type: string;
                description: string;
            };
            priority: {
                type: string;
                enum: string[];
                description: string;
            };
            label_ids: {
                type: string;
                items: {
                    type: string;
                };
                description: string;
            };
            due_date_from: {
                type: string;
                description: string;
            };
            due_date_to: {
                type: string;
                description: string;
            };
            stale_days: {
                type: string;
                description: string;
            };
            archived: {
                type: string;
                description: string;
            };
            sort_by: {
                type: string;
                enum: string[];
                description: string;
            };
            limit: {
                type: string;
                description: string;
            };
            offset: {
                type: string;
                description: string;
            };
        };
    };
};
export declare function queryTasks(client: SupabaseClient, projectId: string, args: QueryTasksArgs): Promise<any[]>;
