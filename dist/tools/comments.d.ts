import type { SupabaseClient } from '@supabase/supabase-js';
export declare const listCommentsTool: {
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
export declare function listComments(client: SupabaseClient, projectId: string, args: {
    task_id: string;
}): Promise<{
    id: any;
    content: any;
    user_id: any;
    created_at: any;
    updated_at: any;
}[]>;
export declare const addCommentTool: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: {
            task_id: {
                type: string;
                description: string;
            };
            content: {
                type: string;
                description: string;
            };
        };
        required: string[];
    };
};
export declare function addComment(client: SupabaseClient, projectId: string, userId: string, args: {
    task_id: string;
    content: string;
}): Promise<any>;
