import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listActivityTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function listActivity(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<({
    type: string;
    timestamp: any;
    user_name: any;
    event_type: any;
    field_name: any;
    old_value: any;
    new_value: any;
    metadata: any;
} | {
    type: string;
    timestamp: any;
    user_name: any;
    comment_id: any;
    content: any;
})[]>;
